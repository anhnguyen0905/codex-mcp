import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, test, vi } from 'vitest'
import { buildExecuteInvocation } from '../src/argsBuilder.js'
import type { RunOptions, RunOutcomeWithEvents } from '../src/codexRunner.js'
import {
  buildResumePrompt,
  runWithRecovery,
  type RecoveryConfig,
} from '../src/runRecovery.js'
import { createProgressNotifier } from '../src/progressNotifier.js'
import type { RunAndReportDeps, RunFn } from '../src/runReport.js'
import { runOutputShape } from '../src/toolPayloads.js'
import type { RunAttribution, WorkspaceSnapshot } from '../src/workspaceDiff.js'

const SESSION_ID = 'session-123'
const INITIAL_INVOCATION = buildExecuteInvocation({
  prompt: 'implement task T3',
  cwd: '/repo',
  sandbox: 'workspace-write',
})
const RUN_OPTIONS: Omit<RunOptions, 'spawnFn' | 'onStdout'> = { cwd: '/repo' }
const BASE_RECOVERY: RecoveryConfig = {
  enabled: true,
  sandbox: 'workspace-write',
  sleepFn: async () => {},
}

const eventStream = (...events: readonly object[]): string =>
  events.map((event) => JSON.stringify(event)).join('\n')

const successOutcome = (): RunOutcomeWithEvents => ({
  stdout: eventStream(
    { type: 'thread.started', thread_id: SESSION_ID },
    { type: 'turn.completed', usage: {} },
  ),
  stderr: '',
  exitCode: 0,
  timedOut: false,
})

const turnFailureOutcome = (message: string): RunOutcomeWithEvents => ({
  stdout: eventStream(
    { type: 'thread.started', thread_id: SESSION_ID },
    { type: 'turn.failed', error: { message } },
  ),
  stderr: '',
  exitCode: 0,
  timedOut: false,
})

const timeoutOutcome = (): RunOutcomeWithEvents => ({
  stdout: eventStream({ type: 'thread.started', thread_id: SESSION_ID }),
  stderr: '',
  exitCode: null,
  timedOut: true,
})

const abortedOutcome = (): RunOutcomeWithEvents => ({
  stdout: eventStream({ type: 'thread.started', thread_id: SESSION_ID }),
  stderr: '',
  exitCode: null,
  timedOut: false,
  aborted: true,
})

const partialOutcome = (): RunOutcomeWithEvents => ({
  stdout: eventStream({ type: 'thread.started', thread_id: SESSION_ID }),
  stderr: '',
  exitCode: 0,
  timedOut: false,
})

const makeRunFn = (
  outcomes: readonly RunOutcomeWithEvents[],
  onAttempt?: (attempt: number) => void,
) => {
  let callIndex = 0
  return vi.fn(
    async (
      _args: string[],
      _options: Omit<RunOptions, 'spawnFn'>,
    ): Promise<RunOutcomeWithEvents> => {
      const outcome = outcomes[callIndex]
      onAttempt?.(callIndex + 1)
      callIndex += 1
      if (!outcome) throw new Error('runFn called more times than expected')
      return outcome
    },
  )
}

const makeSinkLifecycle = () => {
  const events: string[] = []
  const attemptStates: Array<{ viewClosed: boolean; notifierSettled: boolean }> = []
  let viewClosed = false
  let notifierSettled = false
  const close = vi.fn((): void => {
    events.push('view-close')
    viewClosed = true
  })
  const settle = vi.fn((): void => {
    events.push('notifier-settle')
    notifierSettled = true
  })
  const recordAttempt = (attempt: number): void => {
    events.push(`attempt-${attempt}`)
    attemptStates.push({ viewClosed, notifierSettled })
  }

  return {
    events,
    attemptStates,
    close,
    settle,
    recordAttempt,
    view: { onStdout: undefined, close, logPath: null },
    progressNotifier: { sink: () => {}, settle },
  }
}

const makeRunIds = (...runIds: readonly string[]) => {
  let callIndex = 0
  return vi.fn((): string => {
    const runId = runIds[callIndex]
    callIndex += 1
    if (!runId) throw new Error('makeRunId called more times than expected')
    return runId
  })
}

