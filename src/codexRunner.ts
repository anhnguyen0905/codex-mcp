import { spawn } from 'node:child_process'
import type { RunOutcome } from './types.js'

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const SIGKILL_GRACE_MS = 5 * 1000
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

type SpawnFn = typeof spawn

/**
 * Resolve the Codex executable name for the current platform. On Windows the npm-installed CLI is a
 * `codex.cmd` shim, which `spawn` (shell:false) only finds by its full filename. `CODEX_BIN` overrides.
 */
export const resolveCodexBinary = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string => {
  const override = env.CODEX_BIN?.trim()
  if (override) return override
  return platform === 'win32' ? 'codex.cmd' : 'codex'
}

export interface RunOptions {
  cwd: string
  timeoutMs?: number
  spawnFn?: SpawnFn
  sigkillGraceMs?: number
  onStdout?: (chunk: Buffer) => void
  /** Cancels the run: the codex process gets SIGTERM, then SIGKILL after a grace period. */
  signal?: AbortSignal
}

export const runCodex = (args: string[], options: RunOptions): Promise<RunOutcome> => {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn,
    sigkillGraceMs = SIGKILL_GRACE_MS,
    onStdout,
    signal,
  } = options

  if (signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true })
  }

  // On POSIX, make the child a process-group leader so termination signals reach any
  // subprocesses Codex itself spawned (test runners, builds), not just the CLI process.
  const useProcessGroup = process.platform !== 'win32'

  return new Promise((resolve, reject) => {
    const child = spawnFn(resolveCodexBinary(process.platform, process.env), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: useProcessGroup,
    })

    const signalChild = (signal: NodeJS.Signals): void => {
      if (useProcessGroup && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // group may already be gone; fall through to direct kill
        }
      }
      child.kill(signal)
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let bufferedBytes = 0
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    let terminating = false
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      signalChild('SIGTERM')
      killTimer = setTimeout(() => signalChild('SIGKILL'), sigkillGraceMs)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const clearTimers = (): void => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const collect = (chunks: Buffer[], forward?: (chunk: Buffer) => void) => (chunk: Buffer) => {
      forward?.(chunk)
      if (bufferedBytes >= MAX_OUTPUT_BYTES) return
      bufferedBytes += chunk.length
      chunks.push(chunk)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimers()
      child.kill('SIGKILL')
      reject(error)
    }

    child.stdout?.on('data', collect(stdoutChunks, onStdout))
    child.stderr?.on('data', collect(stderrChunks))
    child.stdout?.on('error', fail)
    child.stderr?.on('error', fail)
    child.on('error', fail)

    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        timedOut,
        aborted,
      })
    })
  })
}
