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

const connect = async (
  runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>,
) => {
  const server = createServer({ runFn, diffFn: async () => null })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>

const textPayload = (result: ToolResult): unknown =>
  JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text)

describe('structured tool results (T4.4)', () => {
  let runFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runFn = vi.fn(async () => okOutcome)
  })

  test('codex_execute result carries structuredContent deep-equal to the text block', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })

    expect(result.structuredContent).toBeDefined()
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('codex_continue result carries structuredContent deep-equal to the text block', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 'sess-1', prompt: 'fix findings', cwd: '/repo' },
    })

    expect(result.structuredContent).toBeDefined()
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('codex_review result carries structuredContent deep-equal to the text block', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })

    expect(result.structuredContent).toBeDefined()
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('codex_batch result carries structuredContent deep-equal to the text block', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })

    expect(result.structuredContent).toBeDefined()
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('codex_health result carries structuredContent deep-equal to the text block', async () => {
    runFn
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_health', arguments: {} })

    expect(result.structuredContent).toBeDefined()
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('the text block stays byte-identical to plain JSON.stringify(payload, null, 2)', async () => {
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0].text

    expect(text).toBe(JSON.stringify(result.structuredContent, null, 2))
  })

  test('registers an outputSchema for execute/continue/review/batch/health', async () => {
    const client = await connect(runFn)

    const { tools } = await client.listTools()
    const withSchema = tools
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name)
      .sort()

    expect(withSchema).toEqual(
      expect.arrayContaining(['codex_batch', 'codex_continue', 'codex_execute', 'codex_health', 'codex_review']),
    )
  })

  test('a failed run result still carries matching structuredContent', async () => {
    runFn.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'implement plan', cwd: '/repo' },
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(textPayload(result))
  })

  test('validation errors still return the plain text error payload', async () => {
    const client = await connect(runFn)
    const oversized = 'a'.repeat(5 * 1024 * 1024 + 1)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: oversized, cwd: '/repo' },
    })

    expect(result.isError).toBe(true)
    expect((textPayload(result) as { error: string }).error).toMatch(/5MB/i)
  })
})
