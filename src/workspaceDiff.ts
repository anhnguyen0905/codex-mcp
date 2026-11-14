import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PostRunAvailability } from './types.js'

export const DEFAULT_MAX_PATCH_BYTES = 64 * 1024
export const DEFAULT_MAX_STATUS_BYTES = 64 * 1024
/** Per-file cap on untracked file content embedded in a run attribution (200KB). */
export const MAX_UNTRACKED_FILE_BYTES = 200 * 1024
/** How many leading bytes to sniff for a NUL when deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8000
/** Sentinel hash for a path listed by git status whose content can't be read (e.g. deleted). */
const MISSING_FILE_HASH = 'missing'
const GIT_TIMEOUT_MS = 15 * 1000
const GIT_KILL_GRACE_MS = 250
const GIT_MAX_BUFFER = 16 * 1024 * 1024
export const HASH_CONCURRENCY = 8

export interface WorkspaceDiff extends PostRunAvailability {
  /** `git status --porcelain` output: one line per changed/untracked file. */
  status: string
  /** True when `status` was cut to fit maxStatusBytes. */
  statusTruncated: boolean
  /** Unified diff of tracked changes vs HEAD, possibly truncated. */
  patch: string
  truncated: boolean
}

export type DiffFn = (cwd: string) => Promise<WorkspaceDiff | null>

export interface CaptureOptions {
  maxPatchBytes?: number
  maxStatusBytes?: number
  /** Post-run porcelain status shared with attribution to avoid a duplicate git invocation. */
  statusPorcelainZ?: Promise<string>
  signal?: AbortSignal
}

const isMaxBufferError = (error: ExecFileException): boolean =>
  error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

const abortError = (): Error => new Error('workspace capture aborted')

const awaitWithAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) throw abortError()
  let onAbort = (): void => {}
  const aborted = new Promise<T>((_, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> => {
  const results: R[] = []
  let nextIndex = 0
  const runWorker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw abortError()
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  const workerCount = Math.min(HASH_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  if (signal?.aborted) throw abortError()
  return results
}

interface RunGitOptions {
  signal?: AbortSignal
  command?: string
  timeoutMs?: number
}

const killChildGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The group may already have exited; direct kill preserves Windows and fallback behavior.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The child may have exited between the group and direct kill attempts.
  }
}

export const runGit = (
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('git command aborted'))
      return
    }

    let child: ChildProcess
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
    const finish = (error: Error | null, stdout = ''): void => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(stdout)
    }
    const terminate = (reason: string): void => {
      killChildGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        killChildGroup(child, 'SIGKILL')
        finish(new Error(reason))
      }, GIT_KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const onAbort = (): void => terminate('git command aborted')
    try {
      const execOptions = {
        cwd,
        detached: process.platform !== 'win32',
        maxBuffer: GIT_MAX_BUFFER,
        encoding: 'utf8',
      } as Parameters<typeof execFile>[2] & { detached: boolean }
      child = execFile(
        options.command ?? 'git',
        [...args],
        execOptions,
        (error: ExecFileException | null, stdout: string | Buffer, _stderr: string | Buffer) => {
          if (error && !isMaxBufferError(error)) finish(error)
          else finish(null, typeof stdout === 'string' ? stdout : stdout.toString('utf8'))
        },
      )
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    timeoutTimer = setTimeout(() => terminate('git command timed out'), timeoutMs)
    timeoutTimer.unref?.()
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Start a porcelain status read that diff and attribution can share within one run attempt. */
export const captureStatusPorcelainZ = (cwd: string, signal?: AbortSignal): Promise<string> =>
  runGit(cwd, ['status', '--porcelain', '-z'], { signal })

/**
 * Capture what changed in the workspace so the caller can review without re-reading files.
 * Returns null when cwd is not a git repo (or git is unavailable) — never throws.
 */
export const captureWorkspaceDiff = async (
  cwd: string,
  options: CaptureOptions = {},
): Promise<WorkspaceDiff | null> => {
  if (options.signal?.aborted) return null
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  const maxStatusBytes = options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES

  // status is the gate: if it fails, cwd isn't a usable git repo → null (unchanged contract).
  let status: string
  try {
    const statusPorcelainZ = options.statusPorcelainZ
    status = statusPorcelainZ
      ? formatPorcelainZ(await awaitWithAbort(statusPorcelainZ, options.signal))
      : await runGit(cwd, ['status', '--porcelain'], { signal: options.signal })
  } catch {
    if (options.signal?.aborted) return null
    return null
  }

  // diff is best-effort and MUST NOT sink a valid status. A fresh repo with no commits makes
  // `git diff HEAD` fail (unborn HEAD, exit 128); fall back to the worktree diff so the changes
  // Codex just made are still surfaced.
  let patch = ''
  try {
    patch = await runGit(cwd, ['diff', 'HEAD'], { signal: options.signal })
  } catch {
    if (options.signal?.aborted) return null
    try {
      patch = await runGit(cwd, ['diff'], { signal: options.signal })
    } catch {
      if (options.signal?.aborted) return null
      patch = ''
    }
  }

  const trimmedStatus = status.trimEnd()
  const s = truncateToBytes(trimmedStatus, maxStatusBytes)
  const p = truncateToBytes(patch, maxPatchBytes)
  return {
    status: s.text,
    statusTruncated: s.truncated,
    patch: p.text,
    truncated: p.truncated,
  }
}

/** Content hash per dirty/untracked file, captured BEFORE a run to attribute changes after it. */
export interface WorkspaceSnapshot {
  /** Relative path → sha256 hex of file content ('missing' when unreadable, e.g. deleted). */
  fileHashes: Readonly<Record<string, string>>
}

export type SnapshotFn = (cwd: string, signal?: AbortSignal) => Promise<WorkspaceSnapshot | null>

export interface AttributedFile {
  path: string
  /** Two-letter porcelain XY code reported post-run (e.g. ' M', '??'). */
  status: string
  attribution: 'changedByRun' | 'preExisting'
}

export interface UntrackedFilePatch {
  path: string
  /** File content (bounded); null for binary or unreadable files. */
  content: string | null
  truncated: boolean
  binary: boolean
}

export interface RunAttribution extends PostRunAvailability {
  files: AttributedFile[]
  /** Content of untracked files created/modified by the run — `git diff` never shows these. */
  untracked: UntrackedFilePatch[]
}

export interface AttributeOptions {
  maxUntrackedFileBytes?: number
  /** Post-run porcelain status shared with diff to avoid a duplicate git invocation. */
  statusPorcelainZ?: Promise<string>
  signal?: AbortSignal
}

export type AttributeFn = (
  cwd: string,
  snapshot: WorkspaceSnapshot | null,
  options?: AttributeOptions,
) => Promise<RunAttribution | null>

interface StatusEntry {
  code: string
  path: string
  originalPath?: string
}

/**
 * Parse `git status --porcelain -z`: NUL-separated `XY <path>` records; renames/copies emit the
 * ORIGINAL path as an extra NUL field, retained so non-z status can render `ORIGINAL -> NEW`.
 */
const parsePorcelainZ = (raw: string): StatusEntry[] => {
  const fields = raw.split('\0').filter((field) => field.length > 0)
  const entries: StatusEntry[] = []
  let i = 0
  while (i < fields.length) {
    const field = fields[i]
    if (field.length < 4) {
      i += 1
      continue // malformed record — skip defensively
    }
    const code = field.slice(0, 2)
    const renamedOrCopied = code.includes('R') || code.includes('C')
    entries.push({
      code,
      path: field.slice(3),
      originalPath: renamedOrCopied ? fields[i + 1] : undefined,
    })
    i += renamedOrCopied ? 2 : 1
  }
  return entries
}

const needsPorcelainQuoting = (byte: number): boolean =>
  byte === 0x22 || byte === 0x5c || byte < 0x20 || byte === 0x7f || byte > 0x7f

/** Match Git's C-style path quoting with the default `core.quotePath=true`. */
const quotePorcelainPath = (path: string): string => {
  const bytes = Buffer.from(path, 'utf8')
  if (!bytes.some(needsPorcelainQuoting)) return path

  let quoted = '"'
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"'
    else if (byte === 0x5c) quoted += '\\\\'
    else if (byte === 0x09) quoted += '\\t'
    else if (byte === 0x0a) quoted += '\\n'
    else if (byte === 0x0d) quoted += '\\r'
    else if (byte < 0x20 || byte === 0x7f || byte > 0x7f) {
      quoted += `\\${byte.toString(8).padStart(3, '0')}`
    } else quoted += String.fromCharCode(byte)
  }
  return `${quoted}"`
}

const formatPorcelainZ = (raw: string): string =>
  parsePorcelainZ(raw)
    .map((entry) =>
      entry.originalPath === undefined
        ? `${entry.code} ${quotePorcelainPath(entry.path)}`
        : `${entry.code} ${quotePorcelainPath(entry.originalPath)} -> ${quotePorcelainPath(entry.path)}`,
    )
    .join('\n')

