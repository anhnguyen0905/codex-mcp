import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test, vi } from 'vitest'
import { parseEvents } from '../src/eventParser.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const line = (value: unknown): string => JSON.stringify(value)

const connect = async (runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>) => {
  const server = createServer({ runFn })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('parseEvents edge cases', () => {
  test('defaults missing fields on file changes and commands', () => {
    const jsonl = [
      line({ type: 'item.completed', item: { type: 'file_change', changes: [{}] } }),
      line({ type: 'item.completed', item: { type: 'command_execution' } }),
      line({ type: 'item.completed', item: { type: 'agent_message' } }),
      line({ type: 'item.completed', item: { type: 'error' } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.fileChanges).toEqual([{ path: '', kind: 'unknown' }])
    expect(result.commands).toEqual([{ command: '', exitCode: null }])
    expect(result.agentMessage).toBeNull()
    expect(result.errors).toEqual(['unknown error'])
  })

  test('defaults missing usage fields to zero', () => {
    const result = parseEvents(line({ type: 'turn.completed', usage: {} }))

    expect(result.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    })
  })

  test('handles events with missing payloads', () => {
    const jsonl = [
      line({ type: 'thread.started' }),
      line({ type: 'item.completed' }),
      line({ type: 'turn.completed' }),
      line({ type: 'turn.failed' }),
      line({ type: 'item.completed', item: { type: 'file_change' } }),
      line(42),
      line(null),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.sessionId).toBeNull()
    expect(result.usage).toBeNull()
    expect(result.fileChanges).toEqual([])
    expect(result.errors).toEqual(['turn failed'])
  })
})

describe('server error paths', () => {
  test('codex_execute reports validation errors from the args builder', async () => {
    const runFn = vi.fn()
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'go', cwd: 'not-absolute' },
    })

    expect(result.isError).toBe(true)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('codex_continue reports validation errors for empty session id', async () => {
    const runFn = vi.fn()
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: '  ', prompt: 'go', cwd: '/repo' },
    })

    expect(result.isError).toBe(true)
  })

  test('codex_continue surfaces runner failures as tool errors', async () => {
    const runFn = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 'sess-1', prompt: 'go', cwd: '/repo' },
    })

    expect(result.isError).toBe(true)
  })

  test('codex_health surfaces runner failures and non-string errors', async () => {
    const runFn = vi.fn(async () => {
      throw 'codex not installed'
    })
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_health', arguments: {} })

    expect(result.isError).toBe(true)
  })

  test('codex_health reports loggedIn false when not authenticated', async () => {
    const runFn = vi.fn()
    runFn
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: 'Not logged in', stderr: '', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_health', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)

    expect(payload.loggedIn).toBe(false)
  })
})
