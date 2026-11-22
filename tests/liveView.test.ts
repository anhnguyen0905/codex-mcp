import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { createLiveView, defaultLiveRoot, liveDirFor } from '../src/liveView.js'
import { LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'
import { escapeDoubleQuotedShell } from '../src/terminal.js'
import { TERMINAL_CLOSE_DELAY_ENV, TERMINAL_KEEP_OPEN_ENV } from '../src/terminalCloser.js'

const tempDirs: string[] = []
const BENIGN_NOTICE =
  '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** A live view whose terminal launcher is a no-op so tests never open real windows. */
const makeView = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-marker-'))
  const liveRoot = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-root-'))
  tempDirs.push(cwd, liveRoot)
  return createLiveView(cwd, { liveRoot, openTerminalFn: () => true })
}

const makeLiveRoot = (): string => {
  const liveRoot = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-root-'))
  tempDirs.push(liveRoot)
  return liveRoot
}

const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 3000
const TAIL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tail-progress.mjs')

/** Wait for the async WriteStream flush after close(), then return the log's last line parsed. */
const readMarker = async (logPath: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    let content = ''
    try {
      content = readFileSync(logPath, 'utf8')
    } catch {
      // WriteStream creates the file asynchronously — keep polling until the deadline.
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last?.includes(LIVE_RUN_FINISHED_TYPE)) return JSON.parse(last) as Record<string, unknown>
    if (Date.now() > deadline) throw new Error(`no completion marker in ${logPath} after ${POLL_TIMEOUT_MS}ms`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Wait for close() to flush the marker, then return every non-empty raw JSONL line. */
const readLogLines = async (logPath: string): Promise<string[]> => {
  await readMarker(logPath)
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('live log placement', () => {
  test('uses CODEX_MCP_LIVE_DIR for the default root', () => {
    expect(defaultLiveRoot()).toBe(process.env.CODEX_MCP_LIVE_DIR)
  })

  test('writes the log outside the workspace and creates private entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-placement-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const view = createLiveView(cwd, { liveRoot, openTerminalFn: () => true })

    if (!view.logPath) throw new Error('expected a live log path')
    expect(dirname(view.logPath)).toBe(liveDirFor(cwd, liveRoot))
    expect(view.logPath).not.toContain('.codex-flow')
    expect(existsSync(join(cwd, '.codex-flow'))).toBe(false)
    view.close()
    await readMarker(view.logPath)
    if (process.platform !== 'win32') {
      expect(statSync(dirname(view.logPath)).mode & 0o777).toBe(0o700)
      expect(statSync(view.logPath).mode & 0o777).toBe(0o600)
    }
  })

  test('tightens an existing workspace directory to private mode', async () => {
    if (process.platform === 'win32') return
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-mode-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const logDir = liveDirFor(cwd, liveRoot)
    mkdirSync(logDir, { recursive: true })
    chmodSync(logDir, 0o755)

    const view = createLiveView(cwd, { liveRoot, openTerminalFn: () => true })

    if (!view.logPath) throw new Error('expected a live log path')
    expect(statSync(logDir).mode & 0o777).toBe(0o700)
    view.close()
    await readMarker(view.logPath)
  })

  test('uses a suffixed log when the first stamp already exists', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-collision-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const logDir = liveDirFor(cwd, liveRoot)
    mkdirSync(logDir, { recursive: true })
    const now = new Date('2026-11-22T12:34:56.789Z')
    const stamp = `${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    const firstLogPath = join(logDir, `${stamp}.jsonl`)
    writeFileSync(firstLogPath, 'existing\n')

    const view = createLiveView(cwd, {
      liveRoot,
      now: () => now,
      openTerminalFn: () => true,
    })

    expect(view.logPath).toBe(join(logDir, `${stamp}-1.jsonl`))
    expect(readFileSync(firstLogPath, 'utf8')).toBe('existing\n')
    if (!view.logPath) throw new Error('expected a suffixed live log path')
    view.close()
    await readMarker(view.logPath)
  })

  test('degrades to a no-op when live directory realpath verification fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-realpath-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const view = createLiveView(cwd, {
      liveRoot,
      openTerminalFn: () => true,
      realpathSyncFn: () => join(liveRoot, 'unexpected'),
    })

    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
  })

  test('maps different workspaces to different directories and symlinked paths together', () => {
    const root = makeLiveRoot()
    const first = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-workspace-'))
    const second = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-workspace-'))
    const linkParent = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-link-'))
    const link = join(linkParent, 'alias')
    tempDirs.push(first, second, linkParent)
    symlinkSync(first, link)

    expect(liveDirFor(first, root)).not.toBe(liveDirFor(second, root))
    expect(liveDirFor(first, root)).toBe(liveDirFor(link, root))
  })

  test('prunes older workspace entries to at most 20 live entries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-prune-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const logDir = liveDirFor(cwd, liveRoot)
    mkdirSync(logDir, { recursive: true })
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(logDir, `old-${index}.jsonl`), '{}\n')
    }

    const view = createLiveView(cwd, { liveRoot, openTerminalFn: () => true })
    if (!view.logPath) throw new Error('expected a live log path')
    const entriesAfterCreate = readdirSync(logDir).filter(
      (name) => name.endsWith('.jsonl') || name.endsWith('.command'),
    )
    expect(entriesAfterCreate.filter((name) => name.startsWith('old-'))).toHaveLength(20)
    view.close()
    await readMarker(view.logPath)
  })
})

// These tests mock process.platform to 'darwin' but exercise real POSIX fs
// behavior (0o755 permissions, shell metacharacters in temp-dir names) that
// Windows cannot host — they run on the macOS and Linux CI jobs.
describe.skipIf(process.platform === 'win32')('createLiveView macOS command wrapper', () => {
  test('writes the tty export before the escaped exec command with executable permissions', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    const launches: Array<{
      commandFile: string | undefined
      logPath: string
      nodeBin: string
      tailScript: string
      writerPid: number | undefined
    }> = []

    const view = createLiveView(cwd, {
      env: {},
      liveRoot,
      openTerminalFn: (logPath, options) => {
        launches.push({
          commandFile: options.commandFile,
          logPath,
          nodeBin: options.nodeBin,
          tailScript: options.tailScript,
          writerPid: options.writerPid,
        })
        return true
      },
    })

    const launch = launches[0]
    if (!launch?.commandFile) throw new Error('expected a macOS .command wrapper')
    const content = readFileSync(launch.commandFile, 'utf8')
    expect(content).toBe(
      `#!/bin/zsh\nexport CODEX_MCP_TERMINAL_TTY="$(tty)"\nexec "${escapeDoubleQuotedShell(launch.nodeBin)}" "${escapeDoubleQuotedShell(launch.tailScript)}" "${escapeDoubleQuotedShell(launch.logPath)}" ${process.pid}\n`,
    )
    expect(launch.writerPid).toBe(process.pid)
    expect(content.indexOf('export CODEX_MCP_TERMINAL_TTY="$(tty)"')).toBeLessThan(
      content.indexOf('exec '),
    )
    expect(statSync(launch.commandFile).mode & 0o777).toBe(0o755)

    view.close()
    if (!view.logPath) throw new Error('expected a live log path')
    await readMarker(view.logPath)
  })

  test('keeps malicious log-path metacharacters escaped while leaving only tty expansion active', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-cwd-'))
    const liveRoot = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-$(touch pwned)`id`"-'))
    tempDirs.push(cwd, liveRoot)
    const commandFiles: string[] = []

    const view = createLiveView(cwd, {
      env: {},
      liveRoot,
      openTerminalFn: (_logPath, options) => {
        if (options.commandFile) commandFiles.push(options.commandFile)
        return true
      },
    })

    const commandFile = commandFiles[0]
    if (!commandFile) throw new Error('expected a macOS .command wrapper')
    const content = readFileSync(commandFile, 'utf8')
    const execLine = content.split('\n').find((line) => line.startsWith('exec ')) ?? ''
    expect(content).toContain('export CODEX_MCP_TERMINAL_TTY="$(tty)"')
    expect(execLine).toContain('\\$(touch pwned)')
    expect(execLine).toContain('\\`id\\`')
    expect(execLine).toMatch(new RegExp(` ${process.pid}$`))
    expect(execLine).not.toContain('.codex-flow')
    expect(execLine).not.toMatch(/[^\\]\$\(touch pwned\)/)

    view.close()
    if (!view.logPath) throw new Error('expected a live log path')
    await readMarker(view.logPath)
  })

  test('forwards allowlisted watcher config exports between the tty and exec lines', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    let commandFile: string | undefined

    const view = createLiveView(cwd, {
      env: {
        [TERMINAL_KEEP_OPEN_ENV]: '1',
        [TERMINAL_CLOSE_DELAY_ENV]: '9000',
      },
      liveRoot,
      openTerminalFn: (_logPath, options) => {
        commandFile = options.commandFile
        return true
      },
    })

    if (!commandFile) throw new Error('expected a macOS .command wrapper')
    const lines = readFileSync(commandFile, 'utf8').split('\n')
    expect(lines.slice(1, 5)).toEqual([
      'export CODEX_MCP_TERMINAL_TTY="$(tty)"',
      `export ${TERMINAL_KEEP_OPEN_ENV}=1`,
      `export ${TERMINAL_CLOSE_DELAY_ENV}=9000`,
      expect.stringMatching(/^exec /),
    ])

    view.close()
    if (!view.logPath) throw new Error('expected a live log path')
    await readMarker(view.logPath)
  })

  test('omits watcher config exports when neither server-side value is set', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    let commandFile: string | undefined

    const view = createLiveView(cwd, {
      env: {},
      liveRoot,
      openTerminalFn: (_logPath, options) => {
        commandFile = options.commandFile
        return true
      },
    })

    if (!commandFile) throw new Error('expected a macOS .command wrapper')
    const content = readFileSync(commandFile, 'utf8')
    expect(content).not.toContain(TERMINAL_KEEP_OPEN_ENV)
    expect(content).not.toContain(TERMINAL_CLOSE_DELAY_ENV)

    view.close()
    if (!view.logPath) throw new Error('expected a live log path')
    await readMarker(view.logPath)
  })
})

