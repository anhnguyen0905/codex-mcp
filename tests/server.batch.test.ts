import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test, vi } from 'vitest'
import { createServer } from '../src/server.js'
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

const parse = (r: Awaited<ReturnType<Client['callTool']>>): { tasks: Array<Record<string, unknown>>; total: number; failed: number } =>
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
    expect(r.isError).toBe(true) // overall tool-result reflects any error
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
