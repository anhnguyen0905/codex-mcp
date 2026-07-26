import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_CLOSE_DELAY_MS,
  MAX_TERMINAL_CLOSE_DELAY_MS,
  TERMINAL_CLOSE_DELAY_ENV,
  TERMINAL_KEEP_OPEN_ENV,
  TERMINAL_TTY_ENV,
  buildCloseWindowLaunch,
  closeTerminalWindow,
  decideTerminalClose,
  isSafeTtyPath,
  resolveCloseDelayMs,
} from '../src/terminalCloser.js'

const safeTty = '/dev/ttys003'

describe('resolveCloseDelayMs', () => {
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

  test.each(['abc', '-5'])('returns the default for invalid delay %j', (raw) => {
    const delayMs = resolveCloseDelayMs({ [TERMINAL_CLOSE_DELAY_ENV]: raw })

    expect(delayMs).toBe(DEFAULT_TERMINAL_CLOSE_DELAY_MS)
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

describe('buildCloseWindowLaunch', () => {
  test('builds the exact osascript argv for darwin', () => {
    const launch = buildCloseWindowLaunch('darwin', { tty: safeTty, delayMs: 4000 })

    expect(launch).toEqual({
      command: 'osascript',
      args: [
        '-e',
        'delay 4',
        '-e',
        'tell application "Terminal" to close (every window whose selected tab\'s tty is "/dev/ttys003") saving no',
      ],
    })
  })

  test.each(['win32', 'linux', 'aix'] as const)('returns null on %s', (platform) => {
    const launch = buildCloseWindowLaunch(platform, { tty: safeTty, delayMs: 4000 })

    expect(launch).toBeNull()
  })

  test('returns null before interpolating an unsafe tty', () => {
    const launch = buildCloseWindowLaunch('darwin', { tty: '/dev/ttys0$(id)', delayMs: 4000 })

    expect(launch).toBeNull()
  })
})

describe('closeTerminalWindow', () => {
  test('spawns a detached osascript, attaches an error listener, and unreferences it', () => {
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    const spawnFn = vi.fn(() => child)

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'darwin' },
      { spawnFn: spawnFn as never },
    )

    expect(closed).toBe(true)
    expect(spawnFn).toHaveBeenCalledWith(
      'osascript',
      [
        '-e',
        'delay 4',
        '-e',
        'tell application "Terminal" to close (every window whose selected tab\'s tty is "/dev/ttys003") saving no',
      ],
      { stdio: 'ignore', detached: true },
    )
    expect(child.unref).toHaveBeenCalledOnce()
    expect(() => child.emit('error', new Error('ENOENT: osascript missing'))).not.toThrow()
  })

  test('returns false without spawning when the launch is unsupported', () => {
    const spawnFn = vi.fn()

    const closed = closeTerminalWindow(
      { tty: safeTty, delayMs: 4000, platform: 'linux' },
      { spawnFn: spawnFn as never },
    )

    expect(closed).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false and does not rethrow when spawn throws', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn blew up')
    })

    let closed: boolean | undefined
    expect(() => {
      closed = closeTerminalWindow(
        { tty: safeTty, delayMs: 4000, platform: 'darwin' },
        { spawnFn: spawnFn as never },
      )
    }).not.toThrow()
    expect(closed).toBe(false)
  })
})
