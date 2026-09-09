import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  EXPECTED_TOOLS,
  DEFAULT_TIMEOUT_MS,
  PACKAGE_NAME,
  USAGE,
  describeToolMismatch,
  npmBin,
  npxBin,
  parseArgs,
  runSmoke,
} from '../scripts/npm-smoke.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'npm-smoke.mjs')

/**
 * Minimal MCP stdio server fixture. Modes:
 *   ok      — answers initialize, then tools/list with the names in argv[3],
 *             but only after `notifications/initialized` arrived (handshake order).
 *   silent  — reads stdin and never answers (timeout case).
 * No network, no npm.
 */
const FAKE_SERVER = `
const mode = process.argv[2]
const toolNames = JSON.parse(process.argv[3] || '[]')
let sawInitialized = false
let buffered = ''

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')

process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (mode === 'silent') return
  buffered += chunk
  const lines = buffered.split('\\n')
  buffered = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.0' } } })
      continue
    }
    if (message.method === 'notifications/initialized') {
      sawInitialized = true
      continue
    }
    if (message.method === 'tools/list') {
      if (!sawInitialized) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'tools/list before notifications/initialized' } })
        continue
      }
      send({ jsonrpc: '2.0', id: message.id, result: { tools: toolNames.map((name) => ({ name })) } })
    }
  }
})
`

let fixtureDir: string
let fakeServerPath: string

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'npm-smoke-test-'))
  fakeServerPath = path.join(fixtureDir, 'fake-server.mjs')
  writeFileSync(fakeServerPath, FAKE_SERVER)
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

const smokeFake = (mode: string, toolNames: readonly string[], timeoutMs = 5000) =>
  runSmoke({
    command: process.execPath,
    args: [fakeServerPath, mode, JSON.stringify(toolNames)],
    timeoutMs,
  })

describe('runSmoke', () => {
  test('resolves with the advertised tool names when the server lists all seven tools', async () => {
    // Arrange / Act
    const result = await smokeFake('ok', EXPECTED_TOOLS)

    // Assert
    expect(result.tools).toEqual([...EXPECTED_TOOLS])
  })

  test('rejects when a tool is missing from tools/list', async () => {
    // Arrange
    const incomplete = EXPECTED_TOOLS.filter((name: string) => name !== 'codex_health')

    // Act / Assert
    await expect(smokeFake('ok', incomplete)).rejects.toThrow(/missing: codex_health/)
  })

  test('rejects when tools/list advertises an unexpected tool', async () => {
    // Arrange
    const extra = [...EXPECTED_TOOLS, 'codex_surprise']

    // Act / Assert
    await expect(smokeFake('ok', extra)).rejects.toThrow(/unexpected: codex_surprise/)
  })

  test('rejects when a tool name is advertised twice', async () => {
    // Arrange
    const duplicated = [...EXPECTED_TOOLS, 'codex_health']

    // Act / Assert
    await expect(smokeFake('ok', duplicated)).rejects.toThrow(/duplicated: codex_health/)
  })

  test('rejects with a timeout when the server never answers', async () => {
    // Arrange / Act / Assert
    await expect(smokeFake('silent', EXPECTED_TOOLS, 300)).rejects.toThrow(/did not answer tools\/list within 300ms/)
  })

  test('rejects when the command cannot be spawned', async () => {
    // Arrange / Act / Assert
    await expect(
      runSmoke({ command: path.join(fixtureDir, 'definitely-not-a-binary'), args: [], timeoutMs: 5000 })
    ).rejects.toThrow(/failed to spawn/)
  })

  test('rejects invalid arguments as programmer errors', () => {
    // Arrange / Act / Assert
    expect(() => runSmoke({ command: '', args: [] })).toThrow(TypeError)
    expect(() => runSmoke({ command: process.execPath, args: [1 as unknown as string] })).toThrow(TypeError)
    expect(() => runSmoke({ command: process.execPath, timeoutMs: 0 })).toThrow(TypeError)
  })
})

describe('parseArgs', () => {
  test('accepts --version and defaults the timeout to 60 s', () => {
    // Arrange / Act
    const options = parseArgs(['--version', '0.26.0'])

    // Assert
    expect(options).toEqual({ mode: 'version', version: '0.26.0', timeoutMs: DEFAULT_TIMEOUT_MS })
  })

  test('resolves --tarball to an absolute path', () => {
    // Arrange / Act
    const options = parseArgs(['--tarball', 'pkg.tgz'])

    // Assert
    expect(options.mode).toBe('tarball')
    expect(path.isAbsolute(options.tarball)).toBe(true)
  })

  test('accepts --tarball-from-pack with an explicit timeout', () => {
    // Arrange / Act
    const options = parseArgs(['--tarball-from-pack', '--timeout-ms', '1000'])

    // Assert
    expect(options).toEqual({ mode: 'tarball-from-pack', timeoutMs: 1000 })
  })

  test.each([
    [[], /one of --version/],
    [['--version'], /--version requires/],
    [['--version', '--tarball-from-pack'], /--version requires/],
    [['--tarball'], /--tarball requires/],
    [['--version', '0.26.0', '--tarball-from-pack'], /mutually exclusive/],
    [['--timeout-ms', 'abc', '--tarball-from-pack'], /--timeout-ms requires/],
    [['--nope'], /unknown argument: --nope/],
  ])('rejects usage %j', (argv, expected) => {
    // Arrange / Act / Assert
    expect(() => parseArgs(argv as string[])).toThrow(expected as RegExp)
  })
})

describe('describeToolMismatch', () => {
  test('returns null for the expected set in any order', () => {
    // Arrange
    const shuffled = [...EXPECTED_TOOLS].reverse()

    // Act / Assert
    expect(describeToolMismatch(shuffled)).toBeNull()
  })

  test('names both missing and unexpected tools', () => {
    // Arrange / Act
    const message = describeToolMismatch(['codex_execute'], ['codex_execute', 'codex_health'])

    // Assert
    expect(message).toMatch(/missing: codex_health/)
  })
})

describe('platform binaries', () => {
  test('uses the .cmd shims on Windows and bare names elsewhere', () => {
    // Arrange / Act / Assert
    expect(npxBin('win32')).toBe('npx.cmd')
    expect(npmBin('win32')).toBe('npm.cmd')
    expect(npxBin('linux')).toBe('npx')
    expect(npmBin('darwin')).toBe('npm')
  })
})

describe('CLI', () => {
  test('exits 2 and prints usage when no mode is given', () => {
    // Arrange / Act
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT], { encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(USAGE)
  })

  test('exits 2 on an unknown flag without touching the network', () => {
    // Arrange / Act
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT, '--publish-now'], { encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown argument: --publish-now')
  })

  test('exits 1 when the requested tarball does not exist', () => {
    // Arrange
    const missing = path.join(fixtureDir, 'no-such-package.tgz')

    // Act
    const result = spawnSync(process.execPath, [SMOKE_SCRIPT, '--tarball', missing], { encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('tarball not found')
  })
})

describe('package identity', () => {
  test('smokes the published package name from package.json', () => {
    // Arrange
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }

    // Assert
    expect(PACKAGE_NAME).toBe(manifest.name)
  })
})
