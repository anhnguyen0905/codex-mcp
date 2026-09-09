import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test, vi } from 'vitest'
import { createServer, MODEL_GUARD_MESSAGE } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const okJsonl = (id: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: id }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `done ${id}` } }),
  ].join('\n')

const connect = async (
  runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>,
) => {
  const server = createServer({ runFn, diffFn: async () => null })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

interface BatchSummary {
  total: number
  succeeded: number
  failed: number
  aborted: number
  partial: number
}

const parse = (
  r: Awaited<ReturnType<Client['callTool']>>,
): { tasks: Array<Record<string, unknown>>; total: number; failed: number; summary: BatchSummary } =>
  JSON.parse((r.content as Array<{ text: string }>)[0].text)

describe('codex_batch tool', () => {
  test('runs N tasks in parallel across N cwds, results in input order', async () => {
    const cwds = ['/w/1', '/w/2', '/w/3']
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }) => ({
      stdout: okJsonl(`sess-${opts.cwd.slice(-1)}`),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: { tasks: cwds.map((cwd) => ({ cwd, prompt: 'go' })) },
    })
    const payload = parse(r)

    expect(payload.total).toBe(3)
    expect(payload.failed).toBe(0)
    expect(payload.tasks.map((t) => (t as { cwd: string }).cwd)).toEqual(cwds)
    expect(payload.tasks.map((t) => (t as { taskIndex: number }).taskIndex)).toEqual([0, 1, 2])
  })

  test('surfaces recovery metadata on a batch task after a transient auto-resume', async () => {
    const previousAutoResume = process.env.CODEX_MCP_AUTO_RESUME
    delete process.env.CODEX_MCP_AUTO_RESUME
    const successOutcome: RunOutcome = {
      stdout: [okJsonl('batch-recovery'), JSON.stringify({ type: 'turn.completed', usage: {} })].join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }
    const runFn = vi.fn(async (): Promise<RunOutcome> => successOutcome)
    runFn.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'batch-recovery' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })

    try {
      const client = await connect(runFn)
      const result = await client.callTool({
        name: 'codex_batch',
        arguments: { tasks: [{ cwd: '/w/recovery', prompt: 'recover' }] },
      })
      const payload = parse(result)

      expect(payload.tasks[0]).toMatchObject({
        attempts: 2,
        resumeReasons: ['transient-turn-failure'],
      })
      expect(payload.tasks[0].parsed).not.toHaveProperty('attempts')
      expect(payload.tasks[0].parsed).not.toHaveProperty('resumeReasons')
      expect(runFn).toHaveBeenCalledTimes(2)
    } finally {
      if (previousAutoResume === undefined) delete process.env.CODEX_MCP_AUTO_RESUME
      else process.env.CODEX_MCP_AUTO_RESUME = previousAutoResume
    }
  })

  test('one task failing does not sink siblings (failFast=false default)', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      if (opts.cwd === '/w/2') return { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }
      return { stdout: okJsonl('ok'), stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
          { cwd: '/w/3', prompt: 'c' },
        ],
      },
    })
    const payload = parse(r)

    expect(payload.total).toBe(3)
    expect(payload.failed).toBe(1)
    expect(payload.tasks[1].isError).toBe(true)
    expect(payload.tasks[0].isError).toBe(false)
    expect(payload.tasks[2].isError).toBe(false)
    // T4.6: with failFast=false the batch itself executed, so the tool result is NOT an error —
    // per-task isError/status carries the failure so sibling successes stay visible.
    expect(r.isError).toBe(false)
    // Sibling fixtures carry no turn.completed marker, so they classify as partial, not success.
    expect(payload.summary).toEqual({ total: 3, succeeded: 0, failed: 1, aborted: 0, partial: 2 })
    expect(payload.tasks[1].status).toBe('failed')
  })

  test('failFast=true: the tool result is an error when the triggering task failed', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      if (opts.cwd === '/w/2') return { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }
      return { stdout: okJsonl('ok'), stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
          { cwd: '/w/3', prompt: 'c' },
        ],
        maxConcurrency: 1,
        failFast: true,
      },
    })
    const payload = parse(r)

    expect(r.isError).toBe(true)
    expect(payload.tasks[1].status).toBe('failed')
    expect(payload.summary.failed).toBe(1)
    // The task after the failure never started — cancelled by fail-fast.
    expect(payload.tasks[2].status).toBe('aborted')
    expect(payload.tasks[2]).toMatchObject({ attempts: 0, resumeReasons: [] })
  })

  test('failFast=false with every task failing still reports tool-level isError=false', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }))
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })
    const payload = parse(r)

    expect(r.isError).toBe(false)
    expect(payload.summary).toEqual({ total: 2, succeeded: 0, failed: 2, aborted: 0, partial: 0 })
  })

  test('summary counts partial task statuses', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      // exit 0 without a completion marker → partial
      if (opts.cwd === '/w/2') return { stdout: okJsonl('mid'), stderr: '', exitCode: 0, timedOut: false }
      const completed = [okJsonl('done'), JSON.stringify({ type: 'turn.completed', usage: {} })].join('\n')
      return { stdout: completed, stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })
    const payload = parse(r)

    expect(payload.summary).toEqual({ total: 2, succeeded: 1, failed: 0, aborted: 0, partial: 1 })
  })

  test('batch progress notifications carry task attribution', async () => {
    const runFn = vi.fn(
      async (_args: string[], opts: { cwd: string; onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
        opts.onStdout?.(Buffer.from(`${okJsonl(`sess-${opts.cwd}`)}\n`))
        return { stdout: okJsonl(`sess-${opts.cwd}`), stderr: '', exitCode: 0, timedOut: false }
      },
    )
    const client = await connect(runFn)
    const messages: string[] = []
    const progressValues: number[] = []

    await client.callTool(
      {
        name: 'codex_batch',
        arguments: {
          tasks: [
            { cwd: '/w/1', prompt: 'a' },
            { cwd: '/w/2', prompt: 'b' },
          ],
        },
      },
      undefined,
      {
        onprogress: (p) => {
          if (typeof p.message === 'string') messages.push(p.message)
          progressValues.push(p.progress)
        },
      },
    )

    expect(messages.length).toBeGreaterThan(0)
    expect(messages.some((m) => m.includes('[task 0 /w/1]'))).toBe(true)
    expect(messages.some((m) => m.includes('[task 1 /w/2]'))).toBe(true)
    // Progress must stay monotonic across interleaved tasks.
    const sorted = [...progressValues].sort((a, b) => a - b)
    expect(progressValues).toEqual(sorted)
  })

  test('surfaces outputTruncated on each task result when a run reports truncated output', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      if (opts.cwd === '/w/1') {
        return { stdout: okJsonl('trunc'), stderr: '', exitCode: 0, timedOut: false, truncated: true }
      }
      return { stdout: okJsonl('ok'), stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })
    const payload = parse(r)

    expect(payload.tasks[0].outputTruncated).toBe(true)
    expect(payload.tasks[1].outputTruncated).toBe(false)
  })

  test('each task result carries schemaVersion and a derived status', async () => {
    const completed = [
      okJsonl('done'),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n')
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      if (opts.cwd === '/w/1') return { stdout: completed, stderr: '', exitCode: 0, timedOut: false }
      if (opts.cwd === '/w/2') return { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }
      // exit 0 but no completion marker → partial
      return { stdout: okJsonl('mid'), stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
          { cwd: '/w/3', prompt: 'c' },
        ],
      },
    })
    const payload = parse(r)

    expect(payload.tasks.map((t) => t.schemaVersion)).toEqual([1, 1, 1])
    expect(payload.tasks.map((t) => t.status)).toEqual(['success', 'failed', 'partial'])
    expect(payload.tasks.map((t) => t.isError)).toEqual([false, true, false])
  })

  test('batch tasks deliver their prompt over stdin', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: okJsonl('s'), stderr: '', exitCode: 0, timedOut: false }))
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_batch',
      arguments: { tasks: [{ cwd: '/w/1', prompt: 'the batch prompt' }] },
    })

    const [args, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    expect(args.slice(-2)).toEqual(['--', '-'])
    expect(opts.stdinInput).toBe('the batch prompt')
  })

  test('forwards reasoning effort from the parsed batch task spec', async () => {
    const completed = [
      okJsonl('reasoning'),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n')
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: completed,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [{ cwd: '/w/reasoning', prompt: 'the batch prompt', reasoningEffort: 'xhigh' }],
      },
    })
    const [args] = runFn.mock.calls[0]
    const reasoningFlagIndex = args.indexOf('-c')

    expect(args.slice(reasoningFlagIndex, reasoningFlagIndex + 2)).toEqual([
      '-c',
      'model_reasoning_effort="xhigh"',
    ])
  })

  test('rejects duplicate cwds up front', async () => {
    const runFn = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) as RunOutcome)
    const client = await connect(runFn)

    const r = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/dup', prompt: 'a' },
          { cwd: '/w/dup', prompt: 'b' },
        ],
      },
    })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)
    expect(r.isError).toBe(true)
    expect(payload.error).toMatch(/duplicate cwd/i)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('respects maxConcurrency', async () => {
    let inflight = 0
    let peak = 0
    const runFn = vi.fn(async (_args: string[], opts: { cwd: string }): Promise<RunOutcome> => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return { stdout: okJsonl(`s-${opts.cwd}`), stderr: '', exitCode: 0, timedOut: false }
    })
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: Array.from({ length: 8 }, (_, i) => ({ cwd: `/w/${i}`, prompt: 'x' })),
        maxConcurrency: 2,
      },
    })

    expect(peak).toBe(2)
  })

  test('rejects an empty task list at the schema layer', async () => {
    const runFn = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) as RunOutcome)
    const client = await connect(runFn)
    const r = await client.callTool({ name: 'codex_batch', arguments: { tasks: [] } })
    expect(r.isError).toBe(true)
    expect(runFn).not.toHaveBeenCalled()
  })
})

