import { describe, expect, test, vi } from 'vitest'
import { buildTerminalLaunch, openTerminal } from '../src/terminal.js'

const paths = { nodeBin: '/usr/bin/node', tailScript: '/tools/tail.mjs', logPath: '/logs/a b.jsonl' }

describe('buildTerminalLaunch', () => {
  test('darwin launches osascript running Terminal.app', () => {
    const launch = buildTerminalLaunch('darwin', paths)
    expect(launch?.command).toBe('osascript')
    const joined = launch?.args.join(' ') ?? ''
    expect(joined).toContain('do script')
    expect(joined).toContain('/tools/tail.mjs')
    expect(joined).toContain('/logs/a b.jsonl')
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

  test('returns null on unsupported platforms', () => {
    expect(buildTerminalLaunch('linux', paths)).toBeNull()
    expect(buildTerminalLaunch('aix', paths)).toBeNull()
  })
})

describe('openTerminal', () => {
  test('spawns the launch command on a supported platform', () => {
    const spawnFn = vi.fn(() => ({ unref: () => {} }))

    const opened = openTerminal('/logs/a.jsonl', {
      platform: 'darwin',
      nodeBin: '/usr/bin/node',
      tailScript: '/tools/tail.mjs',
      spawnFn: spawnFn as never,
    })

    expect(opened).toBe(true)
    expect(spawnFn).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object))
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
})
