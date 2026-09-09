import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from './redaction.js'
import type { CodexResult } from './types.js'

/**
 * A short markdown log per session, written to `<cwd>/.codex-flow/notes/<sessionId>.md` so
 * subsequent runs can read what the prior turn did. Opt-in via `writeNotes: true` on
 * codex_execute / codex_continue / codex_review — no file is created otherwise.
 */
export interface NotesRequest {
  cwd: string
  sessionId: string
  /** User-visible prompt or focus for the header. Not the transformed codex CLI arg. */
  prompt: string
  /** Which tool the caller invoked, purely for the header label. */
  mode: 'execute' | 'continue' | 'review'
  parsed: CodexResult
  exitCode: number | null
  startedAt: string // ISO
  /** Server-generated UUID for this run, matching the tool result payload and metric entry. */
  runId?: string
}

// Session ids are UUIDs in practice, but validate to be safe: only allow chars that can't be a
// path traversal (no `/`, no `.`, no leading `-`). Anything else → refuse to write.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Refuse a symlinked control dir so we never mkdir/write through a planted symlink. */
const assertNotSymlink = (path: string, label: string): void => {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} is a symlink — refusing to write notes through it`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('refusing')) throw err
    // ENOENT: fine, will be created.
  }
}

// Notes may embed transcript content (possibly secrets) — owner read/write only.
const NOTES_FILE_MODE = 0o600

/**
 * Create/overwrite the notes file atomically without following a planted symlink: write to a
 * temp file in the same directory, then rename over the target. rename replaces the link itself
 * (never its target), and readers never observe a half-written note.
 */
const writeFileAtomic = (filePath: string, content: string): void => {
  const tmpPath = `${filePath}.tmp-${randomBytes(8).toString('hex')}`
  writeFileSync(tmpPath, content, { mode: NOTES_FILE_MODE })
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/**
 * Append through a single `openSync`, so the symlink check and the write cannot be raced: with
 * `O_NOFOLLOW` the kernel refuses a symlinked leaf at open time, and every subsequent write goes
 * to that same fd — nothing can swap the path in between (TOCTOU). `O_CREAT` keeps the call
 * working when the file raced away after the existence probe.
 *
 * IMP-52: on platforms whose Node build does not define `O_NOFOLLOW` (notably Windows) the flag
 * cannot be requested, so the open is verified after the fact instead: the leaf is `lstat`ed
 * before the open and the fd is `fstat`ed after it, and the write only happens when both report
 * the same regular file (`dev`/`ino`). Opening a symlink resolves to its target, whose inode
 * differs from the link's — so a swap, a symlink, or a vanished leaf all refuse the write
 * (fail closed) rather than appending through the wrong path.
 */
interface FileIdentity {
  dev: number
  ino: number
}

/** The leaf's identity before the open, or undefined when it is a symlink / cannot be stat'ed. */
const regularFileIdentity = (filePath: string): FileIdentity | undefined => {
  try {
    const stats = lstatSync(filePath)
    if (!stats.isFile()) return undefined
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

const appendViaFd = (filePath: string, label: string, content: string): void => {
  const hasNoFollow = typeof fsConstants.O_NOFOLLOW === 'number'
  const noFollow = hasNoFollow ? fsConstants.O_NOFOLLOW : 0
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow
  const refuse = (): never => {
    throw new Error(`${label} is a symlink or was swapped — refusing to write notes through it`)
  }
  // Captured before the open so the post-open fstat has something to compare against.
  const before = hasNoFollow ? undefined : regularFileIdentity(filePath)
  if (!hasNoFollow && before === undefined) refuse()
  let fd: number
  try {
    fd = openSync(filePath, flags, NOTES_FILE_MODE)
  } catch (error: unknown) {
    // O_NOFOLLOW reports a symlinked leaf as ELOOP (some platforms use EMLINK).
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new Error(`${label} is a symlink — refusing to write notes through it`)
    }
    throw error
  }
  try {
    if (before !== undefined) {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) refuse()
    }
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
}

const nowIso = (): string => new Date().toISOString()

/**
 * The only text that reaches the notes file goes through here (R5.2). Notes embed the agent
 * message, the commands Codex ran and the prompt, any of which can carry a credential, and the
 * file outlives the run — so redaction happens once, at the write boundary, rather than at each
 * of the renderers.
 */
const redactedForNotes = (content: string): string => redactSecrets(content).text

const renderChanges = (parsed: CodexResult): string => {
  if (parsed.fileChanges.length === 0) return '_none_'
  return parsed.fileChanges.map((c) => `- ${c.path} (${c.kind})`).join('\n')
}

const renderCommands = (parsed: CodexResult): string => {
  if (parsed.commands.length === 0) return '_none_'
  return parsed.commands.map((c) => `- \`${c.command}\` (exit ${c.exitCode ?? '?'})`).join('\n')
}

