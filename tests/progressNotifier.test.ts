import { describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProgressNotifier } from '../src/progressNotifier.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const sessionLine = JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' })
const messageLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } })

describe('createProgressNotifier', () => {
  test('emits one formatted message per meaningful JSONL line', () => {
    const sent: Array<{ message: string; progress: number }> = []
    const sink = createProgressNotifier((message, progress) => sent.push({ message, progress }))

    sink(Buffer.from(`${sessionLine}\n${messageLine}\n`))

    expect(sent).toHaveLength(2)
    expect(sent[0].message).toContain('session started: sess-1')
    expect(sent[0].progress).toBe(1)
    expect(sent[1].message).toContain('hello')
    expect(sent[1].progress).toBe(2)
  })

  test('handles a line split across multiple chunks', () => {
    const sent: string[] = []
    const sink = createProgressNotifier((message) => sent.push(message))
    const half = Math.floor(sessionLine.length / 2)

    sink(Buffer.from(sessionLine.slice(0, half)))
    sink(Buffer.from(`${sessionLine.slice(half)}\n`))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('sess-1')
  })

  test('skips unparseable and irrelevant lines', () => {
    const sent: string[] = []
    const sink = createProgressNotifier((message) => sent.push(message))

    sink(Buffer.from('not json\n{"type":"item.started"}\n'))

    expect(sent).toHaveLength(0)
  })
})

describe('server progress notification wiring', () => {
  test('streams progress to the client when a progressToken is provided', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      opts.onStdout?.(Buffer.from(`${sessionLine}\n${messageLine}\n`))
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const messages: string[] = []
    await client.callTool(
      { name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } },
      undefined,
      {
        onprogress: (progress) => {
          if (progress.message) messages.push(progress.message)
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(messages.some((message) => message.includes('sess-1'))).toBe(true)
    expect(messages.some((message) => message.includes('hello'))).toBe(true)
  })

  test('does not stream progress when no progressToken is provided', async () => {
    const seenSinks: Array<((c: Buffer) => void) | undefined> = []
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      seenSinks.push(opts.onStdout)
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })

    expect(seenSinks[0]).toBeUndefined()
  })
})
