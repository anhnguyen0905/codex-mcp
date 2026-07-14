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
import { escapeDoubleQuotedShell, LINUX_TERMINALS, openTerminal, type LinuxTerminal } from './terminal.js'

/** Keep at most this many run logs per workspace; older ones are pruned on each new run. */
const MAX_LOG_FILES = 20

export interface LiveView {
  onStdout: ((chunk: Buffer) => void) | undefined
  close: () => void
  logPath: string | null
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
const detectLinuxTerminal = (): LinuxTerminal | undefined => {
  if (process.platform !== 'linux') return undefined
  for (const terminal of LINUX_TERMINALS) {
    const found = spawnSync('command', ['-v', terminal.command], { shell: true })
    if (found.status === 0) return terminal
  }
  return undefined
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
export const createLiveView = (cwd: string): LiveView => {
  try {
    // Refuse a symlinked control dir: `mkdirSync`/writes would otherwise follow it and drop an
    // executable `.command` + the run transcript at an attacker-chosen path outside cwd.
    const controlDir = join(cwd, '.codex-flow')
    try {
      if (lstatSync(controlDir).isSymbolicLink()) {
        throw new Error('.codex-flow is a symlink — refusing to write live logs through it')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('refusing')) throw err
      // ENOENT (doesn't exist yet) is fine — fall through and create it.
    }
    const logDir = join(controlDir, 'live')
    mkdirSync(logDir, { recursive: true })
    pruneOldLogs(logDir, MAX_LOG_FILES)
    // Include the pid so two runs started in the same millisecond don't share (and interleave) a log file.
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    const logPath = join(logDir, `${stamp}.jsonl`)
    const stream: WriteStream = createWriteStream(logPath, { flags: 'a' })
    // A mid-run write error (disk full, EPIPE, revoked perms) emits 'error'; without a listener
    // Node would throw it as an unhandled event and crash the whole MCP server. Swallow it and
    // stop writing — a broken live log must never fail the actual Codex run.
    let writable = true
    stream.on('error', () => {
      writable = false
    })

    openTerminal(logPath, {
      platform: process.platform,
      nodeBin: process.execPath,
      tailScript: TAIL_SCRIPT,
      commandFile: writeCommandFile(logDir, stamp, logPath),
      linuxTerminal: detectLinuxTerminal(),
    })

    return {
      onStdout: (chunk: Buffer) => {
        if (writable) stream.write(chunk)
      },
      close: () => {
        if (writable) stream.end()
      },
      logPath,
    }
  } catch {
    return { onStdout: undefined, close: () => {}, logPath: null }
  }
}
