import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const jsonlFixture = [
  JSON.stringify({ type: 'thread.started', thread_id: 'sess-metrics' }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 200, reasoning_output_tokens: 5 },
  }),
].join('\n')

const okOutcome: RunOutcome = { stdout: jsonlFixture, stderr: '', exitCode: 0, timedOut: false }

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

let logPath: string
let prevLog: string | undefined

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-int-'))
  tempDirs.push(dir)
  logPath = join(dir, 'metrics.jsonl')
  prevLog = process.env.CODEX_MCP_METRICS_LOG
  process.env.CODEX_MCP_METRICS_LOG = logPath
})

afterAll(() => {
  if (prevLog === undefined) delete process.env.CODEX_MCP_METRICS_LOG
  else process.env.CODEX_MCP_METRICS_LOG = prevLog
})

const connect = async (runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>) => {
  const server = createServer({ runFn, diffFn: async () => null })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}

describe('metrics wiring', () => {
  test('each codex_execute run appends one metric line to the log', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const [e1, e2] = lines.map((l) => JSON.parse(l))
    expect(e1.tool).toBe('codex_execute')
    expect(e1.cwd).toBe('/w/1')
    expect(e1.sessionId).toBe('sess-metrics')
    expect(e1.usage.inputTokens).toBe(100)
    expect(e2.cwd).toBe('/w/2')
  })

  test('codex_metrics returns an aggregate over the log', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.totalRuns).toBe(2)
    expect(payload.failed).toBe(0)
    expect(payload.totalTokens.input).toBe(200) // 100 × 2
    expect(payload.byTool.codex_execute.runs).toBe(2)
    expect(payload.estCostUsd).toBeUndefined() // pricing not set
  })

  test('exit-0 run with parsed errors records errorCount/errorKind and counts as failed', async () => {
    const failedTurnFixture = [
      JSON.stringify({ type: 'thread.started', thread_id: 'sess-turn-failed' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'model refused' } }),
    ].join('\n')
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: failedTurnFixture,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.exitCode).toBe(0)
    expect(line.errorCount).toBe(1)
    expect(line.errorKind).toBe('turn-failed')

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)
    expect(payload.totalRuns).toBe(1)
    expect(payload.failed).toBe(1)
  })

  test('records model, queueMs, and timeToFirstProgressMs on the metric entry', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      opts.onStdout?.(Buffer.from(`${jsonlFixture}\n`))
      return okOutcome
    })
    const client = await connect(runFn as never)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5.1-codex')
    expect(typeof line.queueMs).toBe('number')
    expect(line.queueMs).toBeGreaterThanOrEqual(0)
    expect(typeof line.timeToFirstProgressMs).toBe('number')
    expect(line.timeToFirstProgressMs).toBeGreaterThanOrEqual(0)
  })

  test('omits model when no model was requested; omits timeToFirstProgressMs when no stdout arrived', async () => {
    const runFn = vi.fn(async () => okOutcome) // never calls onStdout
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBeUndefined()
    expect(line.timeToFirstProgressMs).toBeUndefined()
  })

  test('batch tasks record taskId and model per metric entry', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a', model: 'gpt-5.1-codex' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.taskId).sort()).toEqual(['task-0', 'task-1'])
    const task0 = lines.find((l) => l.taskId === 'task-0')
    const task1 = lines.find((l) => l.taskId === 'task-1')
    expect(task0.model).toBe('gpt-5.1-codex')
    expect(task0.tool).toBe('codex_batch')
    expect(task1.model).toBeUndefined()
  })

  test('codex_metrics aggregate includes the per-model breakdown', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })
    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'b', cwd: '/w/2', model: 'gpt-5.1-codex' },
    })

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.byModel['gpt-5.1-codex'].runs).toBe(2)
    expect(payload.byModel['gpt-5.1-codex'].failed).toBe(0)
    expect(payload.byModel['gpt-5.1-codex'].tokens.input).toBe(200)
    // COST_TABLE ships empty: no cost may be claimed for an unpriced model.
    expect(payload.byModel['gpt-5.1-codex'].estimatedCostUsd).toBeUndefined()
    expect(payload.estimatedCostUsd).toBeUndefined()
    expect(payload.avgQueueMs).toBeGreaterThanOrEqual(0)
  })

  test('cwd filter narrows the aggregate', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const r = await client.callTool({ name: 'codex_metrics', arguments: { cwd: '/w/1' } })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.totalRuns).toBe(1)
  })
})
