import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_CLOSE_DELAY_MS,
  MAX_TERMINAL_CLOSE_DELAY_MS,
  RESOLVE_WINDOW_ID_TIMEOUT_MS,
  TERMINAL_CLOSE_DELAY_ENV,
  TERMINAL_KEEP_OPEN_ENV,
  TERMINAL_TTY_ENV,
  buildCloseWindowLaunch,
  buildResolveWindowIdLaunch,
  buildWatcherEnvExports,
  closeTerminalWindow,
  decideTerminalClose,
  isSafeTtyPath,
  isSafeWindowId,
  resolveCloseDelayMs,
} from '../src/terminalCloser.js'

const safeTty = '/dev/ttys003'

describe('resolveCloseDelayMs', () => {
  test('pins the default and maximum delay constants', () => {
    expect(DEFAULT_TERMINAL_CLOSE_DELAY_MS).toBe(4000)
    expect(MAX_TERMINAL_CLOSE_DELAY_MS).toBe(60_000)
  })

  test('returns the default when the delay is absent', () => {
    const delayMs = resolveCloseDelayMs({})

    expect(delayMs).toBe(DEFAULT_TERMINAL_CLOSE_DELAY_MS)
  })

  test('preserves a configured zero delay', () => {
    const delayMs = resolveCloseDelayMs({ [TERMINAL_CLOSE_DELAY_ENV]: '0' })

    expect(delayMs).toBe(0)
  })

  test('clamps a delay above the maximum', () => {
    const delayMs = resolveCloseDelayMs({ [TERMINAL_CLOSE_DELAY_ENV]: '999999' })

    expect(delayMs).toBe(MAX_TERMINAL_CLOSE_DELAY_MS)
  })

  test.each(['abc', '-5', '1000ms', '1.5'])('returns the default for invalid delay %j', (raw) => {
    const delayMs = resolveCloseDelayMs({ [TERMINAL_CLOSE_DELAY_ENV]: raw })

    expect(delayMs).toBe(DEFAULT_TERMINAL_CLOSE_DELAY_MS)
  })

  test('uses a configured digits-only delay', () => {
    const delayMs = resolveCloseDelayMs({ [TERMINAL_CLOSE_DELAY_ENV]: '9000' })

    expect(delayMs).toBe(9000)
  })
})

describe('buildWatcherEnvExports', () => {
  test('emits both allowlisted watcher config values', () => {
    const exports = buildWatcherEnvExports({
      [TERMINAL_KEEP_OPEN_ENV]: '1',
      [TERMINAL_CLOSE_DELAY_ENV]: '9000',
      UNRELATED: 'ignored',
    })

    expect(exports).toBe(
      `export ${TERMINAL_KEEP_OPEN_ENV}=1\nexport ${TERMINAL_CLOSE_DELAY_ENV}=9000`,
    )
  })

  test.each(['true', 'yes', '0', '', '1 '])(
    'does not emit keep-open for non-allowlisted value %j',
    (value) => {
      const exports = buildWatcherEnvExports({ [TERMINAL_KEEP_OPEN_ENV]: value })

      expect(exports).toBe('')
    },
  )

  test.each(['9000ms', '-1', '1e4', '9 000', 'abc', '9000\n'])(
    'does not emit a delay for non-digits value %j',
    (value) => {
      const exports = buildWatcherEnvExports({ [TERMINAL_CLOSE_DELAY_ENV]: value })

      expect(exports).toBe('')
    },
  )

  test('returns an empty prefix when neither value qualifies', () => {
    const exports = buildWatcherEnvExports({
      [TERMINAL_KEEP_OPEN_ENV]: 'yes',
      [TERMINAL_CLOSE_DELAY_ENV]: '-1',
    })

    expect(exports).toBe('')
  })
})

describe('isSafeTtyPath', () => {
  test.each(['/dev/ttys003', '/dev/pts/3'])('accepts allowlisted tty path %j', (tty) => {
    expect(isSafeTtyPath(tty)).toBe(true)
  })

  test.each([
    '/dev/ttys0"3',
    '/dev/ttys0$(id)',
    '/dev/ttys0`id`',
    '/dev/tty s003',
    '/dev/ttys0\n…',
    '/etc/passwd',
  ])('refuses unsafe tty path %j', (tty) => {
    expect(isSafeTtyPath(tty)).toBe(false)
  })
})

