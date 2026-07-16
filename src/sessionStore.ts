import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A Codex session, discovered from `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl`.
 * The first line of each rollout file is a `session_meta` event whose payload we read for id + cwd.
 */
export interface CodexSession {
  sessionId: string
  cwd: string | null
  lastActivity: string // ISO 8601 from filename/mtime
  filePath: string
  cliVersion?: string
  originator?: string
}

export interface ListSessionsOptions {
  /** Filter to sessions whose recorded cwd matches this path (exact string match after normalization). */
  cwd?: string
  /** Max number of most-recent sessions to return. Default 50, hard cap 500 so a busy history can't OOM. */
  limit?: number
  /** Override for the codex config root (mostly for tests). Defaults to $CODEX_HOME or ~/.codex. */
  codexHome?: string
}

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 500

/**
 * Discover Codex sessions by walking the filesystem. codex CLI writes each session to a JSONL file
 * whose first line is a `session_meta` event containing the session id and cwd; that's all we need.
 * Malformed or unreadable files are skipped so one corrupt file doesn't sink the whole listing.
 * Returns [] when the sessions dir doesn't exist yet — never throws.
 */
export const listSessions = async (options: ListSessionsOptions = {}): Promise<CodexSession[]> => {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const sessionsRoot = join(codexHome, 'sessions')
  const rawLimit = options.limit ?? DEFAULT_LIMIT
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT)

  const files = await collectRolloutFiles(sessionsRoot)
  if (files.length === 0) return []

  // Sort by filename descending (newest first — filename encodes ISO timestamp) so we only need
  // to read the first `limit` files, not every single rollout in a long-lived codex install.
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const sessions: CodexSession[] = []
  for (const filePath of files) {
    if (sessions.length >= limit) break
    const meta = await readFirstSessionMeta(filePath)
    if (!meta) continue
    if (options.cwd !== undefined && meta.cwd !== options.cwd) continue
    sessions.push(meta)
  }
  return sessions
}

const collectRolloutFiles = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // ENOENT / EACCES: this branch is unreachable, keep walking others
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

const readFirstSessionMeta = async (filePath: string): Promise<CodexSession | null> => {
  let firstLine: string
  try {
    // Sessions files are typically KB-MB; reading the whole thing is wasteful when we only need
    // the first line. Read a fixed head and split.
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      const chunk = buf.subarray(0, bytesRead).toString('utf8')
      const nl = chunk.indexOf('\n')
      firstLine = nl === -1 ? chunk : chunk.slice(0, nl)
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
  if (!firstLine.trim()) return null
  let event: unknown
  try {
    event = JSON.parse(firstLine)
  } catch {
    return null // truncated / non-JSON first line: skip
  }
  if (typeof event !== 'object' || event === null) return null
  const record = event as { type?: string; timestamp?: string; payload?: unknown }
  if (record.type !== 'session_meta' || typeof record.payload !== 'object' || record.payload === null) return null
  const p = record.payload as {
    id?: unknown
    cwd?: unknown
    timestamp?: unknown
    cli_version?: unknown
    originator?: unknown
  }
  if (typeof p.id !== 'string' || p.id.length === 0) return null
  return {
    sessionId: p.id,
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    lastActivity: typeof p.timestamp === 'string' ? p.timestamp : (record.timestamp ?? ''),
    filePath,
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : undefined,
    originator: typeof p.originator === 'string' ? p.originator : undefined,
  }
}