const versionOutcome: RunOutcome = { stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false }

/** Server whose auth mode is already detected as ChatGPT via one real codex_health round-trip. */
const connectChatGptAuth = async () => {
  const runFn = vi.fn(async (args: string[], opts: { cwd: string }) => {
    if (args[0] === '--version') return versionOutcome
    if (args[0] === 'login') {
      return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false } satisfies RunOutcome
    }
    return {
      stdout: [okJsonl(`sess-${opts.cwd.slice(-1)}`), JSON.stringify({ type: 'turn.completed' })].join('\n'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    } satisfies RunOutcome
  })
  const client = await connect(runFn as never)
  await client.callTool({ name: 'codex_health', arguments: {} })
  runFn.mockClear()
  return { client, runFn }
}

describe('codex_batch model guard (R3.2, C2)', () => {
  test('fails only the task that passed a model, without spawning it', async () => {
    // Arrange
    const { client, runFn } = await connectChatGptAuth()

    // Act
    const payload = parse(
      await client.callTool({
        name: 'codex_batch',
        arguments: {
          tasks: [
            { cwd: '/w/1', prompt: 'a', model: 'gpt-5.1-codex' },
            { cwd: '/w/2', prompt: 'b' },
          ],
        },
      }),
    )

    // Assert — one spawn only (the unguarded task); the guarded task is a per-task failure.
    expect(runFn).toHaveBeenCalledTimes(1)
    const [guarded, allowed] = payload.tasks
    expect(guarded.status).toBe('failed')
    expect(guarded.isError).toBe(true)
    expect((guarded.parsed as { errors: string[] }).errors).toEqual([MODEL_GUARD_MESSAGE])
    expect(guarded.error).toBe(MODEL_GUARD_MESSAGE)
    expect(allowed.status).toBe('success')
  })

  test('a guarded task does not make the batch itself an error (failFast default)', async () => {
    // Arrange
    const { client } = await connectChatGptAuth()

    // Act
    const result = await client.callTool({
      name: 'codex_batch',
      arguments: { tasks: [{ cwd: '/w/1', prompt: 'a', model: 'gpt-5.1-codex' }] },
    })

    // Assert — batch-level isError rules are unchanged: per-task status carries the failure.
    expect(result.isError).toBeFalsy()
    expect(parse(result).summary.failed).toBe(1)
  })

  test('failFast still surfaces a guarded task as a batch-level error', async () => {
    // Arrange
    const { client } = await connectChatGptAuth()

    // Act
    const result = await client.callTool({
      name: 'codex_batch',
      arguments: { tasks: [{ cwd: '/w/1', prompt: 'a', model: 'gpt-5.1-codex' }], failFast: true },
    })

    // Assert
    expect(result.isError).toBe(true)
  })
})

