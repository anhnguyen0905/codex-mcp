import { spawn } from 'node:child_process'
import { z } from 'zod'

/**
 * Server-side acceptance verification: after a Codex run settles, run the caller's acceptance
 * command (test suite, build, probe) in the same workspace and attach the deterministic result to
 * the payload. This turns "Codex says tests pass" into evidence the reviewer can read directly.
 */

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_VERIFY_TIMEOUT_MS = 30 * 60 * 1000
export const VERIFY_OUTPUT_TAIL_CHARS = 4000
export const SIGKILL_GRACE_MS = 5 * 1000
/** After the command's process 'exit's, wait at most this long for stdio 'close' before force-settling. */
export const EXIT_SETTLE_GRACE_MS = 2 * 1000
/** Hard cap on bytes buffered from the child before tail-trimming, so a noisy suite can't eat RAM. */
const MAX_BUFFERED_CHARS = VERIFY_OUTPUT_TAIL_CHARS * 4

export type VerificationSkipReason = 'aborted' | 'run-failed'

export interface VerificationResult {
  command: string
  /** Process exit code; null when killed (timeout) or never started. */
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** Newest VERIFY_OUTPUT_TAIL_CHARS of interleaved stdout + stderr. */
  outputTail: string
  /** True exactly when the command ran to completion with exit code 0. */
  passed: boolean
  /** Set when the command was not run at all. */
  skipped?: VerificationSkipReason
}

export interface VerificationOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  spawnFn?: typeof spawn
  /** Grace between SIGTERM and SIGKILL, and again between SIGKILL and force-settle. */
  sigkillGraceMs?: number
  /** Grace between the process 'exit' and a forced settle when stdio 'close' never arrives. */
  exitSettleGraceMs?: number
}

export type VerifyFn = (command: string, options: VerificationOptions) => Promise<VerificationResult>

export const verificationSchema = z
  .object({
    command: z.string(),
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number(),
    outputTail: z.string(),
    passed: z.boolean(),
    skipped: z.enum(['aborted', 'run-failed']).optional(),
  })
  .nullable()

export const skippedVerification = (command: string, reason: VerificationSkipReason): VerificationResult => ({
  command,
  exitCode: null,
  timedOut: false,
  durationMs: 0,
  outputTail: '',
  passed: false,
  skipped: reason,
})

const tailOf = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(-maxChars)

const assertCommand = (command: string): void => {
  if (command.trim().length === 0) throw new Error('verifyCommand must be a non-empty string')
}

/** Spawn the verification command through the platform shell and settle with a deterministic result. */
export const runVerification: VerifyFn = (command, options) => {
  try {
    assertCommand(command)
  } catch (error) {
    return Promise.reject(error)
  }
  const {
    cwd,
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
    signal,
    spawnFn = spawn,
    sigkillGraceMs = SIGKILL_GRACE_MS,
    exitSettleGraceMs = EXIT_SETTLE_GRACE_MS,
  } = options
  if (signal?.aborted) return Promise.resolve(skippedVerification(command, 'aborted'))

  const startedAt = Date.now()
  const useProcessGroup = process.platform !== 'win32'

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: useProcessGroup,
    })

    let output = ''
    let timedOut = false
    let settled = false
    let terminating = false
    let killTimer: NodeJS.Timeout | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let exitTimer: NodeJS.Timeout | undefined

    const signalChild = (sig: NodeJS.Signals): void => {
      if (useProcessGroup && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, sig)
          return
        } catch {
          // group already gone — fall through
        }
      }
      child.kill(sig)
    }

    /**
     * Best-effort kill of the whole tree. POSIX: SIGKILL the process group. Windows: `shell: true`
     * runs the command under cmd.exe, and child.kill() only reaches cmd.exe, so use taskkill /T.
     */
    const killProcessTree = (): void => {
      if (process.platform === 'win32') {
        if (typeof child.pid !== 'number') return
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
        } catch {
          // best-effort
        }
        return
      }
      signalChild('SIGKILL')
    }

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        command,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: tailOf(output, VERIFY_OUTPUT_TAIL_CHARS),
        passed: !timedOut && exitCode === 0,
      })
    }

    // Bounded termination: SIGTERM → SIGKILL (tree) → force-settle. 'close' can never arrive when a
    // descendant that escaped the group keeps the stdio pipe open; the promise must still settle
    // because the caller holds the cwd lock and a concurrency slot until it does.
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      if (process.platform === 'win32') killProcessTree()
      else signalChild('SIGTERM')
      killTimer = setTimeout(() => {
        killProcessTree()
        forceTimer = setTimeout(() => settle(null), sigkillGraceMs)
      }, sigkillGraceMs)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const onAbort = (): void => terminate()
    signal?.addEventListener('abort', onAbort, { once: true })

    const onData = (chunk: Buffer): void => {
      output = tailOf(output + chunk.toString('utf8'), MAX_BUFFERED_CHARS)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const cleanup = (): void => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (forceTimer) clearTimeout(forceTimer)
      if (exitTimer) clearTimeout(exitTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      killProcessTree()
      reject(error)
    })

    // Normal path: process exited AND stdio reached EOF.
    child.on('close', (exitCode) => settle(exitCode))

    // The process itself exited but a descendant may hold the pipes open: bound that wait, kill the
    // tree so nothing keeps mutating the workspace after the lock is released, keep the real exit code.
    child.on('exit', (exitCode) => {
      if (settled || exitTimer) return
      exitTimer = setTimeout(() => {
        killProcessTree()
        settle(exitCode)
      }, exitSettleGraceMs)
    })
  })
}
