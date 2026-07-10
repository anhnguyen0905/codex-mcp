import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runCodex } from '../src/codexRunner.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const makeHangingSpawn = () => {
  const killed = { value: false }
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: string) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      killed.value = true
      child.emit('close', null)
    }
    return child
  })
  return { spawnFn, killed }
}

describe('runCodex abort support', () => {
  test('kills the process and flags aborted when the signal fires', async () => {
    const { spawnFn, killed } = makeHangingSpawn()
    const controller = new AbortController()

    const pending = runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo', signal: controller.signal })
    controller.abort()
    const result = await pending

    expect(result.aborted).toBe(true)
    expect(killed.value).toBe(true)
  })

  test('resolves aborted without spawning when the signal is already aborted', async () => {
    const { spawnFn } = makeHangingSpawn()
    const controller = new AbortController()
    controller.abort()

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo', signal: controller.signal })

    expect(result.aborted).toBe(true)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('normal completion reports aborted false', async () => {
    const { spawnFn } = makeHangingSpawn()
    const controller = new AbortController()
    const pending = runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo', signal: controller.signal })
    const child = spawnFn.mock.results[0].value as EventEmitter & { stdout: EventEmitter }
    child.stdout.emit('data', Buffer.from('ok'))
    child.emit('close', 0)

    const result = await pending

    expect(result).toMatchObject({ stdout: 'ok', exitCode: 0, aborted: false, timedOut: false })
  })
})

describe('server cancellation wiring', () => {
  test('passes an AbortSignal through to the runner', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const runFn = vi.fn(async (_args: string[], opts: { signal?: AbortSignal }): Promise<RunOutcome> => {
      seen.push(opts.signal)
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })

    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  test('marks the payload as error when the run was aborted', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
    }))
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(result.isError).toBe(true)
    expect(payload.aborted).toBe(true)
  })
})
