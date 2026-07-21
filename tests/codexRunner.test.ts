import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { RAW_STDOUT_TAIL_BYTES, resolveCodexBinary, runCodex } from '../src/codexRunner.js'

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
      parsed: expect.objectContaining({ parseErrors: 1, sawCompletion: false }),
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

describe('runCodex raw stdout tail retention', () => {
  test('a single chunk larger than the tail cap keeps only the LAST RAW_STDOUT_TAIL_BYTES and flags truncated', async () => {
    const oversized = Buffer.concat([
      Buffer.alloc(RAW_STDOUT_TAIL_BYTES, 0x61), // 'a' head that must be dropped
      Buffer.alloc(RAW_STDOUT_TAIL_BYTES, 0x7a), // 'z' tail that must be kept
    ])
    const spawnFn = makeChunkedSpawn([oversized])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(RAW_STDOUT_TAIL_BYTES)
    expect(result.stdout).not.toContain('a')
    expect(result.stdout.endsWith('z')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  test('chunks totaling under the tail cap are kept intact and not flagged truncated', async () => {
    const spawnFn = makeChunkedSpawn([Buffer.from('hello '), Buffer.from('world')])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.stdout).toBe('hello world')
    expect(result.truncated).toBe(false)
  })

  test('a chunk landing exactly on the tail-cap boundary keeps every byte and is not truncated', async () => {
    const exact = Buffer.alloc(RAW_STDOUT_TAIL_BYTES, 0x61)
    const spawnFn = makeChunkedSpawn([exact])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(RAW_STDOUT_TAIL_BYTES)
    expect(result.truncated).toBe(false)
  })

  test('a chunk arriving after the tail is full rotates the tail (newest bytes win) and flags truncated', async () => {
    const exact = Buffer.alloc(RAW_STDOUT_TAIL_BYTES, 0x61)
    const spawnFn = makeChunkedSpawn([exact, Buffer.from('tail')])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(RAW_STDOUT_TAIL_BYTES)
    expect(result.stdout.endsWith('tail')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  test('the parser sees the FULL stream even when the raw tail rotated (lossless JSONL parse)', async () => {
    // Session id arrives first, then enough filler to rotate it out of the raw tail,
    // then the completion marker. The parse must still hold all of it.
    const filler = `${JSON.stringify({ type: 'noise.event', pad: 'x'.repeat(1024) })}\n`.repeat(
      Math.ceil((RAW_STDOUT_TAIL_BYTES * 2) / 1100),
    )
    const spawnFn = makeChunkedSpawn([
      Buffer.from('{"type":"thread.started","thread_id":"early-sess"}\n'),
      Buffer.from(filler),
      Buffer.from('{"type":"turn.completed","usage":{"input_tokens":5}}\n'),
    ])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.truncated).toBe(true)
    expect(result.stdout).not.toContain('early-sess') // rotated out of the raw tail...
    expect(result.parsed?.sessionId).toBe('early-sess') // ...but the parse kept it
    expect(result.parsed?.sawCompletion).toBe(true)
    expect(result.parsed?.parseErrors).toBe(0)
  })
})

describe('runCodex incremental parsing', () => {
  test('exposes the streamed parse on outcome.parsed, joining a JSON line split across chunks', async () => {
    const full = '{"type":"thread.started","thread_id":"stream-1"}\n'
    const spawnFn = makeChunkedSpawn([
      Buffer.from(full.slice(0, 20)),
      Buffer.from(full.slice(20)),
      Buffer.from('{"type":"turn.completed","usage":{"input_tokens":5}}\n'),
    ])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.parsed?.sessionId).toBe('stream-1')
    expect(result.parsed?.sawCompletion).toBe(true)
    expect(result.parsed?.parseErrors).toBe(0)
  })

  test('counts malformed and unknown lines without aborting the run', async () => {
    const spawnFn = makeChunkedSpawn([
      Buffer.from('not json\n{"type":"mystery.event"}\n{"type":"thread.started","thread_id":"x"}\n'),
    ])

    const result = await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(result.parsed?.parseErrors).toBe(1)
    expect(result.parsed?.unknownEvents).toBe(1)
    expect(result.parsed?.sessionId).toBe('x')
    expect(result.parsed?.sawCompletion).toBe(false)
  })
})

/** Fake spawn whose child records stdin writes, for prompt-via-stdin tests. */
const makeStdinSpawn = (options: { exitCode?: number; failStdin?: boolean } = {}) => {
  const { exitCode = 0, failStdin = false } = options
  const written: string[] = []
  const stdinEnded = { value: false }
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: { on: (event: string, handler: (err: Error) => void) => void; end: (data?: string) => void }
      kill: (signal?: string) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    let errorHandler: ((err: Error) => void) | undefined
    child.stdin = {
      on: (event, handler) => {
        if (event === 'error') errorHandler = handler
      },
      end: (data?: string) => {
        stdinEnded.value = true
        if (failStdin) {
          // Child died before reading: Node surfaces EPIPE via the stream 'error' event.
          errorHandler?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
          return
        }
        if (data !== undefined) written.push(data)
      },
    }
    child.kill = () => {}
    setTimeout(() => child.emit('close', exitCode), 0)
    return child
  })
  return { spawnFn, written, stdinEnded }
}

describe('runCodex prompt via stdin', () => {
  test('opens a stdin pipe and delivers stdinInput to the child before ending the stream', async () => {
    const { spawnFn, written, stdinEnded } = makeStdinSpawn()

    await runCodex(['exec', '-'], { spawnFn: spawnFn as never, cwd: '/repo', stdinInput: 'the prompt' })

    expect(spawnFn).toHaveBeenCalledWith(
      expect.anything(),
      ['exec', '-'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )
    expect(written).toEqual(['the prompt'])
    expect(stdinEnded.value).toBe(true)
  })

  test('keeps stdin ignored when no stdinInput is given (legacy argv prompt path)', async () => {
    const { spawnFn } = makeFakeSpawn({ exitCode: 0 })

    await runCodex(['exec', 'hi'], { spawnFn, cwd: '/repo' })

    expect(spawnFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })

  test('an EPIPE from a child that exits early settles via the normal exit path instead of crashing', async () => {
    const { spawnFn } = makeStdinSpawn({ exitCode: 1, failStdin: true })

    const result = await runCodex(['exec', '-'], {
      spawnFn: spawnFn as never,
      cwd: '/repo',
      stdinInput: 'doomed prompt',
    })

    expect(result.exitCode).toBe(1)
  })
})
