import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  npmSpawnOptions,
  npxBin,
  parseArgs,
  publishedSmokeArgs,
  quoteShellArg,
  resolveBinName,
  runSmoke,
  SMOKE_ERROR_CODES,
  SmokeError,
  shellArgs,
  DEFAULT_BIN_NAME,
  binNameFromManifest,
  runNpm,
  removeScratchDir,
} from '../scripts/npm-smoke.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'npm-smoke.mjs')

/**
 * Minimal MCP stdio server fixture. Modes:
 *   ok      — answers initialize, then tools/list with the names in argv[3],
 *             but only after `notifications/initialized` arrived (handshake order).
 *   silent  — reads stdin and never answers (timeout case).
 *   close-stdin — destroys stdin and exits immediately, avoiding a timeout race.
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
if (mode === 'close-stdin') {
  process.stdin.destroy()
  process.exit(0)
}
process.stdin.on('data', (chunk) => {
  if (mode === 'silent') return
  buffered += chunk
  const lines = buffered.split('\\n')
  buffered = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      if (mode === 'exit') process.exit(0)
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
      if (mode === 'rpc-error') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'fixture failure' } })
        continue
      }
      if (mode === 'bad-response') {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
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

const captureRejection = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('Expected promise to reject')
}

describe('runSmoke', () => {
  test('exports frozen unique smoke error codes and preserves two-argument errors', () => {
    // Arrange / Act
    const error = new SmokeError('m', 'd')

    // Assert
    expect(Object.isFrozen(SMOKE_ERROR_CODES)).toBe(true)
    expect(new Set(Object.values(SMOKE_ERROR_CODES)).size).toBe(Object.values(SMOKE_ERROR_CODES).length)
    expect(error.code).toBeUndefined()
  })

  test('resolves with the advertised tool names when the server lists all seven tools', async () => {
    // Arrange / Act
    const result = await smokeFake('ok', EXPECTED_TOOLS)

    // Assert
    expect(result.tools).toEqual([...EXPECTED_TOOLS])
  })

  test('rejects when a tool is missing from tools/list', async () => {
    // Arrange
    const incomplete = EXPECTED_TOOLS.filter((name: string) => name !== 'codex_health')

    // Act
    const error = await captureRejection(smokeFake('ok', incomplete))

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.message).toMatch(/missing: codex_health/)
      expect(error.code).toBe(SMOKE_ERROR_CODES.TOOLS_MISMATCH)
    }
  })

  test('rejects when tools/list advertises an unexpected tool', async () => {
    // Arrange
    const extra = [...EXPECTED_TOOLS, 'codex_surprise']

    // Act
    const error = await captureRejection(smokeFake('ok', extra))

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.message).toMatch(/unexpected: codex_surprise/)
      expect(error.code).toBe(SMOKE_ERROR_CODES.TOOLS_MISMATCH)
    }
  })

  test('rejects when a tool name is advertised twice', async () => {
    // Arrange
    const duplicated = [...EXPECTED_TOOLS, 'codex_health']

    // Act
    const error = await captureRejection(smokeFake('ok', duplicated))

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.message).toMatch(/duplicated: codex_health/)
      expect(error.code).toBe(SMOKE_ERROR_CODES.TOOLS_MISMATCH)
    }
  })

  test('rejects with a timeout when the server never answers', async () => {
    // Arrange / Act
    const error = await captureRejection(smokeFake('silent', EXPECTED_TOOLS, 300))

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.message).toMatch(/did not answer tools\/list within 300ms/)
      expect(error.code).toBe(SMOKE_ERROR_CODES.TIMEOUT)
    }
  })

  test('rejects when the command cannot be spawned', async () => {
    // Arrange / Act
    const error = await captureRejection(
      runSmoke({ command: path.join(fixtureDir, 'definitely-not-a-binary'), args: [], timeoutMs: 5000 })
    )

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.message).toMatch(/failed to spawn/)
      expect(error.code).toBe(SMOKE_ERROR_CODES.SPAWN)
    }

  })

  test.each([
    ['exit', SMOKE_ERROR_CODES.EXITED],
    ['rpc-error', SMOKE_ERROR_CODES.RPC_ERROR],
    ['bad-response', SMOKE_ERROR_CODES.BAD_RESPONSE],
  ])('classifies %s failure with a stable code', async (mode, code) => {
    // Arrange / Act
    const error = await captureRejection(smokeFake(mode, EXPECTED_TOOLS))

    // Assert
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) expect(error.code).toBe(code)
  })

  test('rejects invalid arguments as programmer errors', () => {
    // Arrange / Act / Assert
    expect(() => runSmoke({ command: '', args: [] })).toThrow(TypeError)
    expect(() => runSmoke({ command: process.execPath, args: [1 as unknown as string] })).toThrow(TypeError)
    expect(() => runSmoke({ command: process.execPath, timeoutMs: 0 })).toThrow(TypeError)
  })
})

describe('removeScratchDir', () => {
  test('asks for retries so a briefly locked Windows directory is removed', () => {
    // Arrange
    const calls: Array<{ dir: string, options: { maxRetries: number, retryDelay: number, recursive: boolean } }> = []
    const remove = (dir: string, options: { maxRetries: number, retryDelay: number, recursive: boolean }) => {
      calls.push({ dir, options })
    }

    // Act
    const removed = removeScratchDir('/tmp/scratch', { remove })

    // Assert
    expect(removed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].options).toMatchObject({ recursive: true, force: true })
    expect(calls[0].options.maxRetries).toBeGreaterThan(0)
    expect(calls[0].options.retryDelay).toBeGreaterThan(0)
  })

  test('warns instead of throwing when the directory stays locked', () => {
    // Arrange
    const warnings: string[] = []
    const remove = () => {
      throw new Error('EBUSY: resource busy or locked')
    }

    // Act
    const removed = removeScratchDir('/tmp/scratch', { remove, warn: (message: string) => warnings.push(message) })

    // Assert
    expect(removed).toBe(false)
    expect(warnings).toEqual(['npm-smoke: warning: could not remove /tmp/scratch: EBUSY: resource busy or locked'])
  })
})

describe('runNpm', () => {
  test('reports npm failures with the stable NPM_FAILED code', async () => {
    const error = await captureRejection(runNpm(['pack'], fixtureDir, {
      exec: async () => { throw new Error('stub npm failure') },
    }))
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.code).toBe(SMOKE_ERROR_CODES.NPM_FAILED)
      expect(error.message).toContain('npm pack failed in')
    }
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

describe('published-version invocation', () => {
  test('runs the bin explicitly via -p so a package/bin name mismatch still resolves', () => {
    // Arrange
    const spec = `${PACKAGE_NAME}@0.26.0`

    // Act
    const args = publishedSmokeArgs(spec, 'codex-mcp')

    // Assert — `npx -y <pkg>` exits 127 when the bin name differs from the package name.
    expect(args).toEqual(['-y', '-p', spec, 'codex-mcp'])
  })

  test('rejects an empty spec or bin name', () => {
    // Arrange / Act / Assert
    expect(() => publishedSmokeArgs('', 'codex-mcp')).toThrow(TypeError)
    expect(() => publishedSmokeArgs(`${PACKAGE_NAME}@0.26.0`, '')).toThrow(TypeError)
  })

  test('derives the bin name from this repo package.json bin map', () => {
    // Arrange / Act
    const binName = resolveBinName(REPO_ROOT)

    // Assert
    expect(binName).toBe(DEFAULT_BIN_NAME)
  })

  test('falls back to the published bin name when the manifest is missing or unreadable', () => {
    // Arrange
    const manifestless = path.join(fixtureDir, 'no-manifest-here')

    // Act / Assert
    expect(resolveBinName(manifestless)).toBe(DEFAULT_BIN_NAME)
    expect(resolveBinName('')).toBe(DEFAULT_BIN_NAME)
    expect(binNameFromManifest({})).toBe(DEFAULT_BIN_NAME)
  })

  test('reads the first key of a bin map and the unscoped name for a string bin', () => {
    // Arrange / Act / Assert
    expect(binNameFromManifest({ name: '@scope/pkg', bin: { 'other-cmd': 'dist/index.js' } })).toBe('other-cmd')
    expect(binNameFromManifest({ name: '@scope/pkg', bin: 'dist/index.js' })).toBe('pkg')
  })
})

describe('npm/npx spawn options', () => {
  test('uses a shell on win32 and no shell on POSIX', () => {
    // Arrange / Act / Assert — Node >= 20.12 fails EINVAL spawning npm.cmd without a shell.
    expect(npmSpawnOptions('win32')).toEqual({ shell: true })
    expect(npmSpawnOptions('linux')).toEqual({})
    expect(npmSpawnOptions('darwin')).not.toHaveProperty('shell')
  })

  test('quotes only the win32 arguments that need it and leaves POSIX untouched', () => {
    // Arrange
    const withSpaces = 'C:\\Users\\Name Surname\\AppData\\Local\\Temp'

    // Act / Assert
    expect(quoteShellArg(`${PACKAGE_NAME}@0.26.0`, 'win32')).toBe(`${PACKAGE_NAME}@0.26.0`)
    expect(quoteShellArg(withSpaces, 'win32')).toBe(`"${withSpaces}"`)
    expect(quoteShellArg(withSpaces, 'linux')).toBe(withSpaces)
    expect(shellArgs(['--json', withSpaces], 'win32')).toEqual(['--json', `"${withSpaces}"`])
    expect(shellArgs(['--json', withSpaces], 'darwin')).toEqual(['--json', withSpaces])
  })

  test('refuses an argument cmd.exe quoting cannot neutralise', () => {
    // Arrange / Act / Assert
    expect(() => quoteShellArg('a"b', 'win32')).toThrow(/cannot be safely passed through cmd.exe/)
    let thrown: unknown
    try {
      quoteShellArg('a&b', 'win32')
    } catch (error: unknown) {
      thrown = error
    }
    if (thrown === undefined) throw new Error('expected a throw')
    expect(thrown).toBeInstanceOf(SmokeError)
    if (thrown instanceof SmokeError) {
      expect(thrown.message).toMatch(/cannot be safely passed through cmd.exe/)
      expect(thrown.code).toBe(SMOKE_ERROR_CODES.UNSAFE_ARGUMENT)
    }
  })

  test('classifies a failed stdin write with the STDIN or EXITED code and matching message', async () => {
    // Arrange / Act
    const error = await captureRejection(smokeFake('close-stdin', EXPECTED_TOOLS, 2000))

    // Assert — the child can report exit before the write callback wins the race.
    expect(error).toBeInstanceOf(SmokeError)
    if (error instanceof SmokeError) {
      expect(error.code).not.toBe(SMOKE_ERROR_CODES.TIMEOUT)
      const isStdin = error.code === SMOKE_ERROR_CODES.STDIN
        && /failed to write to server stdin/.test(error.message)
      const isExited = error.code === SMOKE_ERROR_CODES.EXITED
        && /server exited/.test(error.message)
      expect(isStdin || isExited).toBe(true)
    }
  })

  test('runSmoke forwards spawnOptions to the child spawn', async () => {
    // Arrange — a shell builtin: it can only start when shell:true is forwarded to spawn.
    const shellOnly = 'exit 1'

    // Act / Assert — with a shell it starts and then exits; without one it never spawns.
    await expect(
      runSmoke({ command: shellOnly, args: [], timeoutMs: 5000, spawnOptions: { shell: true } }),
    ).rejects.toThrow(/server exited|failed to write to server stdin/)
    await expect(runSmoke({ command: shellOnly, args: [], timeoutMs: 5000 })).rejects.toThrow(/failed to spawn/)
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

  test('includes every runtime script and relative dependency in package files', () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { files: string[] }
    const documents = [...readdirSync(path.join(REPO_ROOT, 'commands')),
      ...readdirSync(path.join(REPO_ROOT, 'skills')).flatMap((name) => [path.join(name, 'SKILL.md')])]
      .map((file) => file.includes(path.sep) ? path.join(REPO_ROOT, 'skills', file) : path.join(REPO_ROOT, 'commands', file))
      .map((file) => readFileSync(file, 'utf8')).join('\n')
    const queue = [...documents.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w-]+\.mjs)/g)]
      .map((match) => `scripts/${match[1]}`)
    const required = new Set(queue)
    while (queue.length) {
      const current = queue.pop()!
      const source = readFileSync(path.join(REPO_ROOT, current), 'utf8')
      for (const match of source.matchAll(/from ['"](\.\/[^'"]+\.mjs)['"]/g)) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(current), match[1]))
        if (!required.has(dependency)) { required.add(dependency); queue.push(dependency) }
      }
    }
    expect([...required].filter((file) => !packageJson.files.includes(file))).toEqual([])
  })
})
