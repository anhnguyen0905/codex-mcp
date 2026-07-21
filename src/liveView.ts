import { spawnSync } from 'node:child_process'
import {
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIVE_RUN_FINISHED_TYPE, type LiveRunFinishedStatus } from './progressFormatter.js'
import { escapeDoubleQuotedShell, LINUX_TERMINALS, openTerminal, type LinuxTerminal } from './terminal.js'

/** Keep at most this many run logs per workspace; older ones are pruned on each new run. */
const MAX_LOG_FILES = 20

export interface LiveView {
  onStdout: ((chunk: Buffer) => void) | undefined
  close: () => void
  logPath: string | null
}

/** Injectable dependencies for tests (optional — production callers pass nothing). */
export interface LiveViewDeps {
  openTerminalFn?: typeof openTerminal
}

/**
 * Watches the forwarded stdout stream for terminal turn events so close() can stamp the live log
 * with an end-of-run marker. Stream-derived on purpose: the sink is closed via a no-arg `close()`
 * from the server's finally block, so exit codes / abort flags are not visible here. Mapping:
 * - turn.completed → 'completed', turn.failed → 'failed' (last terminal event wins),
 * - neither seen  → 'interrupted' (abort, timeout, kill, or a stream cut mid-turn).
 */
const createStreamStateTracker = () => {
  let carry = ''
  let status: LiveRunFinishedStatus = 'interrupted'
  let sessionId: string | null = null

  const observeLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    try {
      const event: unknown = JSON.parse(trimmed)
      if (typeof event !== 'object' || event === null) return
      const { type, thread_id: threadId } = event as { type?: string; thread_id?: string }
      if (type === 'thread.started' && typeof threadId === 'string') sessionId = threadId
      if (type === 'turn.completed') status = 'completed'
      if (type === 'turn.failed') status = 'failed'
    } catch {
      // non-JSON noise in the stream — irrelevant to terminal-state tracking
    }
  }

  return {
    observe: (chunk: Buffer): void => {
      const lines = (carry + chunk.toString('utf8')).split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) observeLine(line)
    },
    /** Flush the trailing unterminated line, then build the marker JSONL line. */
    markerLine: (): string => {
      observeLine(carry)
      carry = ''
      return `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status, sessionId, at: new Date().toISOString() })}\n`
    },
  }
}

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

const writeCommandFile = (logDir: string, stamp: string, logPath: string): string | undefined => {
  if (process.platform !== 'darwin') return undefined
  try {
    const commandFile = join(logDir, `watch-${stamp}.command`)
    const dq = escapeDoubleQuotedShell
    const script = `#!/bin/zsh\nexec "${dq(process.execPath)}" "${dq(TAIL_SCRIPT)}" "${dq(logPath)}"\n`
    writeFileSync(commandFile, script, { mode: 0o755 })
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
  const { openTerminalFn = openTerminal } = deps
  try {
    // Refuse a symlinked control dir OR nested `live` dir: `mkdirSync`/writes would otherwise
    // follow it (mkdir -p does NOT fail on an existing symlink-to-dir) and drop an executable
    // `.command` + the run transcript at an attacker-chosen path outside cwd.
    const controlDir = join(cwd, '.codex-flow')
    assertNotSymlink(controlDir, '.codex-flow')
    const logDir = join(controlDir, 'live')
    assertNotSymlink(logDir, '.codex-flow/live') // pre-existing symlink at the leaf
    mkdirSync(logDir, { recursive: true })
    assertNotSymlink(logDir, '.codex-flow/live') // mkdir -p left an existing symlink in place
    pruneOldLogs(logDir, MAX_LOG_FILES)
    // Include the pid so two runs started in the same millisecond don't share (and interleave) a log file.
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    const logPath = join(logDir, `${stamp}.jsonl`)
    // 0o600: the transcript can contain file contents/secrets Codex read during the run.
    const stream: WriteStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
    // A mid-run write error (disk full, EPIPE, revoked perms) emits 'error'; without a listener
    // Node would throw it as an unhandled event and crash the whole MCP server. Swallow it and
    // stop writing — a broken live log must never fail the actual Codex run.
    let writable = true
    stream.on('error', () => {
      writable = false
    })

    const tracker = createStreamStateTracker()

    openTerminalFn(logPath, {
      platform: process.platform,
      nodeBin: process.execPath,
      tailScript: TAIL_SCRIPT,
      commandFile: writeCommandFile(logDir, stamp, logPath),
      linuxTerminal: detectLinuxTerminal(),
    })

    return {
      onStdout: (chunk: Buffer) => {
        if (!writable) return
        tracker.observe(chunk)
        stream.write(chunk)
      },
      close: () => {
        if (!writable) return
        // Explicit end-of-run marker: lets watchers (scripts/tail-progress.mjs) detect that the
        // run settled and exit instead of following the file forever.
        stream.end(tracker.markerLine())
      },
      logPath,
    }
  } catch {
    return { onStdout: undefined, close: () => {}, logPath: null }
  }
}
