import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTerminal } from './terminal.js'

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
const writeCommandFile = (logDir: string, stamp: string, logPath: string): string | undefined => {
  if (process.platform !== 'darwin') return undefined
  try {
    const commandFile = join(logDir, `watch-${stamp}.command`)
    const script = `#!/bin/zsh\nexec "${process.execPath}" "${TAIL_SCRIPT}" "${logPath}"\n`
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
    const logDir = join(cwd, '.codex-flow', 'live')
    mkdirSync(logDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = join(logDir, `${stamp}.jsonl`)
    const stream: WriteStream = createWriteStream(logPath, { flags: 'a' })

    openTerminal(logPath, {
      platform: process.platform,
      nodeBin: process.execPath,
      tailScript: TAIL_SCRIPT,
      commandFile: writeCommandFile(logDir, stamp, logPath),
    })

    return {
      onStdout: (chunk: Buffer) => stream.write(chunk),
      close: () => stream.end(),
      logPath,
    }
  } catch {
    return { onStdout: undefined, close: () => {}, logPath: null }
  }
}