describe('createLiveView completion marker', () => {
  test('writes a completed marker (with sessionId) when the stream saw turn.completed', async () => {
    const view = makeView()
    expect(view.logPath).toBeTruthy()
    view.onStdout?.(Buffer.from('{"type":"thread.started","thread_id":"sess-42"}\n'))
    view.onStdout?.(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":1}}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.type).toBe(LIVE_RUN_FINISHED_TYPE)
    expect(marker.status).toBe('completed')
    expect(marker.sessionId).toBe('sess-42')
  })

  test('writes exactly one marker on a healthy close', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"turn.completed"}\n'))

    view.close()

    if (!view.logPath) throw new Error('expected a live log path')
    const lines = await readLogLines(view.logPath)
    const markers = lines.filter((line) => line.includes(LIVE_RUN_FINISHED_TYPE))
    expect(markers).toHaveLength(1)
    expect(JSON.parse(markers[0] ?? '')).toMatchObject({
      type: LIVE_RUN_FINISHED_TYPE,
      status: 'completed',
    })
  })

  test('writes a failed marker when the stream saw turn.failed', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"turn.failed","error":{"message":"boom"}}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('failed')
  })

  test('writes a completed marker when turn.failed contains an allowlisted notice', async () => {
    const view = makeView()
    view.onStdout?.(
      Buffer.from(
        `${JSON.stringify({ type: 'turn.failed', error: { message: BENIGN_NOTICE } })}\n`,
      ),
    )

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('completed')
  })

  test('writes an interrupted marker when the run settled without a terminal turn event (abort/timeout/kill)', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"thread.started","thread_id":"sess-43"}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('interrupted')
  })

  test('handles a terminal event split across chunk boundaries', async () => {
    const view = makeView()
    const eventLine = '{"type":"turn.completed","usage":{"input_tokens":1}}\n'
    view.onStdout?.(Buffer.from(eventLine.slice(0, 10)))
    view.onStdout?.(Buffer.from(eventLine.slice(10)))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('completed')
  })

  test('appends one completed marker after the stream errors', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-stream-error-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    let stream: ReturnType<typeof createWriteStream> | undefined
    const view = createLiveView(cwd, {
      liveRoot,
      openTerminalFn: () => true,
      createWriteStreamFn: (path, options) => {
        stream = createWriteStream(path, options)
        return stream
      },
    })
    if (!view.logPath || !stream) throw new Error('expected a live log stream')

    stream.emit('error', new Error('simulated stream failure'))
    view.onStdout?.(Buffer.from('{"type":"turn.completed"}\n'))
    view.close()

    const lines = await readLogLines(view.logPath)
    const markers = lines.filter((line) => line.includes(LIVE_RUN_FINISHED_TYPE))
    expect(markers).toHaveLength(1)
    expect(JSON.parse(markers[0] ?? '')).toMatchObject({
      type: LIVE_RUN_FINISHED_TYPE,
      status: 'completed',
    })
    stream.destroy()
  })

  test('appends one marker when the stream errors while end is in flight', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-end-error-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    let stream: ReturnType<typeof createWriteStream> | undefined
    const view = createLiveView(cwd, {
      liveRoot,
      openTerminalFn: () => true,
      createWriteStreamFn: (path, options) => {
        const eventStream = new EventEmitter() as unknown as ReturnType<typeof createWriteStream>
        eventStream.write = () => true
        eventStream.end = function endInFlight() {
          setImmediate(() => this.emit('error', new Error('simulated end failure')))
          return this
        }
        eventStream.destroy = () => eventStream
        stream = eventStream
        return stream
      },
    })
    if (!view.logPath || !stream) throw new Error('expected a live log stream')
    view.onStdout?.(Buffer.from('{"type":"turn.completed"}\n'))

    view.close()

    const lines = await readLogLines(view.logPath)
    const markers = lines.filter((line) => line.includes(LIVE_RUN_FINISHED_TYPE))
    expect(markers).toHaveLength(1)
    expect(JSON.parse(markers[0] ?? '')).toMatchObject({
      type: LIVE_RUN_FINISHED_TYPE,
      status: 'completed',
    })
    stream.destroy()
  })

  test('does not throw when the fallback marker append fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-append-failure-'))
    const liveRoot = makeLiveRoot()
    tempDirs.push(cwd)
    let stream: ReturnType<typeof createWriteStream> | undefined
    const view = createLiveView(cwd, {
      liveRoot,
      openTerminalFn: () => true,
      createWriteStreamFn: (path, options) => {
        stream = createWriteStream(path, options)
        return stream
      },
    })
    if (!view.logPath || !stream) throw new Error('expected a live log stream')

    stream.emit('error', new Error('simulated stream failure'))
    stream.destroy()
    rmSync(dirname(view.logPath), { recursive: true, force: true })

    expect(() => view.close()).not.toThrow()
  })
})

