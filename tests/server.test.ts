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

    expect(names).toEqual([
      'codex_batch',
      'codex_continue',
      'codex_execute',
      'codex_health',
      'codex_metrics',
      'codex_review',
      'codex_sessions',
    ])
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

  test('delivers the prompt over stdin with a `-` argv marker (execute)', async () => {
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })

    const [args, opts] = runFn.mock.calls[0]
    expect(args.slice(-2)).toEqual(['--', '-'])
    expect(args).not.toContain('implement plan')
    expect(opts.stdinInput).toBe('implement plan')
  })

  test('delivers the prompt over stdin with a `-` argv marker (continue)', async () => {
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 'sess-1', prompt: 'fix findings', cwd: '/repo' },
    })

    const [args, opts] = runFn.mock.calls[0]
    expect(args.slice(-2)).toEqual(['--', '-'])
    expect(args).not.toContain('fix findings')
    expect(opts.stdinInput).toBe('fix findings')
  })

  test('rejects a prompt over the 5MB stdin limit with a clean validation error', async () => {
    const client = await connect(runFn)
    const oversized = 'a'.repeat(5 * 1024 * 1024 + 1)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: oversized, cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(result.isError).toBe(true)
    expect(payload.error).toMatch(/5MB/i)
    expect(runFn).not.toHaveBeenCalled()
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

  test('codex_health does not claim logged-in when the login probe timed out', async () => {
    runFn
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false })
      // login probe hung/killed: text looks logged-in but the run itself did not succeed
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: null, timedOut: true })
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_health', arguments: {} })
    const payload = parsePayload(result)

    expect(payload.loggedIn).toBe(false)
  })
})

describe('run status model', () => {
  let runFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runFn = vi.fn(async () => okOutcome)
  })

  test('a clean run with a completion marker reports schemaVersion 1 and status success', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(result.isError).toBe(false)
    expect(payload.schemaVersion).toBe(1)
    expect(payload.status).toBe('success')
    expect(payload.sawCompletion).toBe(true)
    expect(payload.parseErrors).toBe(0)
    expect(payload.unknownEvents).toBe(0)
  })

  test('an empty stdout with exit code 0 yields status partial, never a clean success', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('partial')
    expect(payload.sawCompletion).toBe(false)
    // The Claude reviewer decides next steps — partial is NOT a tool error.
    expect(result.isError).toBe(false)
  })

  test('parse errors in the stream downgrade an otherwise clean run to partial', async () => {
    runFn.mockResolvedValueOnce({
      stdout: `not json\n${jsonlFixture}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('partial')
    expect(payload.parseErrors).toBe(1)
    expect(result.isError).toBe(false)
  })

  test('unknown event types are surfaced but do not downgrade success', async () => {
    runFn.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ type: 'mystery.event' })}\n${jsonlFixture}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('success')
    expect(payload.unknownEvents).toBe(1)
  })

  test('raw-tail truncation is informational when the parser saw the full stream', async () => {
    // The runner's parser is lossless; a rotated raw tail alone must not mark the run partial.
    runFn.mockResolvedValueOnce({
      stdout: '(raw tail rotated)',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: true,
      parsed: {
        sessionId: 'sess-t',
        agentMessage: 'done',
        fileChanges: [],
        commands: [],
        usage: null,
        errors: [],
        parseErrors: 0,
        unknownEvents: 0,
        sawCompletion: true,
        warnings: [],
        turnCount: 1,
      },
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('success')
    expect(payload.outputTruncated).toBe(true)
    expect(result.isError).toBe(false)
  })

  test('non-zero exit reports status failed with isError true', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('failed')
    expect(result.isError).toBe(true)
  })

  test('a Codex-emitted turn failure reports status failed even with exit code 0', async () => {
    runFn.mockResolvedValueOnce({
      stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'model exploded' } }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('failed')
    expect(result.isError).toBe(true)
  })

  test('an aborted run reports status aborted with isError true', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.status).toBe('aborted')
    expect(result.isError).toBe(true)
  })

  test('codex_continue and codex_review results also carry the status model', async () => {
    const client = await connect(runFn)

    const cont = parsePayload(
      await client.callTool({
        name: 'codex_continue',
        arguments: { sessionId: 'sess-1', prompt: 'fix', cwd: '/repo' },
      }),
    )
    const review = parsePayload(
      await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } }),
    )

    expect(cont.schemaVersion).toBe(1)
    expect(cont.status).toBe('success')
    expect(review.schemaVersion).toBe(1)
    expect(review.status).toBe('success')
  })

  test('prefers the runner-parsed event stream over re-parsing stdout when provided', async () => {
    runFn.mockResolvedValueOnce({
      stdout: '', // raw tail empty — the parser result is the source of truth
      stderr: '',
      exitCode: 0,
      timedOut: false,
      parsed: {
        sessionId: 'sess-streamed',
        agentMessage: 'streamed done',
        fileChanges: [],
        commands: [],
        usage: null,
        errors: [],
        parseErrors: 0,
        unknownEvents: 0,
        sawCompletion: true,
        warnings: [],
        turnCount: 1,
      },
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const payload = parsePayload(result)

    expect(payload.sessionId).toBe('sess-streamed')
    expect(payload.agentMessage).toBe('streamed done')
    expect(payload.status).toBe('success')
  })
})