describe('isSafeWindowId', () => {
  test('accepts a digits-only window id', () => {
    expect(isSafeWindowId('3845')).toBe(true)
  })

  test.each([
    '',
    undefined,
    '38 45',
    '-1',
    '3845; do shell script "id"',
    '0x1',
    '3845"',
    '3845\n',
  ])('refuses unsafe window id %j', (windowId) => {
    expect(isSafeWindowId(windowId)).toBe(false)
  })
})

describe('decideTerminalClose', () => {
  test('closes a completed run on darwin with a safe tty', () => {
    const decision = decideTerminalClose({
      status: 'completed',
      platform: 'darwin',
      env: { [TERMINAL_TTY_ENV]: safeTty },
    })

    expect(decision).toEqual({
      close: true,
      reason: 'run completed',
      delayMs: DEFAULT_TERMINAL_CLOSE_DELAY_MS,
    })
  })

  test.each(['failed', 'interrupted'] as const)('does not close a %s run', (status) => {
    const decision = decideTerminalClose({
      status,
      platform: 'darwin',
      env: { [TERMINAL_TTY_ENV]: safeTty },
    })

    expect(decision.close).toBe(false)
    expect(decision.reason).toBe(`run status is ${status}`)
  })

  test.each(['win32', 'linux'] as const)('does not close on %s', (platform) => {
    const decision = decideTerminalClose({
      status: 'completed',
      platform,
      env: { [TERMINAL_TTY_ENV]: safeTty },
    })

    expect(decision.close).toBe(false)
    expect(decision.reason).toBe(`platform ${platform} is not supported`)
  })

  test('does not close when CODEX_MCP_TERMINAL_KEEP_OPEN is 1', () => {
    const decision = decideTerminalClose({
      status: 'completed',
      platform: 'darwin',
      env: {
        [TERMINAL_TTY_ENV]: safeTty,
        [TERMINAL_KEEP_OPEN_ENV]: '1',
      },
    })

    expect(decision.close).toBe(false)
    expect(decision.reason).toBe('terminal auto-close is disabled')
  })

  test('does not close when the tty is absent', () => {
    const decision = decideTerminalClose({
      status: 'completed',
      platform: 'darwin',
      env: {},
    })

    expect(decision.close).toBe(false)
    expect(decision.reason).toBe('terminal tty is missing or unsafe')
  })

  test.each([
    '/dev/ttys0"3',
    '/dev/ttys0$(id)',
    '/dev/ttys0`id`',
    '/dev/tty s003',
    '/dev/ttys0\n…',
    '/etc/passwd',
  ])('does not close for unsafe tty %j', (tty) => {
    const decision = decideTerminalClose({
      status: 'completed',
      platform: 'darwin',
      env: { [TERMINAL_TTY_ENV]: tty },
    })

    expect(decision.close).toBe(false)
    expect(decision.reason).toBe('terminal tty is missing or unsafe')
  })
})

describe('buildResolveWindowIdLaunch', () => {
  test('builds the exact osascript argv for darwin', () => {
    const launch = buildResolveWindowIdLaunch('darwin', safeTty)

    expect(launch).toEqual({
      command: 'osascript',
      args: [
        '-e',
        'tell application "Terminal" to get id of first window whose selected tab\'s tty is "/dev/ttys003"',
      ],
    })
  })

  test.each(['win32', 'linux'] as const)('returns null on %s', (platform) => {
    const launch = buildResolveWindowIdLaunch(platform, safeTty)

    expect(launch).toBeNull()
  })

  test('returns null before interpolating an unsafe tty', () => {
    const launch = buildResolveWindowIdLaunch('darwin', '/dev/ttys0$(id)')

    expect(launch).toBeNull()
  })
})

