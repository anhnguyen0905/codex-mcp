import { describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const okOutcome: RunOutcome = { stdout: '', stderr: '', exitCode: 0, timedOut: false }

const connect = async (runFn: unknown) => {
  const server = createServer({ runFn: runFn as never })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}

const parsePayload = (result: { content?: unknown }) => {
  const content = result.content as Array<{ text: string }>
  return JSON.parse(content[0].text)
}

describe('per-cwd concurrency guard', () => {
  test('rejects a second run into the same cwd while one is active', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runFn = vi.fn(async (): Promise<RunOutcome> => {
      await gate
      return okOutcome
    })
    const client = await connect(runFn)

    const first = client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/repo' } })
    const second = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/repo' } })

    expect(second.isError).toBe(true)
    expect(parsePayload(second).error).toMatch(/already active/i)

    release?.()
    const firstResult = await first
    expect(firstResult.isError).toBeFalsy()
  })

  test('releases the guard after a run finishes so the cwd can be reused', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/repo' } })
    const again = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/repo' } })

    expect(again.isError).toBeFalsy()
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  test('releases the guard even when the run fails', async () => {
    const runFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(okOutcome)
    const client = await connect(runFn)

    const failed = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/repo' } })
    expect(failed.isError).toBe(true)

    const retry = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/repo' } })
    expect(retry.isError).toBeFalsy()
  })

  test('allows parallel runs in different cwds', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runFn = vi.fn(async (): Promise<RunOutcome> => {
      await gate
      return okOutcome
    })
    const client = await connect(runFn)

    const first = client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/repo-a' } })
    const second = client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/repo-b' } })
    release?.()
    const [r1, r2] = await Promise.all([first, second])

    expect(r1.isError).toBeFalsy()
    expect(r2.isError).toBeFalsy()
  })

  test('guards codex_continue against a running codex_execute in the same cwd', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runFn = vi.fn(async (): Promise<RunOutcome> => {
      await gate
      return okOutcome
    })
    const client = await connect(runFn)

    const first = client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/repo' } })
    const second = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 's1', prompt: 'b', cwd: '/repo' },
    })

    expect(second.isError).toBe(true)
    release?.()
    await first
  })
})
