import { execFile, type ExecFileException } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_MAX_PATCH_BYTES = 64 * 1024
export const DEFAULT_MAX_STATUS_BYTES = 64 * 1024
/** Per-file cap on untracked file content embedded in a run attribution (200KB). */
export const MAX_UNTRACKED_FILE_BYTES = 200 * 1024
/** How many leading bytes to sniff for a NUL when deciding a file is binary. */
const BINARY_SNIFF_BYTES = 8000
/** Sentinel hash for a path listed by git status whose content can't be read (e.g. deleted). */
const MISSING_FILE_HASH = 'missing'
const GIT_TIMEOUT_MS = 15 * 1000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export interface WorkspaceDiff {
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
}

const isMaxBufferError = (error: ExecFileException): boolean =>
  error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

const runGit = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        // A diff bigger than maxBuffer is still useful: keep the partial output and
        // let the caller's truncation flag it, instead of dropping the whole diff.
        if (error && !isMaxBufferError(error)) reject(error)
        else resolve(stdout)
      },
    )
  })

/**
 * Capture what changed in the workspace so the caller can review without re-reading files.
 * Returns null when cwd is not a git repo (or git is unavailable) — never throws.
 */
export const captureWorkspaceDiff = async (
  cwd: string,
  options: CaptureOptions = {},
): Promise<WorkspaceDiff | null> => {
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  const maxStatusBytes = options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES

  // status is the gate: if it fails, cwd isn't a usable git repo → null (unchanged contract).
  let status: string
  try {
    status = await runGit(cwd, ['status', '--porcelain'])
  } catch {
    return null
  }

  // diff is best-effort and MUST NOT sink a valid status. A fresh repo with no commits makes
  // `git diff HEAD` fail (unborn HEAD, exit 128); fall back to the worktree diff so the changes
  // Codex just made are still surfaced.
  let patch = ''
  try {
    patch = await runGit(cwd, ['diff', 'HEAD'])
  } catch {
    try {
      patch = await runGit(cwd, ['diff'])
    } catch {
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

export type SnapshotFn = (cwd: string) => Promise<WorkspaceSnapshot | null>

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

export interface RunAttribution {
  files: AttributedFile[]
  /** Content of untracked files created/modified by the run — `git diff` never shows these. */
  untracked: UntrackedFilePatch[]
}

export interface AttributeOptions {
  maxUntrackedFileBytes?: number
}

export type AttributeFn = (
  cwd: string,
  snapshot: WorkspaceSnapshot | null,
  options?: AttributeOptions,
) => Promise<RunAttribution | null>

interface StatusEntry {
  code: string
  path: string
}

/**
 * Parse `git status --porcelain -z`: NUL-separated `XY <path>` records; renames/copies emit the
 * ORIGINAL path as an extra NUL field which is skipped (the new path is what matters post-run).
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
    entries.push({ code, path: field.slice(3) })
    i += code.includes('R') || code.includes('C') ? 2 : 1
  }
  return entries
}

const listDirtyEntries = async (cwd: string): Promise<StatusEntry[]> =>
  parsePorcelainZ(await runGit(cwd, ['status', '--porcelain', '-z']))

const hashWorkspaceFile = async (cwd: string, relPath: string): Promise<string> => {
  try {
    const buf = await readFile(join(cwd, relPath))
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return MISSING_FILE_HASH
  }
}

/**
 * Capture a bounded before-run snapshot: which files are already dirty/untracked and a content
 * hash for each (hash only — content is never stored). Null when cwd is not a usable git repo.
 */
export const captureWorkspaceSnapshot: SnapshotFn = async (cwd) => {
  let entries: StatusEntry[]
  try {
    entries = await listDirtyEntries(cwd)
  } catch {
    return null
  }
  const pairs = await Promise.all(
    entries.map(async (entry) => [entry.path, await hashWorkspaceFile(cwd, entry.path)] as const),
  )
  return { fileHashes: Object.fromEntries(pairs) }
}

const isBinaryContent = (buf: Buffer): boolean => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)

const readUntrackedPatch = async (
  cwd: string,
  relPath: string,
  maxBytes: number,
): Promise<UntrackedFilePatch> => {
  let buf: Buffer
  try {
    buf = await readFile(join(cwd, relPath))
  } catch {
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
    entries = await listDirtyEntries(cwd)
  } catch {
    return null
  }
  const files = await Promise.all(
    entries.map(async (entry): Promise<AttributedFile> => {
      const currentHash = await hashWorkspaceFile(cwd, entry.path)
      const priorHash = snapshot?.fileHashes[entry.path]
      const isPreExisting = priorHash !== undefined && priorHash === currentHash
      return {
        path: entry.path,
        status: entry.code,
        attribution: isPreExisting ? 'preExisting' : 'changedByRun',
      }
    }),
  )
  const runUntracked = files.filter((f) => f.status === '??' && f.attribution === 'changedByRun')
  const untracked = await Promise.all(
    runUntracked.map((f) => readUntrackedPatch(cwd, f.path, maxUntrackedFileBytes)),
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
