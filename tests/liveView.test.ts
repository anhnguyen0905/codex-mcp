import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { createLiveView } from '../src/liveView.js'
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
  vi.unstubAllEnvs()
})

/** A live view whose terminal launcher is a no-op so tests never open real windows. */
const makeView = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-marker-'))
  tempDirs.push(cwd)
  return createLiveView(cwd, { openTerminalFn: () => true })
}

const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 3000

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

describe('createLiveView macOS command wrapper', () => {
  test('writes the tty export before the escaped exec command with executable permissions', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.stubEnv(TERMINAL_KEEP_OPEN_ENV, undefined)
    vi.stubEnv(TERMINAL_CLOSE_DELAY_ENV, undefined)
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    tempDirs.push(cwd)
    const launches: Array<{
      commandFile: string | undefined
      logPath: string
      nodeBin: string
      tailScript: string
    }> = []

    const view = createLiveView(cwd, {
      openTerminalFn: (logPath, options) => {
        launches.push({
          commandFile: options.commandFile,
          logPath,
          nodeBin: options.nodeBin,
          tailScript: options.tailScript,
        })
        return true
      },
    })

    const launch = launches[0]
    if (!launch?.commandFile) throw new Error('expected a macOS .command wrapper')
    const content = readFileSync(launch.commandFile, 'utf8')
    expect(content).toBe(
      `#!/bin/zsh\nexport CODEX_MCP_TERMINAL_TTY="$(tty)"\nexec "${escapeDoubleQuotedShell(launch.nodeBin)}" "${escapeDoubleQuotedShell(launch.tailScript)}" "${escapeDoubleQuotedShell(launch.logPath)}"\n`,
    )
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
    vi.stubEnv(TERMINAL_KEEP_OPEN_ENV, undefined)
    vi.stubEnv(TERMINAL_CLOSE_DELAY_ENV, undefined)
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-$(touch pwned)`id`"-'))
    tempDirs.push(cwd)
    const commandFiles: string[] = []

    const view = createLiveView(cwd, {
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
    expect(execLine).not.toMatch(/[^\\]\$\(touch pwned\)/)

    view.close()
    if (!view.logPath) throw new Error('expected a live log path')
    await readMarker(view.logPath)
  })

  test('forwards allowlisted watcher config exports between the tty and exec lines', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.stubEnv(TERMINAL_KEEP_OPEN_ENV, '1')
    vi.stubEnv(TERMINAL_CLOSE_DELAY_ENV, '9000')
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    tempDirs.push(cwd)
    let commandFile: string | undefined

    const view = createLiveView(cwd, {
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
    vi.stubEnv(TERMINAL_KEEP_OPEN_ENV, undefined)
    vi.stubEnv(TERMINAL_CLOSE_DELAY_ENV, undefined)
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-command-'))
    tempDirs.push(cwd)
    let commandFile: string | undefined

    const view = createLiveView(cwd, {
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
})

describe('createLiveView symlink guard', () => {
  test('refuses when the nested .codex-flow/live dir is a planted symlink (no write through it)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-'))
    const target = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-target-'))
    tempDirs.push(cwd, target)

    // Simulate a cloned repo with a real .codex-flow/ but `live` committed as a symlink elsewhere.
    mkdirSync(join(cwd, '.codex-flow'))
    symlinkSync(target, join(cwd, '.codex-flow', 'live'))

    const view = createLiveView(cwd)

    // Guard tripped → degraded no-op view, and nothing written through the symlink to the target.
    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
    expect(readdirSync(target)).toHaveLength(0)
  })
})
