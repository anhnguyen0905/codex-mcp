import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import { STARTUP_BUDGET_MS, STARTUP_PROBE_MARGIN_MS, STARTUP_PROBE_TIMEOUT_MS,
  classifyStartup, countDatalessFiles, probeStartup, resolveLauncher } from '../scripts/startup-probe.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fake = `
import { writeFileSync } from 'node:fs'
const delay = Number(process.argv[2] || 0)
const pidFile = process.argv[3]
if (pidFile) writeFileSync(pidFile, String(process.pid))
let buffer = ''
const names = ['codex_execute', 'codex_continue', 'codex_review', 'codex_batch',
  'codex_sessions', 'codex_metrics', 'codex_health']
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: {} })
    if (message.method === 'tools/list') setTimeout(() => send({
      jsonrpc: '2.0', id: message.id, result: { tools: names.map((name) => ({ name })) },
    }), delay)
  }
})
`

const scriptNames = ['doctor.mjs', 'startup-probe.mjs', 'npm-smoke.mjs', 'session-cost.mjs']
const makeDoctorCopy = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'))
  const scripts = path.join(dir, 'scripts')
  const bin = path.join(dir, 'bin')
  mkdirSync(scripts)
  mkdirSync(bin)
  for (const name of scriptNames) copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name))
  const cliNames = process.platform === 'win32' ? ['codex.cmd', 'claude.cmd'] : ['codex', 'claude']
  for (const name of cliNames) {
    const file = path.join(bin, name)
    writeFileSync(file, process.platform === 'win32' ? '@echo logged in\r\n' : '#!/bin/sh\necho "logged in"\n')
    if (process.platform !== 'win32') chmodSync(file, 0o755)
  }
  return { dir, scripts, doctor: path.join(scripts, 'doctor.mjs') }
}

const runDoctor = (dir, args = []) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'doctor.mjs'), ...args], {
  cwd: dir,
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: [path.join(dir, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
  },
})

describe('startup probe contracts', () => {
  test('reports all dataless scan statuses', () => {
    // Arrange / Act
    const ok = countDatalessFiles('/repo', { platform: 'darwin', run: () => ({ ok: true, output: '/a\n\n/b\n' }) })
    const unsupported = countDatalessFiles('/repo', { platform: 'linux' })
    const failed = countDatalessFiles('/repo', { platform: 'darwin', run: () => ({ ok: false, output: '' }) })
    const throwing = countDatalessFiles('/repo', { platform: 'darwin', run: () => { throw new Error('x') } })
    // Assert
    expect(ok).toEqual({ count: 2, status: 'ok' })
    expect(unsupported).toEqual({ count: null, status: 'unsupported' })
    expect(failed).toEqual({ count: null, status: 'failed' })
    expect(throwing).toEqual({ count: null, status: 'failed' })
  })

  test.each([
    [{ ok: false, elapsedMs: 1 }, { count: 0, status: 'ok' }, 'fail'],
    [{ ok: true, elapsedMs: STARTUP_BUDGET_MS + 1 }, { count: 0, status: 'ok' }, 'warn'],
    [{ ok: true, elapsedMs: 1 }, { count: 1, status: 'ok' }, 'warn'],
    [{ ok: true, elapsedMs: 1 }, { count: null, status: 'failed' }, 'warn'],
    [{ ok: true, elapsedMs: 1 }, { count: null, status: 'unsupported' }, 'ok'],
  ])('classifies startup honestly', (probe, dataless, level) => {
    // Act
    const result = classifyStartup(probe, dataless)
    // Assert
    expect(result.level).toBe(level)
    if (dataless.status === 'failed') expect(result.detail).toContain('scan unavailable')
  })

  test('uses the budget plus margin by default', () => {
    expect(STARTUP_PROBE_TIMEOUT_MS).toBe(STARTUP_BUDGET_MS + STARTUP_PROBE_MARGIN_MS)
  })

  test('returns injected smoke success with injected clock elapsed time', async () => {
    // Arrange
    let now = 100
    const smoke = async ({ spawnOptions }: { spawnOptions: { env?: NodeJS.ProcessEnv } }) => {
      expect(spawnOptions.env).toBeUndefined()
      now = 125
    }
    // Act
    const result = await probeStartup({ smoke, now: () => now })
    // Assert
    expect(result).toEqual({ ok: true, elapsedMs: 25 })
  })

  test('converts injected smoke rejection into a failed result', async () => {
    // Arrange / Act
      const result = await probeStartup({
        smoke: async () => { throw new Error('handshake failed') }, now: () => 10,
      })
    // Assert
    expect(result).toEqual({ ok: false, elapsedMs: 0, error: 'handshake failed', reason: 'error' })
  })

  test.each([
    ['npx', 'win32', 'npx.cmd'], ['npm', 'win32', 'npm.cmd'],
    ['npx', 'darwin', 'npx'], ['npm', 'darwin', 'npm'],
  ])('resolves %s for %s', (command, platform, expected) => {
    // Act
    const result = resolveLauncher({ command, args: ['--flag', 'has spaces'], env: { T8_TEST: 'yes' } }, { platform })
    // Assert
    expect(result.command).toBe(expected)
    expect(result.spawnOptions.env?.T8_TEST).toBe('yes')
    expect(result.args).toEqual(platform === 'win32' ? ['--flag', '"has spaces"'] : ['--flag', 'has spaces'])
  })

  test('leaves arbitrary launchers unchanged without mutating input', () => {
    // Arrange
    const launcher = { command: 'custom', args: ['arg'], env: { T8_TEST: 'yes' } }
    // Act
    const result = resolveLauncher(launcher, { platform: 'win32' })
    // Assert
    expect(result).toEqual({ command: 'custom', args: ['arg'], spawnOptions: { env: { ...process.env, T8_TEST: 'yes' } } })
    expect(launcher).toEqual({ command: 'custom', args: ['arg'], env: { T8_TEST: 'yes' } })
  })

  test('uses different fixes for timeout and launcher failures', () => {
    // Act
    const timeout = classifyStartup({ ok: false, reason: 'timeout', error: 'slow' }, { count: 0, status: 'ok' })
    const exited = classifyStartup({ ok: false, reason: 'exited', error: 'gone' }, { count: 0, status: 'ok' })
    // Assert
    expect(timeout.fix).toContain('cloud-synced')
    expect(exited.fix).toContain('Run the launcher command manually')
  })

  test('never rejects when now throws', async () => {
    const result = await probeStartup({ now: () => { throw new Error('clock failed') } })
    expect(result).toMatchObject({ ok: false, error: 'clock failed' })
  })

  test('measures delay and kills a timed-out real server', async () => {
    // Arrange
    const dir = mkdtempSync(path.join(os.tmpdir(), 'startup-probe-'))
    const server = path.join(dir, 'server.mjs')
    writeFileSync(server, fake)
    try {
      // Act
      const measured = await probeStartup({
        command: process.execPath, args: [server, '80'], timeoutMs: 1000,
      })
      const started = Date.now()
      const pidFile = path.join(dir, 'server.pid')
      const timedOut = await probeStartup({
        command: process.execPath, args: [server, '3000', pidFile], timeoutMs: 1000,
      })
      // Assert
      expect(measured.ok).toBe(true)
      expect(measured.elapsedMs).toBeGreaterThanOrEqual(80)
      expect(timedOut.ok).toBe(false)
      expect(timedOut.reason).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(5000)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { process.kill(pid, 0) } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(() => process.kill(pid, 0)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('classifies early exit and spawn failures', async () => {
    // Arrange / Act
    const exit = await probeStartup({ command: process.execPath, args: ['-e', 'process.exit(0)'] })
    const spawn = await probeStartup({ command: path.join(os.tmpdir(), 'missing-launcher-t8') })
    // Assert
    expect(exit.reason).toBe('exited')
    expect(spawn.reason).toBe('spawn')
  })
})

describe('doctor startup outcomes', () => {
  test.each([
    [[], 'Toolchain ok; MCP server startup not verified — run: node scripts/doctor.mjs --probe-launcher'],
    [['--probe-launcher'], 'Toolchain ok; MCP server startup not verified — run: node scripts/doctor.mjs --probe-launcher'],
  ])('reports unverified startup (%s)', (args, expected) => {
    // Arrange
    const copy = makeDoctorCopy()
    try {
      // Act
      const result = runDoctor(copy.dir, args)
      // Assert
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split('\n').at(-1)).toBe(expected)
    } finally { rmSync(copy.dir, { recursive: true, force: true }) }
  })

  test('reports malformed launcher without a stack trace', () => {
    // Arrange
    const copy = makeDoctorCopy()
    writeFileSync(path.join(copy.dir, '.mcp.json'), '{bad')
    try {
      // Act
      const result = runDoctor(copy.dir, ['--probe-launcher'])
      // Assert
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('launcher config missing or invalid (.mcp.json)')
      expect(result.stdout).not.toContain('SyntaxError')
    } finally { rmSync(copy.dir, { recursive: true, force: true }) }
  })

  test('probes launcher env without scanning absent dist', () => {
    // Arrange
    const copy = makeDoctorCopy()
    const server = path.join(copy.dir, 'server.mjs')
    writeFileSync(server, fake)
    writeFileSync(path.join(copy.dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      codex: { command: process.execPath, args: [server, '0'], env: { HIDDEN_TEST_VALUE: 'secret-value' } },
    } }))
    try {
      // Act
      const result = runDoctor(copy.dir, ['--probe-launcher'])
      // Assert
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('All good. Register the MCP server')
      expect(result.stdout).not.toContain('scan unavailable')
      expect(result.stdout).not.toContain('Keep the folder downloaded')
      expect(`${result.stdout}${result.stderr}`).not.toContain('secret-value')
    } finally { rmSync(copy.dir, { recursive: true, force: true }) }
  })

  test('blocks when launcher exits before handshake', () => {
    // Arrange
    const copy = makeDoctorCopy()
    const server = path.join(copy.dir, 'exit.mjs')
    writeFileSync(server, 'process.exit(0)')
    writeFileSync(path.join(copy.dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      codex: { command: process.execPath, args: [server] },
    } }))
    try {
      // Act
      const result = runDoctor(copy.dir, ['--probe-launcher'])
      // Assert
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('❌ MCP server starts')
      expect(result.stdout).toContain('Run the launcher command manually')
    } finally { rmSync(copy.dir, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform === 'win32')('accepts a launcher without args', () => {
    // Arrange
    const copy = makeDoctorCopy()
    const wrapper = path.join(copy.dir, 'wrapper.mjs')
    writeFileSync(wrapper, `#!/usr/bin/env node\n${fake}`)
    chmodSync(wrapper, 0o755)
    writeFileSync(path.join(copy.dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      codex: { command: wrapper },
    } }))
    try {
      // Act
      const result = runDoctor(copy.dir, ['--probe-launcher'])
      // Assert
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('All good. Register the MCP server')
    } finally { rmSync(copy.dir, { recursive: true, force: true }) }
  })
})

test('packages both startup scripts', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] }
  expect(packageJson.files).toEqual(expect.arrayContaining(['scripts/startup-probe.mjs', 'scripts/npm-smoke.mjs']))
})
