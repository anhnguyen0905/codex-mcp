import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { isBenignCliNotice } from './eventParser.js'
import { LIVE_RUN_FINISHED_TYPE, type LiveRunFinishedStatus } from './progressFormatter.js'
import { redactJsonLine } from './redaction.js'
import { escapeDoubleQuotedShell, LINUX_TERMINALS, openTerminal, type LinuxTerminal } from './terminal.js'
import { buildWatcherEnvExports, type TerminalCloseEnv } from './terminalCloser.js'
import { canonicalCwd } from './workspaceLease.js'

/** Keep at most this many run logs per workspace; older ones are pruned on each new run. */
const MAX_LOG_FILES = 20
const MAX_CARRY_BYTES = 1024 * 1024
const MAX_STAMP_ATTEMPTS = 5
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_LOG_MODE = 0o600

export interface LiveView {
  onStdout: ((chunk: Buffer) => void) | undefined
  close: () => void
  logPath: string | null
}

/** Injectable dependencies for tests (optional — production callers pass nothing). */
export interface LiveViewDeps {
  env?: TerminalCloseEnv
  openTerminalFn?: typeof openTerminal
  liveRoot?: string
  createWriteStreamFn?: typeof createWriteStream
  now?: () => Date
  realpathSyncFn?: typeof realpathSync
}

export const defaultLiveRoot = (): string =>
  process.env.CODEX_MCP_LIVE_DIR ?? join(homedir(), '.codex-mcp', 'live')

export const liveDirFor = (cwd: string, root: string = defaultLiveRoot()): string => {
  const canonical = canonicalCwd(cwd)
  const slug = basename(canonical).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'workspace'
  const hash12 = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return join(root, `${slug}-${hash12}`)
}

/**
 * Watches the forwarded stdout stream for terminal turn events so close() can stamp the live log
 * with an end-of-run marker. Stream-derived on purpose: the sink is closed via a no-arg `close()`
 * from the server's finally block, so exit codes / abort flags are not visible here. Mapping:
 * - turn.completed or a benign-notice turn.failed → 'completed',
 * - any other turn.failed → 'failed' (last terminal event wins),
 * - neither seen  → 'interrupted' (abort, timeout, kill, or a stream cut mid-turn).
 */
const createStreamStateTracker = () => {
  let status: LiveRunFinishedStatus = 'interrupted'
  let sessionId: string | null = null

  const observeLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    try {
      const event: unknown = JSON.parse(trimmed)
      if (typeof event !== 'object' || event === null) return
      const { type, thread_id: threadId, error } = event as {
        type?: string
        thread_id?: string
        error?: { message?: string }
      }
      if (type === 'thread.started' && typeof threadId === 'string') sessionId = threadId
      if (type === 'turn.completed') status = 'completed'
      if (type === 'turn.failed') {
        status = isBenignCliNotice(error?.message ?? 'turn failed') ? 'completed' : 'failed'
      }
    } catch {
      // non-JSON noise in the stream — irrelevant to terminal-state tracking
    }
  }

  return {
    observeLine,
    markerLine: (): string =>
      JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status, sessionId, at: new Date().toISOString() }),
  }
}

/** Add one receipt timestamp to a JSON object line; preserve non-object or malformed input. */
const stampEventLine = (line: string): string => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return line

  try {
    const event: unknown = JSON.parse(trimmed)
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return line
    return JSON.stringify({ ...event, at: new Date().toISOString() })
  } catch {
    return line
  }
}

/**
 * The single sink for the live log (R5.2): redact the line and terminate it. `redactJsonLine`
 * parses and re-serializes a JSON line, so a redacted event stays valid JSON and
 * `scripts/tail-progress.mjs` still parses it; a non-JSON line falls back to text redaction and is
 * written through otherwise unchanged.
 */
const toLogLine = (line: string): string => `${redactJsonLine(line).line}\n`

const HERE = dirname(fileURLToPath(import.meta.url))
const TAIL_SCRIPT = join(HERE, '..', 'scripts', 'tail-progress.mjs')

/**
 * On macOS, write an executable `.command` wrapper so the terminal can be opened via
 * `open -a Terminal` (LaunchServices) instead of `osascript` (Apple Events) — the latter is
 * silently blocked when the MCP server lacks Automation (TCC) permission. Returns the file path,
 * or undefined on other platforms / on failure (the launcher then falls back to osascript).
 */
/**
 * Pick the first installed Linux terminal emulator (via `command -v`). Returns undefined on
 * non-Linux platforms or when none is found (headless / SSH), in which case no window opens and
 * the caller relies on the `liveLog` file plus in-session MCP progress notifications.
 */
