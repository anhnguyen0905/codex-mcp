import { spawn } from 'node:child_process'
import type { LiveRunFinishedStatus } from './progressFormatter.js'
import type { TerminalLaunch } from './terminal.js'

/** Grace period before the finished window closes, so the last output stays readable. */
export const DEFAULT_TERMINAL_CLOSE_DELAY_MS = 4000
/** Upper clamp; a huge delay would leave a zombie osascript waiting for hours. */
export const MAX_TERMINAL_CLOSE_DELAY_MS = 60_000

/** Env var names, exported so the launcher and the watcher can never drift apart. */
export const TERMINAL_TTY_ENV = 'CODEX_MCP_TERMINAL_TTY'
export const TERMINAL_KEEP_OPEN_ENV = 'CODEX_MCP_TERMINAL_KEEP_OPEN'
export const TERMINAL_CLOSE_DELAY_ENV = 'CODEX_MCP_TERMINAL_CLOSE_DELAY_MS'

export type TerminalCloseEnv = Readonly<Record<string, string | undefined>>

export interface TerminalCloseDecision {
  /** True only when the window should be closed. */
  readonly close: boolean
  /** Human-readable why, printed into the window before it closes / stays. */
  readonly reason: string
  /** Resolved grace delay in ms; meaningless when close === false. */
  readonly delayMs: number
}

/** Clamp + validate the delay env var; invalid/absent → DEFAULT_TERMINAL_CLOSE_DELAY_MS. */
export const resolveCloseDelayMs = (env: TerminalCloseEnv): number => {
  const delayMs = Number.parseInt(env[TERMINAL_CLOSE_DELAY_ENV] ?? '', 10)
  if (Number.isNaN(delayMs) || delayMs < 0) return DEFAULT_TERMINAL_CLOSE_DELAY_MS
  return Math.min(delayMs, MAX_TERMINAL_CLOSE_DELAY_MS)
}

/** Strict allowlist for a tty device path — anything else is refused (AppleScript injection guard). */
export const isSafeTtyPath = (value: string | undefined): boolean =>
  value !== undefined && /^\/dev\/(tty|pts)[A-Za-z0-9]*(\/[A-Za-z0-9]+)?$/.test(value)

/**
 * Pure decision: close only on a `completed` run, on darwin, when not opted out,
 * and when the tty is present and well-formed.
 */
export const decideTerminalClose = (input: {
  readonly status: LiveRunFinishedStatus
  readonly platform: NodeJS.Platform
  readonly env: TerminalCloseEnv
}): TerminalCloseDecision => {
  if (input.status !== 'completed') {
    return { close: false, reason: `run status is ${input.status}`, delayMs: 0 }
  }
  if (input.platform !== 'darwin') {
    return { close: false, reason: `platform ${input.platform} is not supported`, delayMs: 0 }
  }
  if (input.env[TERMINAL_KEEP_OPEN_ENV] === '1') {
    return { close: false, reason: 'terminal auto-close is disabled', delayMs: 0 }
  }

  const tty = input.env[TERMINAL_TTY_ENV]
  if (!isSafeTtyPath(tty)) {
    return { close: false, reason: 'terminal tty is missing or unsafe', delayMs: 0 }
  }

  return {
    close: true,
    reason: 'run completed',
    delayMs: resolveCloseDelayMs(input.env),
  }
}

/** Build the detached close command; null when the platform/tty makes closing unsupported. */
export const buildCloseWindowLaunch = (
  platform: NodeJS.Platform,
  input: { readonly tty: string; readonly delayMs: number },
): TerminalLaunch | null => {
  if (platform !== 'darwin' || !isSafeTtyPath(input.tty)) return null

  return {
    command: 'osascript',
    args: [
      '-e',
      `delay ${input.delayMs / 1000}`,
      '-e',
      `tell application "Terminal" to close (every window whose selected tab's tty is "${input.tty}") saving no`,
    ],
  }
}

/** Best-effort fire-and-forget close. Returns false on any failure; never throws. */
export const closeTerminalWindow = (
  input: { readonly tty: string; readonly delayMs: number; readonly platform: NodeJS.Platform },
  deps?: { readonly spawnFn?: typeof import('node:child_process').spawn },
): boolean => {
  const launch = buildCloseWindowLaunch(input.platform, input)
  if (launch === null) return false

  try {
    const child = (deps?.spawnFn ?? spawn)(launch.command, launch.args, {
      stdio: 'ignore',
      detached: true,
    })
    // spawn reports a missing osascript via an async 'error' event. Without a listener Node would
    // rethrow it and crash the watcher, violating this helper's best-effort contract.
    child.on?.('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