const promptFirstLine = (prompt: string): string => {
  const line = prompt.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '(empty)'
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

const renderInitialBody = (req: NotesRequest, completedAt: string): string =>
  [
    `# Session ${req.sessionId}`,
    ``,
    `- Mode: ${req.mode}`,
    `- Cwd: ${req.cwd}`,
    `- Started: ${req.startedAt}`,
    `- Completed: ${completedAt}`,
    `- Exit: ${req.exitCode ?? 'null'}`,
    ...(req.runId ? [`- Run: ${req.runId}`] : []),
    `- Task: ${promptFirstLine(req.prompt)}`,
    ``,
    `## Summary`,
    ``,
    req.parsed.agentMessage ?? '_no agent message_',
    ``,
    `## Files touched`,
    ``,
    renderChanges(req.parsed),
    ``,
    `## Commands run`,
    ``,
    renderCommands(req.parsed),
    ``,
  ].join('\n')

const renderContinuationBlock = (req: NotesRequest, completedAt: string): string =>
  [
    ``,
    `## Continuation @ ${completedAt} (${req.mode})`,
    ``,
    `- Task: ${promptFirstLine(req.prompt)}`,
    `- Exit: ${req.exitCode ?? 'null'}`,
    ...(req.runId ? [`- Run: ${req.runId}`] : []),
    ``,
    req.parsed.agentMessage ?? '_no agent message_',
    ``,
    `### Files touched`,
    ``,
    renderChanges(req.parsed),
    ``,
    `### Commands run`,
    ``,
    renderCommands(req.parsed),
    ``,
  ].join('\n')

/**
 * Write (execute/review) or append (continue) a note for this session. Best-effort — throws only
 * on symlink refusal; other errors are the caller's to log. Returns the path written to, or null
 * if writing was skipped (e.g. no sessionId, unsafe id).
 */
export const writeNotes = (req: NotesRequest): string | null => {
  if (!SAFE_SESSION_ID.test(req.sessionId)) return null
  const controlDir = join(req.cwd, '.codex-flow')
  assertNotSymlink(controlDir, '.codex-flow')
  const notesDir = join(controlDir, 'notes')
  assertNotSymlink(notesDir, '.codex-flow/notes')
  mkdirSync(notesDir, { recursive: true })
  assertNotSymlink(notesDir, '.codex-flow/notes')
  const filePath = join(notesDir, `${req.sessionId}.md`)
  // writeFileSync/appendFileSync follow symlinks: a planted leaf link would redirect the write
  // (or truncate a file) outside the workspace. Refuse it before touching the path.
  assertNotSymlink(filePath, `.codex-flow/notes/${req.sessionId}.md`)
  const completedAt = nowIso()

  if (req.mode === 'continue') {
    // If the notes file doesn't exist yet, seed it with a header block so continuations still
    // read cleanly instead of dangling under nothing.
    let exists = true
    try {
      lstatSync(filePath)
    } catch {
      exists = false
    }
    if (!exists) {
      writeFileAtomic(filePath, redactedForNotes(renderInitialBody(req, completedAt)))
    } else {
      // Re-checks the symlink condition atomically at open time — the lstat above can be raced.
      appendViaFd(
        filePath,
        `.codex-flow/notes/${req.sessionId}.md`,
        redactedForNotes(renderContinuationBlock(req, completedAt)),
      )
    }
  } else {
    writeFileAtomic(filePath, redactedForNotes(renderInitialBody(req, completedAt)))
  }
  return filePath
}
