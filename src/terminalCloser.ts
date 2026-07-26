import { spawn, spawnSync } from 'node:child_process'
import type { LiveRunFinishedStatus } from './progressFormatter.js'
import type { TerminalLaunch } from './terminal.js'

/** Grace period before the finished window closes, so the last output stays readable. */
export const DEFAULT_TERMINAL_CLOSE_DELAY_MS = 4000
/** Upper clamp; a huge delay would leave a zombie osascript waiting for hours. */
export const MAX_TERMINAL_CLOSE_DELAY_MS = 60_000
/** Bound the synchronous lookup so a stuck Terminal cannot wedge the watcher's exit path. */
export const RESOLVE_WINDOW_ID_TIMEOUT_MS = 5000

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

/**
 * Build the allowlisted config exports that must cross into Terminal.app's user-session shell.
 * Values outside these exact forms are omitted instead of escaped or interpolated.
 */
export const buildWatcherEnvExports = (env: TerminalCloseEnv): string => {
  const exports: string[] = []
  if (env[TERMINAL_KEEP_OPEN_ENV] === '1') {
    exports.push(`export ${TERMINAL_KEEP_OPEN_ENV}=1`)
  }

  const closeDelay = env[TERMINAL_CLOSE_DELAY_ENV]
  if (closeDelay !== undefined && /^\d+$/.test(closeDelay)) {
    exports.push(`export ${TERMINAL_CLOSE_DELAY_ENV}=${closeDelay}`)
  }
  return exports.join('\n')
}

/** Clamp + validate the delay env var; invalid/absent → DEFAULT_TERMINAL_CLOSE_DELAY_MS. */
export const resolveCloseDelayMs = (env: TerminalCloseEnv): number => {
  const rawDelay = env[TERMINAL_CLOSE_DELAY_ENV]?.trim() ?? ''
  if (!/^\d+$/.test(rawDelay)) return DEFAULT_TERMINAL_CLOSE_DELAY_MS

  const delayMs = Number.parseInt(rawDelay, 10)
  return Math.min(delayMs, MAX_TERMINAL_CLOSE_DELAY_MS)
}

/** Strict allowlist for a tty device path — anything else is refused (AppleScript injection guard). */
export const isSafeTtyPath = (value: string | undefined): boolean =>
  value !== undefined && /^\/dev\/(tty|pts)[A-Za-z0-9]*(\/[A-Za-z0-9]+)?$/.test(value)

/** Allowlist for a Terminal window id: digits only, so it can never inject AppleScript. */
export const isSafeWindowId = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/.test(value)

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

/**
 * Build the synchronous lookup while the tab is alive; Terminal resets its tty after process exit.
 */
export const buildResolveWindowIdLaunch = (
  platform: NodeJS.Platform,
  tty: string,
): TerminalLaunch | null => {
  if (platform !== 'darwin' || !isSafeTtyPath(tty)) return null

  return {
    command: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to get id of first window whose selected tab's tty is "${tty}"`,
    ],
  }
}

/** Build the detached close command; null when the platform/window id is unsupported or unsafe. */
export const buildCloseWindowLaunch = (
  platform: NodeJS.Platform,
  input: { readonly windowId: string; readonly delayMs: number },
): TerminalLaunch | null => {
  if (platform !== 'darwin' || !isSafeWindowId(input.windowId)) return null

  return {
    command: 'osascript',
    args: [
      '-e',
      `delay ${input.delayMs / 1000}`,
      '-e',
      `tell application "Terminal" to if (count of tabs of window id ${input.windowId}) is 1 then close window id ${input.windowId} saving no`,
    ],
  }
}

/** Best-effort fire-and-forget close. Returns false on any failure; never throws. */
export const closeTerminalWindow = (
  input: { readonly tty: string; readonly delayMs: number; readonly platform: NodeJS.Platform },
  deps?: {
    readonly spawnFn?: typeof import('node:child_process').spawn
    readonly spawnSyncFn?: typeof import('node:child_process').spawnSync
  },
): boolean => {
  const resolveLaunch = buildResolveWindowIdLaunch(input.platform, input.tty)
  if (resolveLaunch === null) return false

  try {
    const result = (deps?.spawnSyncFn ?? spawnSync)(resolveLaunch.command, resolveLaunch.args, {
      encoding: 'utf8',
      timeout: RESOLVE_WINDOW_ID_TIMEOUT_MS,
    })
    // spawnSync reports a timeout via `error` even when status is zero and stdout looks valid.
    if (result === undefined || result === null || result.error !== undefined) return false
    if (result.status !== 0 || typeof result.stdout !== 'string') return false

    const windowId = result.stdout.trim()
    if (!isSafeWindowId(windowId)) return false

    const closeLaunch = buildCloseWindowLaunch(input.platform, { windowId, delayMs: input.delayMs })
    if (closeLaunch === null) return false

    const child = (deps?.spawnFn ?? spawn)(closeLaunch.command, closeLaunch.args, {
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
