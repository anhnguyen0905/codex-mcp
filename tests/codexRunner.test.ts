import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { MAX_OUTPUT_BYTES, resolveCodexBinary, runCodex } from '../src/codexRunner.js'

describe('resolveCodexBinary', () => {
  test('uses plain "codex" on posix platforms', () => {
    expect(resolveCodexBinary('darwin', {})).toBe('codex')
    expect(resolveCodexBinary('linux', {})).toBe('codex')
  })

  test('uses "codex.cmd" on win32 so spawn finds the npm shim without a shell', () => {
    expect(resolveCodexBinary('win32', {})).toBe('codex.cmd')
  })

  test('honors the CODEX_BIN env override on any platform', () => {
    expect(resolveCodexBinary('win32', { CODEX_BIN: 'C:\\tools\\codex.exe' })).toBe('C:\\tools\\codex.exe')
    expect(resolveCodexBinary('darwin', { CODEX_BIN: '/opt/codex' })).toBe('/opt/codex')
  })

  test('ignores an empty CODEX_BIN override', () => {
    expect(resolveCodexBinary('win32', { CODEX_BIN: '  ' })).toBe('codex.cmd')
  })
})

interface FakeProcessOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
  delayMs?: number
}

const makeFakeSpawn = (options: FakeProcessOptions) => {
  const { stdout = '', stderr = '', exitCode = 0, delayMs = 0 } = options
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
    setTimeout(() => {
      if (killed.value) return
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', exitCode)
    }, delayMs)
    return child
  })
  return { spawnFn, killed }
}

describe('runCodex', () => {
  test('captures stdout, stderr and exit code', async () => {
    const { spawnFn } = makeFakeSpawn({ stdout: 'out', stderr: 'err', exitCode: 0 })

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result).toEqual({
      stdout: 'out',
      stderr: 'err',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      truncated: false,
    })
  })

  test('invokes codex binary with given args, cwd and ignored stdin', async () => {
    const { spawnFn } = makeFakeSpawn({ exitCode: 0 })

    await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(spawnFn).toHaveBeenCalledWith(
      resolveCodexBinary(process.platform, process.env),
      ['exec', 'hi'],
      expect.objectContaining({ cwd: '/repo', stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })

  test('reports non-zero exit codes', async () => {
    const { spawnFn } = makeFakeSpawn({ exitCode: 1, stderr: 'boom' })

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('boom')
  })

  test('kills the process and flags timedOut when timeout elapses', async () => {
    const { spawnFn, killed } = makeFakeSpawn({ stdout: 'never', delayMs: 5000 })

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo', timeoutMs: 20 })

    expect(result.timedOut).toBe(true)
    expect(killed.value).toBe(true)
  })

  test('rejects when the process cannot be spawned', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => child.emit('error', new Error('ENOENT')), 0)
      return child
    })

    await expect(runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })).rejects.toThrow('ENOENT')
  })
})

/** Fake spawn that emits the given stdout buffers as separate 'data' events, then closes. */
const makeChunkedSpawn = (stdoutChunks: Buffer[]) => {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: string) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', null)
    setTimeout(() => {
      for (const chunk of stdoutChunks) child.stdout.emit('data', chunk)
      child.emit('close', 0)
    }, 0)
    return child
  })
}

describe('runCodex output cap', () => {
  test('a single chunk larger than the cap is sliced to exactly MAX_OUTPUT_BYTES and flagged truncated', async () => {
    const oversized = Buffer.alloc(MAX_OUTPUT_BYTES + 1024 * 1024, 0x61) // 11MB of 'a'
    const spawnFn = makeChunkedSpawn([oversized])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES)
    expect(result.truncated).toBe(true)
  })

  test('chunks totaling under the cap are kept intact and not flagged truncated', async () => {
    const spawnFn = makeChunkedSpawn([Buffer.from('hello '), Buffer.from('world')])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.stdout).toBe('hello world')
    expect(result.truncated).toBe(false)
  })

  test('a chunk landing exactly on the cap boundary keeps every byte and is not truncated', async () => {
    const exact = Buffer.alloc(MAX_OUTPUT_BYTES, 0x61)
    const spawnFn = makeChunkedSpawn([exact])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES)
    expect(result.truncated).toBe(false)
  })

  test('a chunk arriving after the cap is filled is dropped and flagged truncated', async () => {
    const exact = Buffer.alloc(MAX_OUTPUT_BYTES, 0x61)
    const spawnFn = makeChunkedSpawn([exact, Buffer.from('tail')])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES)
    expect(result.stdout).not.toContain('tail')
    expect(result.truncated).toBe(true)
  })
})