describe('createLiveView event timestamps', () => {
  test('adds a valid ISO receipt timestamp to complete event lines across chunk boundaries', async () => {
    const view = makeView()
    const eventLine = '{"type":"thread.started","thread_id":"sess-timestamp"}\n'
    view.onStdout?.(Buffer.from(eventLine.slice(0, 17)))
    view.onStdout?.(Buffer.from(eventLine.slice(17)))

    view.close()

    if (!view.logPath) throw new Error('expected a live log path')
    const [writtenLine] = await readLogLines(view.logPath)
    const event = JSON.parse(writtenLine ?? '') as Record<string, unknown>
    expect(event.type).toBe('thread.started')
    const timestamp = event.at
    expect(timestamp).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/))
    if (typeof timestamp !== 'string') throw new Error('expected an ISO timestamp')
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false)
  })

  test('writes malformed lines through unchanged', async () => {
    const view = makeView()
    const malformedLine = '{"type":"turn.started",broken}\r'
    view.onStdout?.(Buffer.from(`${malformedLine}\n`))

    view.close()

    if (!view.logPath) throw new Error('expected a live log path')
    const [writtenLine] = await readLogLines(view.logPath)
    expect(writtenLine).toBe(malformedLine)
  })

  test('writes through and resets a partial-line carry that exceeds one MiB', async () => {
    const view = makeView()
    const oversizedPartialLine = 'x'.repeat(1024 * 1024 + 1)
    const completeEvent = '{"type":"turn.completed"}'
    view.onStdout?.(Buffer.from(oversizedPartialLine))
    view.onStdout?.(Buffer.from(`${completeEvent}\n`))

    view.close()

    if (!view.logPath) throw new Error('expected a live log path')
    const lines = await readLogLines(view.logPath)
    expect(lines[0]).toBe(oversizedPartialLine)
    expect(Buffer.byteLength(lines[0] ?? '')).toBe(Buffer.byteLength(oversizedPartialLine))
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ type: 'turn.completed' })
    expect(JSON.parse(lines[lines.length - 1] ?? '')).toMatchObject({
      type: LIVE_RUN_FINISHED_TYPE,
      status: 'completed',
    })
  })

  test('writes the run-finished marker with exactly one timestamp field', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"turn.completed"}\n'))

    view.close()

    if (!view.logPath) throw new Error('expected a live log path')
    const lines = await readLogLines(view.logPath)
    const markerLine = lines.find((line) => line.includes(LIVE_RUN_FINISHED_TYPE))
    if (!markerLine) throw new Error('expected a completion marker')
    expect(markerLine.match(/"at":/g)).toHaveLength(1)
    expect(JSON.parse(markerLine)).toMatchObject({
      type: LIVE_RUN_FINISHED_TYPE,
      status: 'completed',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    })
  })
})

