import { spawn } from 'node:child_process'

type SpawnFn = typeof spawn

export interface LinuxTerminal {
  /** Emulator executable, e.g. `gnome-terminal`, `konsole`, `xterm`. */
  command: string
  /** Flag(s) that precede the program to run, e.g. `['--']` for gnome-terminal, `['-e']` for xterm. */
  execFlag: string[]
}

/**
 * Known Linux terminal emulators and how they take a command to run, in preference order.
 * The launcher picks the first one that exists on the host (detected in liveView).
 */
export const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  { command: 'x-terminal-emulator', execFlag: ['-e'] },
  { command: 'gnome-terminal', execFlag: ['--'] },
  { command: 'konsole', execFlag: ['-e'] },
  { command: 'xfce4-terminal', execFlag: ['-x'] },
  { command: 'kitty', execFlag: [] },
  { command: 'alacritty', execFlag: ['-e'] },
  { command: 'xterm', execFlag: ['-e'] },
]

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
  /** Detected Linux terminal emulator (chosen by liveView). When absent, Linux has no viewer. */
  linuxTerminal?: LinuxTerminal
}

export interface OpenTerminalOptions extends Omit<TerminalPaths, 'logPath'> {
  platform: NodeJS.Platform
  spawnFn?: SpawnFn
}

export interface TerminalLaunch {
  command: string
  args: string[]
}

const escapeAppleScript = (value: string): string =>
  value
    // A literal newline in `do script "..."` is executed as a Return keystroke (command injection);
    // there's no safe way to embed one, so collapse CR/LF to a space before escaping.
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')

const escapePowerShell = (value: string): string => value.replace(/'/g, "''")

/**
 * Escape a value for interpolation inside a POSIX double-quoted shell string ("..."). Without this,
 * a workspace path containing `"`, backtick, `$` or `\` would break out and let a shell execute
 * arbitrary code when the viewer opens. Only backslash, double-quote, backtick and dollar are
 * special inside double quotes.
 */
export const escapeDoubleQuotedShell = (value: string): string => value.replace(/[\\"`$]/g, '\\$&')

const buildDarwinLaunch = ({ nodeBin, tailScript, logPath, commandFile }: TerminalPaths): TerminalLaunch => {
  if (commandFile) {
    return { command: 'open', args: ['-a', 'Terminal', commandFile] }
  }
  const dq = escapeDoubleQuotedShell
  const shellCommand = `"${dq(nodeBin)}" "${dq(tailScript)}" "${dq(logPath)}"`
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
  // Embed real double-quotes inside each ArgumentList element: Windows PowerShell 5.1's
  // Start-Process joins the array with bare spaces to build the child's command line, so a path
  // containing a space (very common on Windows) would otherwise be split into extra argv tokens.
  const argumentList = [tailScript, logPath].map((value) => `'"${escapePowerShell(value)}"'`).join(',')
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${escapePowerShell(nodeBin)}' -ArgumentList ${argumentList}`,
    ],
  }
}

const buildLinuxLaunch = ({ nodeBin, tailScript, logPath, linuxTerminal }: TerminalPaths): TerminalLaunch | null => {
  if (!linuxTerminal) return null
  return {
    command: linuxTerminal.command,
    args: [...linuxTerminal.execFlag, nodeBin, tailScript, logPath],
  }
}

/** Build the platform-specific command to open a new terminal window tailing the Codex log. */
export const buildTerminalLaunch = (
  platform: NodeJS.Platform,
  paths: TerminalPaths,
): TerminalLaunch | null => {
  if (platform === 'darwin') return buildDarwinLaunch(paths)
  if (platform === 'win32') return buildWindowsLaunch(paths)
  if (platform === 'linux') return buildLinuxLaunch(paths)
  return null
}

/**
 * Open a terminal window that follows the Codex live log (macOS Terminal.app / Windows PowerShell).
 * Best-effort: unsupported platforms and spawn failures return false, never throw — a missing
 * viewer must never fail the actual Codex run. On other platforms, tail the `logPath` manually.
 */
export const openTerminal = (logPath: string, options: OpenTerminalOptions): boolean => {
  const { platform, nodeBin, tailScript, commandFile, linuxTerminal, spawnFn = spawn } = options
  const launch = buildTerminalLaunch(platform, { nodeBin, tailScript, logPath, commandFile, linuxTerminal })
  if (launch === null) return false

  try {
    const child = spawnFn(launch.command, launch.args, { stdio: 'ignore', detached: true })
    // spawn reports a missing/unrunnable launcher (ENOENT/EACCES) via an async 'error' event, not
    // a throw. Without a listener Node would rethrow it as an unhandled event and crash the whole
    // MCP server — swallow it, the viewer is best-effort.
    child.on?.('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
