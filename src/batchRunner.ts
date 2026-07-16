import type { CodexResult, SandboxMode } from './types.js'
import type { WorkspaceDiff } from './workspaceDiff.js'

export interface BatchTaskSpec {
  cwd: string
  prompt: string
  sandbox?: SandboxMode
  model?: string
  timeoutMs?: number
}

export interface BatchTaskResult {
  taskIndex: number
  cwd: string
  parsed: CodexResult
  diff: WorkspaceDiff | null
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stderr: string
  liveLog: string | null
  isError: boolean
  /** Populated only when the orchestrator itself failed to run the task (spawn error, invalid input). */
  error?: string
}

/** Runs one task and returns its payload — orchestration owns concurrency/abort, not this fn. */
export type TaskRunner = (
  task: BatchTaskSpec,
  taskIndex: number,
  signal: AbortSignal,
) => Promise<BatchTaskResult>

export interface RunBatchOptions {
  /** Default 10; hard-capped at MAX_ALLOWED_CONCURRENCY so a caller typo can't spawn hundreds. */
  maxConcurrency?: number
  /** If true, cancel siblings on the first task that errors. Default false (continue-on-error). */
  failFast?: boolean
}

export const DEFAULT_BATCH_CONCURRENCY = 10
/** Sanity cap: batch is designed for a handful of worktrees, not fanning out to hundreds. */
export const MAX_ALLOWED_CONCURRENCY = 32

const emptyParsed = (): CodexResult => ({
  sessionId: null,
  agentMessage: null,
  fileChanges: [],
  commands: [],
  usage: null,
  errors: [],
})

const skippedResult = (task: BatchTaskSpec, taskIndex: number, error: string): BatchTaskResult => ({
  taskIndex,
  cwd: task.cwd,
  parsed: emptyParsed(),
  diff: null,
  exitCode: null,
  timedOut: false,
  aborted: true,
  stderr: '',
  liveLog: null,
  isError: true,
  error,
})

/**
 * Fan `tasks` out across up to `maxConcurrency` workers, respecting an external abort signal.
 * The caller-supplied `runTask` owns per-task locking and payload construction — this fn only
 * schedules, aggregates, and coordinates fail-fast/abort so it can be unit-tested in isolation.
 */
export const runBatch = async (
  tasks: readonly BatchTaskSpec[],
  runTask: TaskRunner,
  options: RunBatchOptions,
  signal: AbortSignal,
): Promise<BatchTaskResult[]> => {
  if (tasks.length === 0) return []

  // Batch is designed for parallel across distinct workspaces — duplicate cwd would serialize
  // on the per-cwd lock and defeat the point. Fail loudly at the input boundary.
  const seen = new Set<string>()
  for (const t of tasks) {
    if (seen.has(t.cwd)) {
      throw new Error(
        `duplicate cwd in batch: ${t.cwd} — codex_batch is designed for parallel across distinct workspaces (call codex_execute sequentially for multiple tasks in one cwd)`,
      )
    }
    seen.add(t.cwd)
  }

  const requested = options.maxConcurrency ?? DEFAULT_BATCH_CONCURRENCY
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`maxConcurrency must be a positive integer, got: ${requested}`)
  }
  const cap = Math.min(requested, MAX_ALLOWED_CONCURRENCY, tasks.length)
  const failFast = options.failFast ?? false

  const results: (BatchTaskResult | undefined)[] = new Array(tasks.length).fill(undefined)
  // Fold the external signal with our own so `failFast` can cancel siblings without touching
  // the caller's AbortController.
  const localAbort = new AbortController()
  const propagate = (): void => localAbort.abort()
  if (signal.aborted) localAbort.abort()
  else signal.addEventListener('abort', propagate, { once: true })

  let nextIdx = 0
  const worker = async (): Promise<void> => {
    while (true) {
      if (localAbort.signal.aborted) return
      const i = nextIdx++
      if (i >= tasks.length) return
      const task = tasks[i]
      try {
        const r = await runTask(task, i, localAbort.signal)
        results[i] = r
        if (failFast && r.isError && !localAbort.signal.aborted) localAbort.abort()
      } catch (err) {
        results[i] = {
          ...skippedResult(task, i, err instanceof Error ? err.message : String(err)),
          aborted: false, // this task ran and threw — not aborted pre-start
        }
        if (failFast && !localAbort.signal.aborted) localAbort.abort()
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: cap }, () => worker()))
  } finally {
    signal.removeEventListener('abort', propagate)
  }

  // Fill un-run slots (fail-fast/abort mid-batch) with a placeholder so array shape matches input.
  return results.map((r, i) => r ?? skippedResult(tasks[i], i, 'skipped: batch cancelled before this task started'))
}