let cachedLinuxTerminal: LinuxTerminal | undefined | false = false // false = not yet detected
const detectLinuxTerminal = (): LinuxTerminal | undefined => {
  if (process.platform !== 'linux') return undefined
  if (cachedLinuxTerminal !== false) return cachedLinuxTerminal
  for (const terminal of LINUX_TERMINALS) {
    // timeout so a hung `command -v` can't block the event loop; detection is cached across runs.
    const found = spawnSync('command', ['-v', terminal.command], { shell: true, timeout: 1000 })
    if (found.status === 0) {
      cachedLinuxTerminal = terminal
      return terminal
    }
  }
  cachedLinuxTerminal = undefined
  return undefined
}

/** Throw if `path` exists and is a symlink — we must never mkdir/write through a planted symlink. */
const assertNotSymlink = (path: string, label: string): void => {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} is a symlink — refusing to write live logs through it`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('refusing')) throw err
    // ENOENT (doesn't exist yet) is fine — fall through.
  }
}

const ensurePrivateLiveDir = (
  liveRoot: string,
  logDir: string,
  realpathSyncFn: typeof realpathSync,
): void => {
  assertNotSymlink(liveRoot, 'live root')
  assertNotSymlink(logDir, 'live workspace directory')
  mkdirSync(logDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  if (process.platform !== 'win32') chmodSync(logDir, PRIVATE_DIR_MODE)
  assertNotSymlink(logDir, 'live workspace directory')

  const resolvedRoot = realpathSyncFn(liveRoot)
  const resolvedDir = realpathSyncFn(logDir)
  const expectedDir = join(resolvedRoot, basename(logDir))
  if (resolvedDir !== expectedDir) {
    throw new Error('live workspace directory resolved outside live root')
  }
}

interface OpenedLiveLog {
  fd: number
  logPath: string
  stamp: string
}

const openExclusiveLog = (logDir: string, stamp: string): OpenedLiveLog => {
  const noFollow = process.platform !== 'win32' ? (constants.O_NOFOLLOW ?? 0) : 0
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | noFollow
  for (let attempt = 0; attempt < MAX_STAMP_ATTEMPTS; attempt += 1) {
    const finalStamp = attempt === 0 ? stamp : `${stamp}-${attempt}`
    const logPath = join(logDir, `${finalStamp}.jsonl`)
    try {
      const fd = openSync(logPath, flags, PRIVATE_LOG_MODE)
      return { fd, logPath, stamp: finalStamp }
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique live log path')
}

const createLiveLogStream = (
  logDir: string,
  stamp: string,
  createWriteStreamFn: typeof createWriteStream,
): OpenedLiveLog & { stream: WriteStream } => {
  const openedLog = openExclusiveLog(logDir, stamp)
  try {
    const stream = createWriteStreamFn(openedLog.logPath, {
      fd: openedLog.fd,
      flags: 'a',
      mode: PRIVATE_LOG_MODE,
    })
    return { ...openedLog, stream }
  } catch (error: unknown) {
    closeSync(openedLog.fd)
    throw error
  }
}

/**
 * Best-effort log rotation: keep only the newest MAX_LOG_FILES entries in the live dir so
 * per-run `.jsonl`/`.command` files don't accumulate unbounded over a workspace's lifetime.
 */
const pruneOldLogs = (logDir: string, keep: number): void => {
  try {
    const entries = readdirSync(logDir)
      .filter((name) => name.endsWith('.jsonl') || name.endsWith('.command'))
      .map((name) => {
        const full = join(logDir, name)
        try {
          return { full, mtime: statSync(full).mtimeMs }
        } catch {
          return { full, mtime: 0 }
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const { full } of entries.slice(keep)) {
      try {
        unlinkSync(full)
      } catch {
        // best-effort — a file we can't remove must not fail the run
      }
    }
  } catch {
    // dir unreadable — nothing to prune
  }
}

const writeCommandFile = (
  logDir: string,
  stamp: string,
  logPath: string,
  env: TerminalCloseEnv,
): string | undefined => {
  if (process.platform !== 'darwin') return undefined
  try {
    const commandFile = join(logDir, `watch-${stamp}.command`)
    const dq = escapeDoubleQuotedShell
    // This fixed shell expression must expand inside the newly opened window; only the
    // interpolated paths belong behind the double-quoted shell escaper.
    const watcherEnvExports = buildWatcherEnvExports(env)
    const configLines = watcherEnvExports.length > 0 ? `${watcherEnvExports}\n` : ''
    const script = `#!/bin/zsh\nexport CODEX_MCP_TERMINAL_TTY="$(tty)"\n${configLines}exec "${dq(process.execPath)}" "${dq(TAIL_SCRIPT)}" "${dq(logPath)}" ${process.pid}\n`
    writeFileSync(commandFile, script, { flag: 'wx', mode: 0o755 })
    return commandFile
  } catch {
    return undefined
  }
}

