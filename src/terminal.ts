import { spawn } from 'node:child_process'

type SpawnFn = typeof spawn

export interface TerminalPaths {
  nodeBin: string
  tailScript: string
  logPath: string
  /**
   * Executable `.command` wrapper (macOS). When present, the launcher uses `open -a Terminal`
   * (LaunchServices) instead of `osascript` (Apple Events), which does not require the caller to
   * hold Automation (TCC) permission — the common failure mode when spawned from an MCP server.
   */
  commandFile?: string
}

export interface OpenTerminalOptions extends Omit<TerminalPaths, 'logPath'> {
  platform: NodeJS.Platform
  spawnFn?: SpawnFn
}

export interface TerminalLaunch {
  command: string
  args: string[]
}

const escapeAppleScript = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

const escapePowerShell = (value: string): string => value.replace(/'/g, "''")

const buildDarwinLaunch = ({ nodeBin, tailScript, logPath, commandFile }: TerminalPaths): TerminalLaunch => {
  if (commandFile) {
    return { command: 'open', args: ['-a', 'Terminal', commandFile] }
  }
  const shellCommand = `"${nodeBin}" "${tailScript}" "${logPath}"`
  const escaped = escapeAppleScript(shellCommand)
  return {
    command: 'osascript',
    args: [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script "${escaped}"`,
    ],
  }
}

const buildWindowsLaunch = ({ nodeBin, tailScript, logPath }: TerminalPaths): TerminalLaunch => {
  const argumentList = [tailScript, logPath].map((value) => `'${escapePowerShell(value)}'`).join(',')
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${escapePowerShell(nodeBin)}' -ArgumentList ${argumentList}`,
    ],
  }
}

/** Build the platform-specific command to open a new terminal window tailing the Codex log. */
export const buildTerminalLaunch = (
  platform: NodeJS.Platform,
  paths: TerminalPaths,
): TerminalLaunch | null => {
  if (platform === 'darwin') return buildDarwinLaunch(paths)
  if (platform === 'win32') return buildWindowsLaunch(paths)
  return null
}

/**
 * Open a terminal window that follows the Codex live log (macOS Terminal.app / Windows PowerShell).
 * Best-effort: unsupported platforms and spawn failures return false, never throw — a missing
 * viewer must never fail the actual Codex run. On other platforms, tail the `logPath` manually.
 */
export const openTerminal = (logPath: string, options: OpenTerminalOptions): boolean => {
  const { platform, nodeBin, tailScript, commandFile, spawnFn = spawn } = options
  const launch = buildTerminalLaunch(platform, { nodeBin, tailScript, logPath, commandFile })
  if (launch === null) return false

  try {
    const child = spawnFn(launch.command, launch.args, { stdio: 'ignore', detached: true })
    child.unref()
    return true
  } catch {
    return false
  }
}
