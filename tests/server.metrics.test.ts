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
