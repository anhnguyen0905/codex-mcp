import { spawn } from 'node:child_process'
import { createIncrementalParser, type ParsedEvents } from './eventParser.js'
import type { RunOutcome } from './types.js'

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const SIGKILL_GRACE_MS = 5 * 1000
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024
/**
 * Raw stdout retention for debugging/payload: only the newest bytes are kept (tail rotation).
 * The incremental parser sees the FULL stream regardless, so `parsed` never loses events —
 * `truncated` only means "the raw `stdout` field dropped old bytes".
 */
export const RAW_STDOUT_TAIL_BYTES = 1 * 1024 * 1024
/** After the codex process 'exit's, wait at most this long for stdio 'close' (EOF) before force-settling. */
export const EXIT_SETTLE_GRACE_MS = 2 * 1000

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
  /** How long to wait after 'exit' for stdio 'close' before killing lingerers and force-settling. */
  exitSettleGraceMs?: number
  onStdout?: (chunk: Buffer) => void
  /** When set, the child gets a stdin pipe and this content is written to it (prompt-via-stdin mode). */
  stdinInput?: string
  /** Cancels the run: the codex process gets SIGTERM, then SIGKILL after a grace period. */
  signal?: AbortSignal
}

/** RunOutcome plus the incrementally parsed event stream (additive — server may ignore it). */
export interface RunOutcomeWithEvents extends RunOutcome {
  parsed?: ParsedEvents
}

export const runCodex = (args: string[], options: RunOptions): Promise<RunOutcomeWithEvents> => {
  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn,
    sigkillGraceMs = SIGKILL_GRACE_MS,
    exitSettleGraceMs = EXIT_SETTLE_GRACE_MS,
    onStdout,
    stdinInput,
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
      stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

    /**
     * Best-effort kill of the whole process tree — descendants included, even after the direct
     * child already exited. POSIX: SIGKILL to the process group. Windows: `taskkill /T /F`.
     */
    const killProcessTree = (): void => {
      if (process.platform === 'win32') {
        if (typeof child.pid !== 'number') return
        try {
          // Uses the real spawn (not spawnFn, which fakes the codex child in tests).
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            .on('error', () => {
              // best-effort: taskkill missing or tree already gone
            })
        } catch {
          // best-effort: spawning taskkill itself failed
        }
        return
      }
      signalChild('SIGKILL')
    }

    if (stdinInput !== undefined && child.stdin) {
      // EPIPE (child exited before/while reading the prompt) must not become an unhandled
      // 'error' crash: the exit/close path already reports the failure via the exit code.
      child.stdin.on('error', () => {})
      child.stdin.end(stdinInput)
    }

    const stderrChunks: Buffer[] = []
    const parser = createIncrementalParser()
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let exitTimer: NodeJS.Timeout | undefined

    let terminating = false
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      signalChild('SIGTERM')
      killTimer = setTimeout(() => {
        signalChild('SIGKILL')
        // A descendant that escaped the process group (setsid / double-fork) can hold the stdio
        // pipe open so 'close' never fires; force-settle so the promise (and the cwd lock +
        // concurrency slot it holds) can't hang forever after the kill.
        forceTimer = setTimeout(() => settle(null), sigkillGraceMs)
      }, sigkillGraceMs)
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
      if (forceTimer) clearTimeout(forceTimer)
      if (exitTimer) clearTimeout(exitTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    // stderr keeps its head-capped budget: a noisy stderr must not grow unbounded, and its cap
    // is independent of stdout so chatter on one stream never evicts the other.
    const makeCollector = (chunks: Buffer[]) => {
      let bytes = 0
      let capped = false
      const onData = (chunk: Buffer): void => {
        if (capped) return
        const remaining = MAX_OUTPUT_BYTES - bytes
        if (remaining <= 0) {
          capped = true
          return
        }
        if (chunk.length > remaining) {
          // A single oversized chunk must not blow past the cap: keep exactly the bytes that fit.
          const head = chunk.subarray(0, remaining)
          bytes += head.length
          chunks.push(head)
          capped = true
          return
        }
        bytes += chunk.length
        chunks.push(chunk)
      }
      return { onData }
    }
    // Raw stdout keeps only the newest `maxBytes` (tail rotation) — enough for debugging without
    // buffering a multi-GB stream. The parse is NOT affected: the parser is fed upstream of this.
    const makeTailCollector = (maxBytes: number) => {
      const chunks: Buffer[] = []
      let bytes = 0
      let rotated = false
      const onData = (chunk: Buffer): void => {
        const tail = chunk.length > maxBytes ? chunk.subarray(chunk.length - maxBytes) : chunk
        if (tail.length < chunk.length) rotated = true
        chunks.push(tail)
        bytes += tail.length
        // Evict oldest bytes until the tail fits the budget again.
        while (bytes > maxBytes) {
          const head = chunks[0]
          const overflow = bytes - maxBytes
          if (head.length <= overflow) {
            chunks.shift()
            bytes -= head.length
          } else {
            chunks[0] = head.subarray(overflow)
            bytes -= overflow
          }
          rotated = true
        }
      }
      return { onData, didRotate: () => rotated, concat: () => Buffer.concat(chunks) }
    }
    // The parser is LOSSLESS: it sees every stdout byte before tail-capping, so `outcome.parsed`
    // is authoritative even when the raw `stdout` tail rotated. Forwarding to the live view /
    // progress sink stays capped so a runaway stream can't fill the disk.
    let forwardedBytes = 0
    const onStdoutData = (chunk: Buffer): void => {
      parser.push(chunk)
      stdoutTail.onData(chunk)
      if (!onStdout) return
      const remaining = MAX_OUTPUT_BYTES - forwardedBytes
      if (remaining <= 0) return
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      forwardedBytes += slice.length
      onStdout(slice)
    }
    const stdoutTail = makeTailCollector(RAW_STDOUT_TAIL_BYTES)
    const stderrCollector = makeCollector(stderrChunks)

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimers()
      parser.end()
      resolve({
        stdout: stdoutTail.concat().toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        timedOut,
        aborted,
        // Raw-tail rotation only: the parse (`parsed`) saw the full stream regardless.
        truncated: stdoutTail.didRotate(),
        parsed: parser.result(),
      })
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimers()
      // Group-kill (not just the direct child) so subprocesses Codex spawned don't orphan.
      signalChild('SIGKILL')
      reject(error)
    }

    child.stdout?.on('data', onStdoutData)
    child.stderr?.on('data', stderrCollector.onData)
    child.stdout?.on('error', fail)
    child.stderr?.on('error', fail)
    child.on('error', fail)

    // Normal path: 'close' fires once the process exited AND all stdio reached EOF.
    child.on('close', (exitCode) => settle(exitCode))

    // 'exit' fires when the codex process itself exits; 'close' can lag (or never come) if a
    // lingering descendant keeps the inherited stdout/stderr pipe open. Bound that wait so a
    // finished run doesn't stall for the full timeout holding the lock/slot.
    child.on('exit', (exitCode) => {
      if (settled || exitTimer) return
      exitTimer = setTimeout(() => {
        // Pipes are still open past the grace window: descendants outlived the CLI. Kill the
        // whole tree BEFORE settling — settle releases the caller's cwd lock, and an orphan
        // must not keep mutating the workspace after that. The child's real exit code is
        // preserved (a lingering pipe is not a run failure).
        killProcessTree()
        settle(exitCode)
      }, exitSettleGraceMs)
    })
  })
}