describe('tail-progress event gaps', () => {
  const runTail = (events: ReadonlyArray<Record<string, unknown>>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-gap-'))
    tempDirs.push(cwd)
    const logPath = join(cwd, 'run.jsonl')
    const content = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    writeFileSync(logPath, content)
    return spawnSync(process.execPath, [TAIL_SCRIPT, logPath], {
      encoding: 'utf8',
      env: { ...process.env, [TERMINAL_KEEP_OPEN_ENV]: '1' },
    })
  }

  test('prints the elapsed-time annotation when consecutive event timestamps exceed 30 seconds', () => {
    const result = runTail([
      { type: 'thread.started', thread_id: 'sess-gap', at: '2026-08-14T00:00:00.000Z' },
      { type: 'turn.completed', at: '2026-08-14T00:03:07.000Z' },
      {
        type: LIVE_RUN_FINISHED_TYPE,
        status: 'completed',
        sessionId: 'sess-gap',
        at: '2026-08-14T00:03:07.000Z',
      },
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('… +187s')
  })

  test('accepts legacy events without timestamps without inventing a gap', () => {
    const result = runTail([
      { type: 'thread.started', thread_id: 'sess-legacy', at: '2026-08-14T00:00:00.000Z' },
      { type: 'turn.started' },
      { type: 'turn.completed', at: '2026-08-14T00:03:07.000Z' },
      {
        type: LIVE_RUN_FINISHED_TYPE,
        status: 'completed',
        sessionId: 'sess-legacy',
        at: '2026-08-14T00:03:07.000Z',
      },
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain('… +')
  })
})

describe('createLiveView symlink guard', () => {
  test('refuses a symlinked live root', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-'))
    const rootTarget = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-root-target-'))
    const rootParent = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-root-parent-'))
    const root = join(rootParent, 'live')
    tempDirs.push(cwd, rootTarget, rootParent)
    symlinkSync(rootTarget, root)

    const view = createLiveView(cwd, { liveRoot: root })

    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
    expect(readdirSync(rootTarget)).toHaveLength(0)
  })

  test('refuses a symlinked workspace subdirectory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-'))
    const root = makeLiveRoot()
    const target = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-target-'))
    tempDirs.push(cwd, target)
    const logDir = liveDirFor(cwd, root)
    symlinkSync(target, logDir)

    const view = createLiveView(cwd, { liveRoot: root })

    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
    expect(readdirSync(target)).toHaveLength(0)
  })
})
