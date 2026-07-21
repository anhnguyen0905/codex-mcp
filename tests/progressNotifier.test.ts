import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProgressNotifier, PROGRESS_INTERVAL_MS } from '../src/progressNotifier.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const sessionLine = JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' })
const messageLine = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } })
const agentLine = (text: string): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })

interface Sent {
  message: string
  progress: number
}

describe('createProgressNotifier throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('first event is sent immediately', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message, progress) => sent.push({ message, progress }))

    notifier.sink(Buffer.from(`${sessionLine}\n`))

    expect(sent).toHaveLength(1)
    expect(sent[0].message).toContain('session started: sess-1')
    expect(sent[0].progress).toBe(1)
  })

  test('10 rapid events coalesce to at most a few notifications carrying the latest content', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message, progress) => sent.push({ message, progress }))

    for (let i = 0; i < 10; i++) {
      notifier.sink(Buffer.from(`${agentLine(`msg-${i}`)}\n`))
    }

    // First event flushes immediately; the other nine collapse into one pending update.
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toContain('msg-0')

    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS)

    expect(sent).toHaveLength(2)
    expect(sent[1].message).toContain('msg-9')
    // The monotonic counter still counts every event, not every send.
    expect(sent[1].progress).toBe(10)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('events after the interval elapsed send immediately again', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message) => sent.push({ message, progress: 0 }))

    notifier.sink(Buffer.from(`${agentLine('first')}\n`))
    expect(sent).toHaveLength(1)

    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS)
    notifier.sink(Buffer.from(`${agentLine('second')}\n`))

    expect(sent).toHaveLength(2)
    expect(sent[1].message).toContain('second')
  })

  test('settle flushes the latest pending message immediately and clears the timer', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message, progress) => sent.push({ message, progress }))

    notifier.sink(Buffer.from(`${agentLine('a')}\n${agentLine('b')}\n${agentLine('c')}\n`))
    expect(sent).toHaveLength(1) // 'a' immediate, 'b' collapsed into 'c'

    notifier.settle()

    expect(sent).toHaveLength(2)
    expect(sent[1].message).toContain('c')
    expect(sent[1].progress).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('settle flushes a final unterminated line so the last message is never dropped', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message) => sent.push({ message, progress: 0 }))

    notifier.sink(Buffer.from(agentLine('tail'))) // no trailing newline

    expect(sent).toHaveLength(0)
    notifier.settle()
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toContain('tail')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('settle with nothing pending sends nothing and leaves no timer', () => {
    const sent: Sent[] = []
    const notifier = createProgressNotifier((message) => sent.push({ message, progress: 0 }))

    notifier.sink(Buffer.from(`${agentLine('only')}\n`))
    expect(sent).toHaveLength(1)

    notifier.settle()

    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('handles a line split across multiple chunks', () => {
    const sent: string[] = []
    const notifier = createProgressNotifier((message) => sent.push(message))
    const half = Math.floor(sessionLine.length / 2)

    notifier.sink(Buffer.from(sessionLine.slice(0, half)))
    notifier.sink(Buffer.from(`${sessionLine.slice(half)}\n`))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('sess-1')
  })

  test('skips unparseable and irrelevant lines', () => {
    const sent: string[] = []
    const notifier = createProgressNotifier((message) => sent.push(message))

    notifier.sink(Buffer.from('not json\n{"type":"item.started"}\n'))
    notifier.settle()

    expect(sent).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
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

  test('rapid events coalesce over the wire but the final message always arrives', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      for (let i = 0; i < 10; i++) {
        opts.onStdout?.(Buffer.from(`${agentLine(`msg-${i}`)}\n`))
      }
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

    // 10 rapid events: first flushes immediately, the rest collapse; settle flushes the last.
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.length).toBeLessThanOrEqual(3)
    expect(messages.some((message) => message.includes('msg-9'))).toBe(true)
  })

  test('does not stream progress when no progressToken is provided', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      opts.onStdout?.(Buffer.from(`${sessionLine}\n${messageLine}\n`))
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const notificationMethods: string[] = []
    client.fallbackNotificationHandler = async (notification) => {
      notificationMethods.push(notification.method)
    }
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(notificationMethods.filter((m) => m === 'notifications/progress')).toHaveLength(0)
  })
})