describe('codex_batch redactions (R5.2, C4)', () => {
  /** A clean, completed task stream (turn.completed keeps auto-resume out of these tests). */
  const cleanJsonl = (id: string): string =>
    [okJsonl(id), JSON.stringify({ type: 'turn.completed' })].join('\n')

  /** Task output whose agent message leaks a secret. */
  const leakyJsonl = (id: string): string =>
    [
      JSON.stringify({ type: 'thread.started', thread_id: id }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: `key sk-ant-api03-${'A'.repeat(40)}` },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')

  test('forwards each task redactions and totals them on the batch payload', async () => {
    // Arrange
    const client = await connect(async (_args, opts) => ({
      stdout: opts.cwd === '/w/1' ? leakyJsonl('sess-1') : cleanJsonl('sess-2'),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))

    // Act
    const payload = parse(
      await client.callTool({
        name: 'codex_batch',
        arguments: { tasks: [{ cwd: '/w/1', prompt: 'a' }, { cwd: '/w/2', prompt: 'b' }] },
      }),
    ) as unknown as {
      tasks: Array<{ redactions?: number; parsed: { agentMessage: string | null } }>
      redactionsTotal?: number
    }

    // Assert — the adapter keeps the field at task level instead of folding it into `parsed`.
    expect(payload.tasks[0].redactions).toBeGreaterThan(0)
    expect(payload.tasks[0].parsed.agentMessage).not.toContain('sk-ant-api03-')
    expect(payload.tasks[1].redactions).toBeUndefined()
    expect(payload.redactionsTotal).toBe(payload.tasks[0].redactions)
  })

  test('omits redactionsTotal for a clean batch', async () => {
    // Arrange
    const client = await connect(async (_args, opts) => ({
      stdout: cleanJsonl(`sess-${opts.cwd.slice(-1)}`),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))

    // Act
    const payload = parse(
      await client.callTool({ name: 'codex_batch', arguments: { tasks: [{ cwd: '/w/1', prompt: 'a' }] } }),
    )

    // Assert
    expect(payload).not.toHaveProperty('redactionsTotal')
  })
})
