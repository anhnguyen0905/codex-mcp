import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { runCodex } from '../src/codexRunner.js'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: string) => void
}

const makeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  return child
}

describe('runCodex hardening', () => {
  test('escalates to SIGKILL when process ignores SIGTERM', async () => {
    const signals: string[] = []
    const child = makeChild()
    child.kill = (signal?: string) => {
      signals.push(signal ?? 'SIGTERM')
      if (signal === 'SIGKILL') child.emit('close', null)
    }
    const spawnFn = vi.fn(() => child)

    const result = await runCodex(['exec', 'hi'], {
      spawnFn: spawnFn as never,
      cwd: '/repo',
      timeoutMs: 10,
      sigkillGraceMs: 10,
    })

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result.timedOut).toBe(true)
  })

  test('rejects and kills the child on stdout stream error', async () => {
    const child = makeChild()
    const kill = vi.fn()
    child.kill = kill
    const spawnFn = vi.fn(() => {
      setTimeout(() => child.stdout.emit('error', new Error('EPIPE')), 0)
      return child
    })

    await expect(
      runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' }),
    ).rejects.toThrow('EPIPE')
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })

  test('rejects on stderr stream error', async () => {
    const child = makeChild()
    const spawnFn = vi.fn(() => {
      setTimeout(() => child.stderr.emit('error', new Error('stream broke')), 0)
      return child
    })

    await expect(
      runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' }),
    ).rejects.toThrow('stream broke')
  })

  test('forwards each stdout chunk to onStdout in real time', async () => {
    const child = makeChild()
    const seen: string[] = []
    const spawnFn = vi.fn(() => {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('line-1\n'))
        child.stdout.emit('data', Buffer.from('line-2\n'))
        child.emit('close', 0)
      }, 0)
      return child
    })

    await runCodex(['exec', 'hi'], {
      spawnFn: spawnFn as never,
      cwd: '/repo',
      onStdout: (chunk) => seen.push(chunk.toString()),
    })

    expect(seen).toEqual(['line-1\n', 'line-2\n'])
  })

  test('stops buffering output beyond the byte cap', async () => {
    const child = makeChild()
    const spawnFn = vi.fn(() => {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.alloc(10 * 1024 * 1024, 'a'))
        child.stdout.emit('data', Buffer.from('OVERFLOW'))
        child.emit('close', 0)
      }, 0)
      return child
    })

    const result = await runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' })

    expect(result.stdout).not.toContain('OVERFLOW')
    expect(result.stdout.length).toBe(10 * 1024 * 1024)
  })
})
