import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const jsonlFixture = [
  JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }),
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'file_change', changes: [{ path: '/repo/a.ts', kind: 'add' }] },
  }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  }),
].join('\n')

const okOutcome: RunOutcome = { stdout: jsonlFixture, stderr: '', exitCode: 0, timedOut: false }

const connect = async (runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>) => {
  const server = createServer({ runFn })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const parsePayload = (result: Awaited<ReturnType<Client['callTool']>>) => {
  const content = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0].text)
}

describe('codex-mcp server', () => {
  let runFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runFn = vi.fn(async () => okOutcome)
  })

  test('lists the four expected tools', async () => {
    const client = await connect(runFn)

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()

    expect(names).toEqual(['codex_continue', 'codex_execute', 'codex_health', 'codex_review', 'codex_sessions'])
  })

  test('codex_execute runs codex and returns a structured result', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.sessionId).toBe('sess-1')
    expect(payload.agentMessage).toBe('done')
    expect(payload.fileChanges).toEqual([{ path: '/repo/a.ts', kind: 'add' }])
    expect(payload.exitCode).toBe(0)
    expect(runFn).toHaveBeenCalledWith(
      expect.arrayContaining(['exec', '--cd', '/repo']),
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  test('codex_execute defaults to workspace-write sandbox', async () => {
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })

    const [args] = runFn.mock.calls[0]
    expect(args).toContain('workspace-write')
  })

  test('codex_continue resumes the given session', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 'sess-1', prompt: 'fix findings', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.sessionId).toBe('sess-1')
    const [args] = runFn.mock.calls[0]
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sess-1'])
  })

  test('marks result as error when codex exits non-zero', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: 'auth expired', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(result.isError).toBe(true)
    expect(payload.exitCode).toBe(1)
    expect(payload.stderr).toContain('auth expired')
  })

  test('marks result as error on timeout', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, timedOut: true })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo', timeoutMs: 60000 },
    })
    const payload = parsePayload(result)

    expect(result.isError).toBe(true)
    expect(payload.timedOut).toBe(true)
  })

  test('rejects invalid sandbox values', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'x', cwd: '/repo', sandbox: 'full-yolo' },
    })

    expect(result.isError).toBe(true)
  })

  test('uses the live view factory and streams stdout when terminal is requested', async () => {
    const chunks: string[] = []
    let closed = false
    const view = {
      onStdout: (chunk: Buffer) => chunks.push(chunk.toString()),
      close: () => {
        closed = true
      },
      logPath: '/repo/.codex-flow/live/run.jsonl',
    }
    const factory = vi.fn(() => view)
    // runFn echoes a chunk through the provided onStdout to prove wiring.
    const streamingRun = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }) => {
      opts.onStdout?.(Buffer.from(jsonlFixture))
      return okOutcome
    })
    const server = createServer({ runFn: streamingRun as never, liveViewFactory: factory })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'go', cwd: '/repo', terminal: true },
    })
    const payload = parsePayload(result)

    expect(factory).toHaveBeenCalledWith('/repo')
    expect(chunks.join('')).toContain('sess-1')
    expect(closed).toBe(true)
    expect(payload.liveLog).toBe('/repo/.codex-flow/live/run.jsonl')
  })

  test('does not open a live view when terminal is not requested', async () => {
    const factory = vi.fn()
    const server = createServer({ runFn: runFn as never, liveViewFactory: factory as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })

    expect(factory).not.toHaveBeenCalled()
  })

  test('codex_health reports version and login status', async () => {
    runFn
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_health', arguments: {} })
    const payload = parsePayload(result)

    expect(payload.version).toContain('0.144.1')
    expect(payload.loggedIn).toBe(true)
  })
})
