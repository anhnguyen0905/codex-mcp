import { appendFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

const nowIso = (): string => new Date().toISOString()

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
      writeFileSync(filePath, renderInitialBody(req, completedAt), { mode: 0o600 })
    } else {
      appendFileSync(filePath, renderContinuationBlock(req, completedAt))
    }
  } else {
    writeFileSync(filePath, renderInitialBody(req, completedAt), { mode: 0o600 })
  }
  return filePath
}
