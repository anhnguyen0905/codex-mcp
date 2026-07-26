import { spawn } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'
import { TERMINAL_CLOSE_DELAY_ENV, TERMINAL_KEEP_OPEN_ENV } from '../src/terminalCloser.js'

const TAIL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tail-progress.mjs')
const EXIT_TIMEOUT_MS = 10_000
const MARKER_DELAY_MS = 300

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface WatcherResult {
  code: number | null
  stderr: string
  stdout: string
}

/** Spawn the watcher against `logPath` and resolve with its exit code (bounded by a hard kill). */
const runWatcher = (
  logPath: string,
  env: NodeJS.ProcessEnv = {},
  tailScript = TAIL_SCRIPT,
): { done: Promise<WatcherResult> } => {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== TERMINAL_KEEP_OPEN_ENV && key !== TERMINAL_CLOSE_DELAY_ENV,
    ),
  )
  const child = spawn(process.execPath, [tailScript, logPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inheritedEnv, ...env },
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  const done = new Promise<WatcherResult>((resolve, reject) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `watcher did not exit within ${EXIT_TIMEOUT_MS}ms; stdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    }, EXIT_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ code, stderr, stdout })
    })
    child.on('error', (error) => {
      clearTimeout(killTimer)
      reject(error)
    })
  })
  return { done }
}

describe('tail-progress watcher auto-exit', () => {
  test('records a Darwin close command and exits 0 for a completed marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    const closeCommandLogPath = join(dir, 'close-command.json')
    writeFileSync(logPath, '{"type":"thread.started","thread_id":"sess-1"}\n')

    const watcher = runWatcher(logPath, {
      CODEX_MCP_TERMINAL_CLOSE_DELAY_MS: '2500',
      CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
      CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
      CODEX_TAIL_TEST_PLATFORM: 'darwin',
    })
    // Let the watcher start following before the run "settles".
    await new Promise((resolve) => setTimeout(resolve, MARKER_DELAY_MS))
    appendFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: 'sess-1' })}\n`,
    )

    const { code, stderr, stdout } = await watcher.done
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('(run completed — closing this window in 2.5s…)')
    expect(JSON.parse(readFileSync(closeCommandLogPath, 'utf8'))).toEqual({
      command: 'osascript',
      args: [
        '-e',
        'delay 2.5',
        '-e',
        'tell application "Terminal" to if (count of tabs of window id 3845) is 1 then close window id 3845 saving no',
      ],
    })
  })

  test('prints the old watcher line instead of the countdown when closing fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: null })}\n`,
    )

    const { code, stdout } = await runWatcher(logPath, {
      CODEX_MCP_TERMINAL_CLOSE_DELAY_MS: '2500',
      CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
      CODEX_TAIL_CLOSE_CMD_LOG: dir,
      CODEX_TAIL_TEST_PLATFORM: 'darwin',
    }).done

    expect(code).toBe(0)
    expect(stdout).toContain('(run finished — closing watcher)')
    expect(stdout).not.toContain('(run completed — closing this window in 2.5s…)')
  })

  test.each([
    ['Linux', 'linux'],
    ['Windows', 'win32'],
  ] as const)(
    'does not record a close command for a completed marker on the %s test platform',
    async (_label, platform) => {
      const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
      tempDirs.push(dir)
      const logPath = join(dir, 'run.jsonl')
      const closeCommandLogPath = join(dir, 'close-command.json')
      writeFileSync(
        logPath,
        `${JSON.stringify({
          type: LIVE_RUN_FINISHED_TYPE,
          status: 'completed',
          sessionId: 'sess-unsupported-platform',
        })}\n`,
      )

      const { code, stdout } = await runWatcher(logPath, {
        CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
        CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
        CODEX_TAIL_TEST_PLATFORM: platform,
      }).done

      expect(code).toBe(0)
      expect(stdout).toContain('(run finished — closing watcher)')
      expect(existsSync(closeCommandLogPath)).toBe(false)
    },
  )

  test.each(['failed', 'interrupted'] as const)(
    'does not record a close command and exits 0 with the old line for a %s marker',
    async (status) => {
      const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
      tempDirs.push(dir)
      const logPath = join(dir, 'run.jsonl')
      const closeCommandLogPath = join(dir, 'close-command.json')
      writeFileSync(
        logPath,
        `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status, sessionId: null })}\n`,
      )

      const { code, stdout } = await runWatcher(logPath, {
        CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
        CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
        CODEX_TAIL_TEST_PLATFORM: 'darwin',
      }).done

      expect(code).toBe(0)
      expect(stdout).toContain('(run finished — closing watcher)')
      expect(existsSync(closeCommandLogPath)).toBe(false)
    },
  )

  test.each([
    ['missing', { type: LIVE_RUN_FINISHED_TYPE, sessionId: null }],
    ['invalid', { type: LIVE_RUN_FINISHED_TYPE, status: 42, sessionId: null }],
  ])('treats a %s marker status as interrupted', async (_label, marker) => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    const closeCommandLogPath = join(dir, 'close-command.json')
    writeFileSync(logPath, `${JSON.stringify(marker)}\n`)

    const { code, stdout } = await runWatcher(logPath, {
      CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
      CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
      CODEX_TAIL_TEST_PLATFORM: 'darwin',
    }).done

    expect(code).toBe(0)
    expect(stdout).toContain('(run finished — closing watcher)')
    expect(existsSync(closeCommandLogPath)).toBe(false)
  })

  test('does not record a close command when keep-open is enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    const closeCommandLogPath = join(dir, 'close-command.json')
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: null })}\n`,
    )

    const { code, stdout } = await runWatcher(logPath, {
      CODEX_MCP_TERMINAL_KEEP_OPEN: '1',
      CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
      CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
      CODEX_TAIL_TEST_PLATFORM: 'darwin',
    }).done

    expect(code).toBe(0)
    expect(stdout).toContain('(run finished — closing watcher)')
    expect(existsSync(closeCommandLogPath)).toBe(false)
  })

  test('exits 1 via the timeout fallback without recording a close command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    const closeCommandLogPath = join(dir, 'close-command.json')
    writeFileSync(logPath, '{"type":"thread.started","thread_id":"sess-2"}\n')

    const { code, stderr, stdout } = await runWatcher(logPath, {
      CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
      CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
      CODEX_TAIL_TEST_PLATFORM: 'darwin',
      CODEX_TAIL_TIMEOUT_MS: '500',
    }).done

    expect(code).toBe(1)
    expect(stdout, stderr).toContain('giving up')
    expect(existsSync(closeCommandLogPath)).toBe(false)
  })

  test('tails and exits 0 when dist imports fail in an unbuilt checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const scriptsDir = join(dir, 'scripts')
    const tailScript = join(scriptsDir, 'tail-progress.mjs')
    const logPath = join(dir, 'run.jsonl')
    const closeCommandLogPath = join(dir, 'close-command.json')
    mkdirSync(scriptsDir)
    copyFileSync(TAIL_SCRIPT, tailScript)
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: null })}\n`,
    )

    const { code, stdout } = await runWatcher(
      logPath,
      {
        CODEX_MCP_TERMINAL_TTY: '/dev/ttys999',
        CODEX_TAIL_CLOSE_CMD_LOG: closeCommandLogPath,
        CODEX_TAIL_TEST_PLATFORM: 'darwin',
      },
      tailScript,
    ).done

    expect(code).toBe(0)
    expect(stdout).toContain('(run finished — closing watcher)')
    expect(existsSync(closeCommandLogPath)).toBe(false)
  })
})