/**
 * Create a live progress view: streams Codex's raw JSONL stdout to a per-run log file and
 * (on macOS) opens a Terminal window that pretty-tails it. Best-effort — failures degrade to
 * a no-op sink so a broken viewer never fails the actual Codex run.
 */
export const createLiveView = (cwd: string, deps: LiveViewDeps = {}): LiveView => {
  const {
    env = process.env,
    openTerminalFn = openTerminal,
    liveRoot = defaultLiveRoot(),
    createWriteStreamFn = createWriteStream,
    now = () => new Date(),
    realpathSyncFn = realpathSync,
  } = deps
  try {
    const logDir = liveDirFor(cwd, liveRoot)
    ensurePrivateLiveDir(liveRoot, logDir, realpathSyncFn)
    pruneOldLogs(logDir, MAX_LOG_FILES)
    // Include the pid so two runs started in the same millisecond don't share (and interleave) a log file.
    const stamp = `${now().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    const openedLog = createLiveLogStream(logDir, stamp, createWriteStreamFn)
    const { logPath, stream, stamp: finalStamp } = openedLog
    // A mid-run write error (disk full, EPIPE, revoked perms) emits 'error'; without a listener
    // Node would throw it as an unhandled event and crash the whole MCP server. Swallow it and
    // stop writing — a broken live log must never fail the actual Codex run.
    let streamFailed = false
    let streamFinished = false
    let isClosed = false
    let fallbackMarkerWritten = false
    let markerLine: string | undefined
    let isEnding = false

    const appendFallbackMarker = (): void => {
      if (fallbackMarkerWritten || streamFinished || markerLine === undefined) return
      fallbackMarkerWritten = true
      try {
        appendFileSync(logPath, toLogLine(markerLine), { mode: 0o600 })
      } catch {
        // The live view is best-effort; a failed fallback must not fail the Codex run.
      }
    }

    stream.on('error', () => {
      streamFailed = true
      if (isEnding) appendFallbackMarker()
    })
    stream.on('finish', () => {
      streamFinished = true
    })

    const tracker = createStreamStateTracker()
    const decoder = new StringDecoder('utf8')
    let carry = ''
    let carryBytes = 0

    const resetCarry = (): void => {
      carry = ''
      carryBytes = 0
    }

    const writeRawCarry = (): void => {
      if (carry.length === 0) return
      tracker.observeLine(carry)
      writeToStream(toLogLine(carry))
      resetCarry()
    }

    const writeToStream = (line: string): void => {
      if (streamFailed) return
      try {
        stream.write(line)
      } catch {
        streamFailed = true
        // The live view is best-effort; a broken stream must not fail the Codex run.
      }
    }

    const appendCarry = (text: string): void => {
      if (text.length === 0) return
      carry += text
      carryBytes += Buffer.byteLength(text)
      if (carryBytes > MAX_CARRY_BYTES) writeRawCarry()
    }

    const writeCompleteLines = (text: string): void => {
      const lines = text.split('\n')
      if (lines.length === 1) {
        appendCarry(text)
        return
      }

      const firstLine = carry + (lines[0] ?? '')
      resetCarry()
      tracker.observeLine(firstLine)
      writeToStream(toLogLine(stampEventLine(firstLine)))
      for (const line of lines.slice(1, -1)) {
        tracker.observeLine(line)
        writeToStream(toLogLine(stampEventLine(line)))
      }
      appendCarry(lines[lines.length - 1] ?? '')
    }

    openTerminalFn(logPath, {
      platform: process.platform,
      nodeBin: process.execPath,
      tailScript: TAIL_SCRIPT,
      commandFile: writeCommandFile(logDir, finalStamp, logPath, env),
      linuxTerminal: detectLinuxTerminal(),
      writerPid: process.pid,
      env,
    })

    return {
      onStdout: (chunk: Buffer) => {
        if (isClosed) return
        writeCompleteLines(decoder.write(chunk))
      },
      close: () => {
        if (isClosed) return
        isClosed = true
        appendCarry(decoder.end())
        if (carry.length > 0) {
          tracker.observeLine(carry)
          writeToStream(toLogLine(stampEventLine(carry)))
          resetCarry()
        }
        // Explicit end-of-run marker: lets watchers (scripts/tail-progress.mjs) detect that the
        // run settled and exit instead of following the file forever.
        markerLine = tracker.markerLine()
        if (streamFailed) {
          appendFallbackMarker()
          return
        }
        isEnding = true
        try {
          stream.end(toLogLine(markerLine))
        } catch {
          streamFailed = true
          appendFallbackMarker()
        }
      },
      logPath,
    }
  } catch {
    // The live view is best-effort; setup failures must never fail the Codex run.
    return { onStdout: undefined, close: () => {}, logPath: null }
  }
}