const makeDeps = (runFn: RunFn): Omit<RunAndReportDeps, 'runId'> => ({
  runFn,
  view: { onStdout: undefined, close: () => {}, logPath: null },
  diffFn: async () => null,
  snapshotFn: async () => null,
  attributeFn: async () => null,
  tool: 'codex_execute',
})

const withCapturedMetricRunIds = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; runIds: unknown[] }> => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mcp-recovery-'))
  const logPath = join(directory, 'metrics.jsonl')
  const previousLogPath = process.env.CODEX_MCP_METRICS_LOG
  process.env.CODEX_MCP_METRICS_LOG = logPath
  try {
    const result = await run()
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
    const runIds = lines.map((line) => {
      const metric: unknown = JSON.parse(line)
      return typeof metric === 'object' && metric !== null && 'runId' in metric
        ? metric.runId
        : undefined
    })
    return { result, runIds }
  } finally {
    if (previousLogPath === undefined) delete process.env.CODEX_MCP_METRICS_LOG
    else process.env.CODEX_MCP_METRICS_LOG = previousLogPath
    await rm(directory, { recursive: true, force: true })
  }
}

describe('buildResumePrompt', () => {
  test('builds the fixed continuation prompt with the recovery reason', () => {
    const prompt = buildResumePrompt('timeout')

    expect(prompt).toBe(
      'The previous run was interrupted for timeout; continue the SAME task from where it left off, ' +
        're-check work already done, finish and run its acceptance checks.',
    )
  })
})

