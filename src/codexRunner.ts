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
}

export const runCodex = (args: string[], options: RunOptions): Promise<RunOutcome> => {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn,
    sigkillGraceMs = SIGKILL_GRACE_MS,
    onStdout,
  } = options

  return new Promise((resolve, reject) => {
    const child = spawnFn(resolveCodexBinary(process.platform, process.env), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let bufferedBytes = 0
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), sigkillGraceMs)
    }, timeoutMs)

    const clearTimers = (): void => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
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
      })
    })
  })
}