describe('buildCloseWindowLaunch', () => {
  test('builds the exact osascript argv for darwin', () => {
    const launch = buildCloseWindowLaunch('darwin', { windowId: '3845', delayMs: 4000 })

    expect(launch).toEqual({
      command: 'osascript',
      args: [
        '-e',
        'delay 4',
        '-e',
        'tell application "Terminal" to if (count of tabs of window id 3845) is 1 then close window id 3845 saving no',
      ],
    })
  })

  test.each(['win32', 'linux'] as const)('returns null on %s', (platform) => {
    const launch = buildCloseWindowLaunch(platform, { windowId: '3845', delayMs: 4000 })

    expect(launch).toBeNull()
  })

  test('returns null before interpolating an unsafe window id', () => {
    const launch = buildCloseWindowLaunch('darwin', {
      windowId: '3845; do shell script "id"',
      delayMs: 4000,
    })

    expect(launch).toBeNull()
  })
})

describe('closeTerminalWindow', () => {
  test('resolves the window id and spawns a detached closer by id', () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const spawnFn = vi.fn(() => child)
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: '3845\n' }))

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(true)
    expect(RESOLVE_WINDOW_ID_TIMEOUT_MS).toBe(5000)
    expect(spawnSyncFn).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'tell application "Terminal" to get id of first window whose selected tab\'s tty is "/dev/ttys003"',
      ],
      { encoding: 'utf8', timeout: RESOLVE_WINDOW_ID_TIMEOUT_MS },
    )
    expect(spawnFn).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'delay 4',
        '-e',
        'tell application "Terminal" to if (count of tabs of window id 3845) is 1 then close window id 3845 saving no',
      ],
      { stdio: 'ignore', detached: true },
    )
    expect(child.unref).toHaveBeenCalledOnce()
    expect(() => child.emit('error', new Error('ENOENT: osascript missing'))).not.toThrow()
  })

  test('returns false without spawning when the launch is unsupported', () => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn()

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'linux' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnSyncFn).not.toHaveBeenCalled()
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false without spawning when the resolve probe exits non-zero', () => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn(() => ({ status: 1, stdout: '3845\n' }))

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test.each([
    [
      'reports a timeout error with otherwise valid output',
      { status: 0, stdout: '3845\n', error: new Error('ETIMEDOUT') },
    ],
    ['is terminated by a signal', { status: null, signal: 'SIGTERM', stdout: '3845\n' }],
    ['returns null stdout', { status: 0, stdout: null }],
    ['returns undefined stdout', { status: 0, stdout: undefined }],
    ['returns whitespace-only stdout', { status: 0, stdout: '   \n\t ' }],
  ])('returns false without spawning when the resolve probe %s', (_label, result) => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn(() => result)

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false without spawning when the resolve probe returns no result', () => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn(() => undefined)

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test.each(['', 'not-a-number'])(
    'returns false without spawning when the resolve probe stdout is %j',
    (stdout) => {
      const spawnFn = vi.fn()
      const spawnSyncFn = vi.fn(() => ({ status: 0, stdout }))

      const closed = closeTerminalWindow(
        { tty: safeTty, delayMs: 4000, platform: 'darwin' },
        { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
      )

      expect(closed).toBe(false)
      expect(spawnFn).not.toHaveBeenCalled()
    },
  )

  test('returns false without spawning when the resolve probe throws', () => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn(() => {
      throw new Error('probe blew up')
    })

    let closed: boolean | undefined
    expect(() => {
      closed = closeTerminalWindow(
        { tty: safeTty, delayMs: 4000, platform: 'darwin' },
        { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
      )
    }).not.toThrow()
    expect(closed).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false without probing or spawning when the tty is unsafe', () => {
    const spawnFn = vi.fn()
    const spawnSyncFn = vi.fn()

    const closed = closeTerminalWindow(
      { tty: '/dev/ttys0$(id)', delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnSyncFn).not.toHaveBeenCalled()
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false and does not rethrow when the detached spawn throws', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn blew up')
    })
    const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: '3845\n' }))

    let closed: boolean | undefined
    expect(() => {
      closed = closeTerminalWindow(
        { tty: safeTty, delayMs: 4000, platform: 'darwin' },
        { spawnFn: spawnFn as never, spawnSyncFn: spawnSyncFn as never },
      )
    }).not.toThrow()
    expect(closed).toBe(false)
  })
})