describe('runWithRecovery', () => {
  test('returns a successful first attempt and settles shared sinks exactly once', async () => {
    // Arrange
    const lifecycle = makeSinkLifecycle()
    const runFn = makeRunFn([successOutcome()], lifecycle.recordAttempt)
    const sleepFn = vi.fn(async () => {})
    const makeRunId = makeRunIds('run-1')

    // Act
    const result = await runWithRecovery(
      {
        ...makeDeps(runFn),
        view: lifecycle.view,
        progressNotifier: lifecycle.progressNotifier,
      },
      INITIAL_INVOCATION,
      RUN_OPTIONS,
      { ...BASE_RECOVERY, sleepFn, makeRunId },
    )

    // Assert
    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({
      status: 'success',
      runId: 'run-1',
      attempts: 1,
      resumeReasons: [],
    })
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(makeRunId).toHaveBeenCalledTimes(1)
    expect(lifecycle.attemptStates).toEqual([
      { viewClosed: false, notifierSettled: false },
    ])
    expect(lifecycle.events).toEqual(['attempt-1', 'notifier-settle', 'view-close'])
    expect(lifecycle.settle).toHaveBeenCalledTimes(1)
    expect(lifecycle.close).toHaveBeenCalledTimes(1)
    const outputSchema = z.object(runOutputShape)
    expect(outputSchema.parse(result.payload)).toMatchObject({
      attempts: 1,
      resumeReasons: [],
    })
    expect(
      outputSchema.safeParse({ ...result.payload, resumeReasons: ['unexpected-reason'] }).success,
    ).toBe(false)
  })

  test('resumes a transient turn failure and returns the successful attempt', async () => {
    const runFn = makeRunFn([
      turnFailureOutcome('stream disconnected unexpectedly'),
      successOutcome(),
    ])
    const makeRunId = makeRunIds('run-1', 'run-2')

    const { result, runIds } = await withCapturedMetricRunIds(() => {
      return runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
        ...BASE_RECOVERY,
        sandbox: 'read-only',
        model: 'gpt-5.1-codex',
        reasoningEffort: 'low',
        makeRunId,
      })
    })

    const [resumeArgs, resumeOptions] = runFn.mock.calls[1]
    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({
      status: 'success',
      runId: 'run-2',
      attempts: 2,
      resumeReasons: ['transient-turn-failure'],
    })
    expect(resumeArgs.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID])
    expect(resumeArgs).toContain('sandbox_mode="read-only"')
    expect(resumeArgs).toContain('gpt-5.1-codex')
    expect(resumeArgs).toContain('model_reasoning_effort="low"')
    expect(resumeOptions.stdinInput).toBe(buildResumePrompt('transient-turn-failure'))
    expect(makeRunId).toHaveBeenCalledTimes(2)
    expect(runIds).toEqual(['run-1', 'run-2'])
  })

  test('keeps shared sinks open across resumes and settles them once after the final attempt', async () => {
    // Arrange
    const lifecycle = makeSinkLifecycle()
    const runFn = makeRunFn(
      [turnFailureOutcome('stream disconnected unexpectedly'), successOutcome()],
      lifecycle.recordAttempt,
    )

    // Act
    const result = await runWithRecovery(
      {
        ...makeDeps(runFn),
        view: lifecycle.view,
        progressNotifier: lifecycle.progressNotifier,
      },
      INITIAL_INVOCATION,
      RUN_OPTIONS,
      { ...BASE_RECOVERY, makeRunId: makeRunIds('run-1', 'run-2') },
    )

    // Assert
    expect(result.payload.status).toBe('success')
    expect(lifecycle.attemptStates).toEqual([
      { viewClosed: false, notifierSettled: false },
      { viewClosed: false, notifierSettled: false },
    ])
    expect(lifecycle.events).toEqual([
      'attempt-1',
      'attempt-2',
      'notifier-settle',
      'view-close',
    ])
    expect(lifecycle.settle).toHaveBeenCalledTimes(1)
    expect(lifecycle.close).toHaveBeenCalledTimes(1)
  })

  test('delimits attempts so resumed progress survives a truncated prior line', async () => {
    // Arrange
    const notifications: string[] = []
    const progressNotifier = createProgressNotifier(
      (message) => notifications.push(message),
      0,
    )
    let attempt = 0
    const runFn = vi.fn(
      async (
        _args: string[],
        options: Omit<RunOptions, 'spawnFn'>,
      ): Promise<RunOutcomeWithEvents> => {
        attempt += 1
        if (attempt === 1) {
          options.onStdout?.(Buffer.from('{"type":"item.completed","item":'))
          return turnFailureOutcome('stream disconnected unexpectedly')
        }
        options.onStdout?.(
          Buffer.from(
            `${eventStream({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'resumed output' },
            })}\n`,
          ),
        )
        return successOutcome()
      },
    )

    // Act
    const result = await runWithRecovery(
      { ...makeDeps(runFn), progressNotifier },
      INITIAL_INVOCATION,
      RUN_OPTIONS,
      { ...BASE_RECOVERY, makeRunId: makeRunIds('run-1', 'run-2') },
    )

    // Assert
    expect(result.payload.status).toBe('success')
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain('resumed output')
  })

  test('shares the initial workspace snapshot across recovery attempts', async () => {
    const runFn = makeRunFn([
      turnFailureOutcome('stream disconnected unexpectedly'),
      successOutcome(),
    ])
    const snapshot: WorkspaceSnapshot = { fileHashes: {} }
    const snapshotFn = vi.fn(async (): Promise<WorkspaceSnapshot> => snapshot)
    const attributeFn = vi.fn(
      async (
        _cwd: string,
        receivedSnapshot: WorkspaceSnapshot | null,
      ): Promise<RunAttribution> => ({
        files: [
          {
            path: 'created-during-attempt-1.ts',
            status: '??',
            attribution: receivedSnapshot === snapshot ? 'changedByRun' : 'preExisting',
          },
        ],
        untracked: [],
      }),
    )

    const result = await runWithRecovery(
      { ...makeDeps(runFn), snapshotFn, attributeFn },
      INITIAL_INVOCATION,
      RUN_OPTIONS,
      {
        ...BASE_RECOVERY,
        makeRunId: makeRunIds('run-1', 'run-2'),
      },
    )

    expect(snapshotFn).toHaveBeenCalledTimes(1)
    expect(attributeFn.mock.calls.map(([, receivedSnapshot]) => receivedSnapshot)).toEqual([
      snapshot,
      snapshot,
    ])
    expect(result.payload.attribution?.files[0]?.attribution).toBe('changedByRun')
  })

  test('resumes once after a timeout and returns the successful attempt', async () => {
    const runFn = makeRunFn([timeoutOutcome(), successOutcome()])

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      makeRunId: makeRunIds('run-1', 'run-2'),
    })

    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({
      status: 'success',
      attempts: 2,
      resumeReasons: ['timeout'],
    })
    expect(runFn.mock.calls[1][0].slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID])
  })

  test('stops after the timeout resume cap and returns the final failure', async () => {
    const runFn = makeRunFn([timeoutOutcome(), timeoutOutcome()])

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      makeRunId: makeRunIds('run-1', 'run-2'),
    })

    expect(result.isError).toBe(true)
    expect(result.payload).toMatchObject({
      status: 'failed',
      timedOut: true,
      attempts: 2,
      resumeReasons: ['timeout'],
    })
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  test('does not resume a non-transient turn failure', async () => {
    const runFn = makeRunFn([turnFailureOutcome('test assertion failed')])
    const sleepFn = vi.fn(async () => {})

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      sleepFn,
      makeRunId: makeRunIds('run-1'),
    })

    expect(result.isError).toBe(true)
    expect(result.payload).toMatchObject({
      status: 'failed',
      attempts: 1,
      resumeReasons: [],
    })
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  test('does not resume an aborted run', async () => {
    const runFn = makeRunFn([abortedOutcome()])
    const sleepFn = vi.fn(async () => {})

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      sleepFn,
      makeRunId: makeRunIds('run-1'),
    })

    expect(result.isError).toBe(true)
    expect(result.payload).toMatchObject({
      status: 'aborted',
      attempts: 1,
      resumeReasons: [],
    })
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  test('does not resume when recovery is disabled', async () => {
    const runFn = makeRunFn([turnFailureOutcome('network connection reset')])
    const sleepFn = vi.fn(async () => {})

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      enabled: false,
      sleepFn,
      makeRunId: makeRunIds('run-1'),
    })

    expect(result.payload).toMatchObject({ attempts: 1, resumeReasons: [] })
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  test('uses the policy backoff sequence for two resumes', async () => {
    const runFn = makeRunFn([
      turnFailureOutcome('stream disconnected'),
      turnFailureOutcome('service temporarily unavailable'),
      successOutcome(),
    ])
    const sleepFn = vi.fn(async () => {})

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      sleepFn,
      makeRunId: makeRunIds('run-1', 'run-2', 'run-3'),
    })

    expect(sleepFn.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 8_000])
    expect(result.payload).toMatchObject({
      attempts: 3,
      resumeReasons: ['transient-turn-failure', 'transient-turn-failure'],
    })
  })

  test('stops without another attempt when aborted during recovery backoff', async () => {
    const controller = new AbortController()
    const runFn = makeRunFn([turnFailureOutcome('stream disconnected')])
    const sleepFn = vi.fn((): Promise<void> => {
      controller.abort()
      return new Promise<void>(() => {})
    })

    const result = await runWithRecovery(
      makeDeps(runFn),
      INITIAL_INVOCATION,
      { ...RUN_OPTIONS, signal: controller.signal },
      {
        ...BASE_RECOVERY,
        sleepFn,
        makeRunId: makeRunIds('run-1'),
      },
    )

    expect(result.payload).toMatchObject({ attempts: 1, resumeReasons: [] })
    expect(runFn).toHaveBeenCalledTimes(1)
  })

  test('resumes a partial run without a completion marker', async () => {
    const runFn = makeRunFn([partialOutcome(), successOutcome()])

    const result = await runWithRecovery(makeDeps(runFn), INITIAL_INVOCATION, RUN_OPTIONS, {
      ...BASE_RECOVERY,
      makeRunId: makeRunIds('run-1', 'run-2'),
    })

    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({
      attempts: 2,
      resumeReasons: ['no-completion-marker'],
    })
  })
})
