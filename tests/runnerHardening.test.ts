import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { RAW_STDOUT_TAIL_BYTES, runCodex } from '../src/codexRunner.js'

const DEATH_POLL_INTERVAL_MS = 25

/** Polls `kill(pid, 0)` until it throws ESRCH (process gone) or the deadline passes. */
const isDeadWithin = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // ESRCH: the process no longer exists
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, DEATH_POLL_INTERVAL_MS))
  }
}

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

  test('retains only the raw stdout tail beyond the cap while later bytes still arrive', async () => {
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

    // Raw retention is tail-only: the NEWEST bytes are kept, old head bytes rotate out.
    expect(result.stdout.endsWith('OVERFLOW')).toBe(true)
    expect(result.stdout.length).toBe(RAW_STDOUT_TAIL_BYTES)
    // Rotation is flagged so callers know the raw field (not the parse) is incomplete.
    expect(result.truncated).toBe(true)
  })

  test('does not flag truncation for output under the cap', async () => {
    const child = makeChild()
    const spawnFn = vi.fn(() => {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('small'))
        child.emit('close', 0)
      }, 0)
      return child
    })

    const result = await runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' })

    expect(result.truncated).toBe(false)
  })

  test('settles shortly after exit even when close never fires (lingering pipe holder)', async () => {
    vi.useFakeTimers()
    try {
      const child = makeChild()
      const kills: string[] = []
      child.kill = (signal?: string) => {
        kills.push(signal ?? 'SIGTERM')
      }
      const spawnFn = vi.fn(() => child)
      const p = runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' })
      child.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"x"}\n'))
      child.emit('exit', 3, null) // process exits, but a descendant keeps the pipe open → no 'close'
      await vi.advanceTimersByTimeAsync(2000) // EXIT_SETTLE_GRACE_MS
      const result = await p
      expect(result.stdout).toContain('thread.started')
      // The real exit code is preserved — lingering pipes must not fake a null (false failure)...
      expect(result.exitCode).toBe(3)
      // ...and the orphaned tree is killed before the settle releases the cwd lock/slot.
      // On Windows the tree kill goes through a real `taskkill` spawn that a pid-less
      // fake child cannot observe (and deliberately skips), so the kill assertion is
      // POSIX-only; the trigger path is identical on both platforms.
      if (process.platform !== 'win32') {
        expect(kills).toContain('SIGKILL')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test.skipIf(process.platform === 'win32')(
    'kills lingering descendants and preserves the real exit code when a grandchild holds the pipe open',
    async () => {
      // Arrange: parent exits 7 immediately, but `sleep` inherits the stdout pipe and lingers.
      const dir = mkdtempSync(join(tmpdir(), 'codex-runner-tree-'))
      const pidFile = join(dir, 'grandchild.pid')
      const script = `sleep 30 & echo $! > "${pidFile}"; echo done; exit 7`
      const spawnFn = ((_cmd: string, _args: string[], opts: object) =>
        spawn('sh', ['-c', script], opts as never)) as never

      // Act
      const result = await runCodex(['exec', 'hi'], {
        spawnFn,
        cwd: dir,
        exitSettleGraceMs: 150,
      })

      // Assert: real exit code survives the forced settle...
      expect(result.exitCode).toBe(7)
      expect(result.stdout).toContain('done')
      // ...and the descendant is dead immediately after settle resolves.
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true)
      expect(await isDeadWithin(grandchildPid, 1000)).toBe(true)
    },
    10_000,
  )

  test('a noisy stderr does not evict or truncate stdout (per-stream byte budgets)', async () => {
    const child = makeChild()
    const spawnFn = vi.fn(() => {
      setTimeout(() => {
        // 10MB of stderr chatter arrives first...
        child.stderr.emit('data', Buffer.alloc(10 * 1024 * 1024, 'e'))
        // ...then the real (tiny) stdout JSONL payload.
        child.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"x"}\n'))
        child.emit('close', 0)
      }, 0)
      return child
    })

    const result = await runCodex(['exec', 'hi'], { spawnFn: spawnFn as never, cwd: '/repo' })

    expect(result.stdout).toContain('thread.started')
    expect(result.truncated).toBe(false) // stdout was never truncated, only stderr was capped
  })
})