const listDirtyEntries = async (
  cwd: string,
  statusPorcelainZ?: Promise<string>,
  signal?: AbortSignal,
): Promise<StatusEntry[]> =>
  parsePorcelainZ(await awaitWithAbort(statusPorcelainZ ?? captureStatusPorcelainZ(cwd, signal), signal))

const hashWorkspaceFile = async (
  cwd: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (signal?.aborted) throw abortError()
  try {
    const buf = await readFile(join(cwd, relPath), { signal })
    return createHash('sha256').update(buf).digest('hex')
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    return MISSING_FILE_HASH
  }
}

/**
 * Capture a bounded before-run snapshot: which files are already dirty/untracked and a content
 * hash for each (hash only — content is never stored). Null when cwd is not a usable git repo.
 */
export const captureWorkspaceSnapshot: SnapshotFn = async (cwd, signal) => {
  if (signal?.aborted) return null
  let entries: StatusEntry[]
  try {
    entries = await listDirtyEntries(cwd, undefined, signal)
  } catch {
    return null
  }
  const pairs = await mapWithConcurrency(
    entries,
    async (entry): Promise<readonly [string, string]> => [
      entry.path,
      await hashWorkspaceFile(cwd, entry.path, signal),
    ],
    signal,
  )
  return { fileHashes: Object.fromEntries(pairs) }
}

const isBinaryContent = (buf: Buffer): boolean => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)

const readUntrackedPatch = async (
  cwd: string,
  relPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<UntrackedFilePatch> => {
  if (signal?.aborted) throw abortError()
  let buf: Buffer
  try {
    buf = await readFile(join(cwd, relPath), { signal })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    return { path: relPath, content: null, truncated: false, binary: false }
  }
  if (isBinaryContent(buf)) return { path: relPath, content: null, truncated: false, binary: true }
  const bounded = truncateToBytes(buf.toString('utf8'), maxBytes)
  return { path: relPath, content: bounded.text, truncated: bounded.truncated, binary: false }
}

/**
 * Classify each post-run dirty file against the before-run snapshot: a file that was already
 * dirty with the same content hash is `preExisting`; anything new or with a different hash is
 * `changedByRun`. Untracked files attributed to the run also carry their (bounded) content.
 * Null when cwd is not a usable git repo — never throws.
 */
export const attributeWorkspaceDiff: AttributeFn = async (cwd, snapshot, options = {}) => {
  const maxUntrackedFileBytes = options.maxUntrackedFileBytes ?? MAX_UNTRACKED_FILE_BYTES
  let entries: StatusEntry[]
  try {
    entries = await listDirtyEntries(cwd, options.statusPorcelainZ, options.signal)
  } catch {
    return null
  }
  const files = await mapWithConcurrency(
    entries,
    async (entry): Promise<AttributedFile> => {
      const currentHash = await hashWorkspaceFile(cwd, entry.path, options.signal)
      const priorHash = snapshot?.fileHashes[entry.path]
      const isPreExisting = priorHash !== undefined && priorHash === currentHash
      return {
        path: entry.path,
        status: entry.code,
        attribution: isPreExisting ? 'preExisting' : 'changedByRun',
      }
    },
    options.signal,
  )
  const runUntracked = files.filter((f) => f.status === '??' && f.attribution === 'changedByRun')
  const untracked = await mapWithConcurrency(
    runUntracked,
    (file) => readUntrackedPatch(cwd, file.path, maxUntrackedFileBytes, options.signal),
    options.signal,
  )
  return { files, untracked }
}

/**
 * True when `ref` resolves to a commit in this repo. Rejects refs starting with `-` outright so
 * a hostile value can never be parsed as a git flag.
 */
export const verifyGitRef = async (cwd: string, ref: string): Promise<boolean> => {
  if (ref.startsWith('-')) return false
  try {
    await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * Truncate to a real UTF-8 byte budget (not UTF-16 code-unit `.length`, which under-counts multibyte
 * and let the payload grow up to ~3x), dropping any trailing partial codepoint left by the byte cut.
 */
const truncateToBytes = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= maxBytes) return { text: value, truncated: false }
  let text = buf.subarray(0, maxBytes).toString('utf8')
  if (text.endsWith('�')) text = text.slice(0, -1) // strip a split multibyte tail
  return { text, truncated: true }
}
