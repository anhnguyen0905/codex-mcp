import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildContinueInvocation, type CodexInvocation } from './argsBuilder.js'
import type { RunOptions } from './codexRunner.js'
import {
  decideResume,
  type ResumeReason,
  type ResumeSignals,
} from './retryPolicy.js'
import { combineSinks } from './progressNotifier.js'
import { runOnce, safeSnapshot, type RunAndReportDeps } from './runReport.js'
import type { RunPayload } from './toolPayloads.js'
import type { ReasoningEffort, SandboxMode } from './types.js'
import type { WorkspaceSnapshot } from './workspaceDiff.js'

export interface RecoveryConfig {
  enabled: boolean
  sandbox: SandboxMode
  model?: string
  reasoningEffort?: ReasoningEffort
  sleepFn?: (ms: number) => Promise<void>
  makeRunId?: () => string
}

interface RecoveryResult {
  payload: RunPayload
  isError: boolean
}

const EMPTY_RESUME_COUNTS: Readonly<Record<ResumeReason, number>> = {
  timeout: 0,
  'transient-turn-failure': 0,
  'no-completion-marker': 0,
}

const RESUME_STREAM_BOUNDARY = Buffer.from('\n')

const withRecoveryMetadata = (
  result: RecoveryResult,
  attempts: number,
  resumeReasons: readonly ResumeReason[],
): RecoveryResult => ({
  ...result,
  payload: { ...result.payload, attempts, resumeReasons },
})

const toResumeSignals = (
  payload: RunPayload,
  resumeCounts: Readonly<Record<ResumeReason, number>>,
): ResumeSignals => ({
  status: payload.status,
  timedOut: payload.timedOut,
  aborted: payload.aborted,
  exitCode: payload.exitCode,
  errors: payload.errors,
  sawCompletion: payload.sawCompletion,
  sessionId: payload.sessionId,
  resumeCounts,
})

const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  try {
    await sleep(ms, undefined, { signal })
  } catch (error) {
    if (!signal?.aborted) throw error
  }
}

const sleepWithAbort = async (
  sleepFn: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (!signal) return sleepFn(ms)
  if (signal.aborted) return

  let onAbort = (): void => {}
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([sleepFn(ms), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export const buildResumePrompt = (reason: ResumeReason): string =>
  `The previous run was interrupted for ${reason}; continue the SAME task from where it left off, ` +
  're-check work already done, finish and run its acceptance checks.'

const settleSinks = (deps: Omit<RunAndReportDeps, 'runId'>): void => {
  try {
    deps.progressNotifier?.settle()
  } finally {
    deps.view.close()
  }
}

const buildRecoveryInvocation = (
  sessionId: string,
  reason: ResumeReason,
  recovery: RecoveryConfig,
): CodexInvocation =>
  buildContinueInvocation({
    sessionId,
    prompt: buildResumePrompt(reason),
    sandbox: recovery.sandbox,
    model: recovery.model,
    reasoningEffort: recovery.reasoningEffort,
  })

const forwardResumeBoundary = (deps: Omit<RunAndReportDeps, 'runId'>): void => {
  combineSinks(deps.view.onStdout, deps.progressNotifier?.sink)?.(RESUME_STREAM_BOUNDARY)
}

const runRecoveryAttempts = async (
  deps: Omit<RunAndReportDeps, 'runId'>,
  invocation: CodexInvocation,
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
  recovery: RecoveryConfig,
  presetSnapshot: WorkspaceSnapshot | null,
): Promise<RecoveryResult> => {
  const sleepFn = recovery.sleepFn ?? ((ms: number) => defaultSleep(ms, options.signal))
  const makeRunId = recovery.makeRunId ?? randomUUID
  let attempts = 0
  let resumeCounts = EMPTY_RESUME_COUNTS
  let resumeReasons: readonly ResumeReason[] = []
  let nextInvocation = invocation

  while (true) {
    attempts += 1
    const result = await runOnce(
      { ...deps, presetSnapshot, runId: makeRunId(), ownsSinks: false },
      nextInvocation.args,
      { ...options, stdinInput: nextInvocation.stdinInput },
    )
    if (!recovery.enabled) return withRecoveryMetadata(result, attempts, resumeReasons)

    const decision = decideResume(toResumeSignals(result.payload, resumeCounts))
    if (!decision.resume) return withRecoveryMetadata(result, attempts, resumeReasons)
    if (!decision.reason || decision.delayMs === undefined || result.payload.sessionId === null) {
      throw new Error('resume policy returned an incomplete resume decision')
    }

    await sleepWithAbort(sleepFn, decision.delayMs, options.signal)
    if (options.signal?.aborted) return withRecoveryMetadata(result, attempts, resumeReasons)
    resumeCounts = {
      ...resumeCounts,
      [decision.reason]: resumeCounts[decision.reason] + 1,
    }
    resumeReasons = [...resumeReasons, decision.reason]
    nextInvocation = buildRecoveryInvocation(
      result.payload.sessionId,
      decision.reason,
      recovery,
    )
    // Attempts share stateful line decoders, so a boundary prevents a truncated prior line from
    // consuming the resumed attempt's first complete event.
    forwardResumeBoundary(deps)
  }
}

/**
 * Own the shared LiveView and progress notifier across the full logical recovery run. Individual
 * attempts leave both sinks open so resumed output remains visible; the final flush and end-of-run
 * marker happen exactly once after the last attempt or a thrown error.
 */
export const runWithRecovery = async (
  deps: Omit<RunAndReportDeps, 'runId'>,
  invocation: CodexInvocation,
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
  recovery: RecoveryConfig,
): Promise<RecoveryResult> => {
  try {
    const presetSnapshot =
      deps.presetSnapshot === undefined
        ? await safeSnapshot(deps.snapshotFn, options.cwd)
        : deps.presetSnapshot
    return await runRecoveryAttempts(deps, invocation, options, recovery, presetSnapshot)
  } finally {
    settleSinks(deps)
  }
}
