#!/usr/bin/env node
/**
 * Post-publish / pre-publish npm smoke test.
 *
 * Starts the MCP server the way a real install starts it, performs the stdio
 * handshake (`initialize` → `notifications/initialized` → `tools/list`) and
 * asserts the exact set of advertised tool names. Nothing here is Codex-aware:
 * the point is to prove the *packaged artifact* boots and advertises its tools.
 *
 * Usage: node scripts/npm-smoke.mjs (--version <v> | --tarball <path> | --tarball-from-pack)
 *   --version <v>          run `npx -y @anhnguyen0905/codex-mcp@<v>` (published version)
 *   --tarball <path>       install that tarball into a temp dir and run its dist/index.js
 *   --tarball-from-pack    `npm pack --json` this repo first, then as --tarball
 *   --timeout-ms <n>       override the 60 s handshake budget (tests / slow runners)
 *
 * Exit codes: 0 = ok, 1 = mismatch / timeout / spawn or pack failure, 2 = usage error.
 * Windows-safe: `npx.cmd` / `npm.cmd` are resolved explicitly and no argument is
 * ever passed through a shell.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PACKAGE_NAME = '@anhnguyen0905/codex-mcp'

export const EXPECTED_TOOLS = Object.freeze([
  'codex_execute',
  'codex_continue',
  'codex_review',
  'codex_batch',
  'codex_sessions',
  'codex_metrics',
  'codex_health',
])

export const DEFAULT_TIMEOUT_MS = 60_000

const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_USAGE = 2

const INITIALIZE_ID = 1
const TOOLS_LIST_ID = 2
const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'npm-smoke', version: '0.0.0' }
const NPM_INSTALL_TIMEOUT_MS = 300_000
const MAX_BUFFER_BYTES = 16 * 1024 * 1024
/** npm versions are semver-ish; reject anything that could be mistaken for a flag or path. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/

export const USAGE = 'usage: node scripts/npm-smoke.mjs (--version <v> | --tarball <path> | --tarball-from-pack) [--timeout-ms <n>]'

/** Failure that is the smoke test's own verdict, as opposed to a programmer error. */
export class SmokeError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'SmokeError'
    this.detail = detail
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Windows needs the `.cmd` shim; spawning without a shell will not find the bare name. */
export function npmBin(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function npxBin(platform = process.platform) {
  return platform === 'win32' ? 'npx.cmd' : 'npx'
}

function jsonRpcRequest(id, method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

function jsonRpcNotification(method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
}

function toolNamesOf(response) {
  const tools = response?.result?.tools
  if (!Array.isArray(tools)) {
    throw new SmokeError('tools/list response has no result.tools array', JSON.stringify(response))
  }
  return tools.map((tool) => {
    if (typeof tool?.name !== 'string' || tool.name.length === 0) {
      throw new SmokeError('tools/list returned a tool without a name', JSON.stringify(tool))
    }
    return tool.name
  })
}

/**
 * Compare the advertised names against EXPECTED_TOOLS as a set.
 * Returns the mismatch description, or null when the sets are equal.
 */
export function describeToolMismatch(actual, expected = EXPECTED_TOOLS) {
  const seen = new Set(actual)
  const missing = expected.filter((name) => !seen.has(name))
  const unexpected = actual.filter((name) => !expected.includes(name))
  // A duplicated name means the server registered a tool twice; the set comparison
  // alone would call that a pass, so compare the counts too.
  const duplicated = [...seen].filter((name) => actual.filter((candidate) => candidate === name).length > 1)
  if (missing.length === 0 && unexpected.length === 0 && duplicated.length === 0) return null
  const parts = []
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
  if (unexpected.length > 0) parts.push(`unexpected: ${unexpected.join(', ')}`)
  if (duplicated.length > 0) parts.push(`duplicated: ${duplicated.join(', ')}`)
  return `tools/list does not match the expected ${expected.length} tools (${parts.join('; ')})`
}

/**
 * Spawn an MCP stdio server, handshake, and return its advertised tool names.
 * Rejects with SmokeError on timeout, early exit, or a malformed response.
 */
export function runSmoke({ command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('runSmoke: command must be a non-empty string')
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('runSmoke: args must be an array of strings')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('runSmoke: timeoutMs must be a positive number')
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let pending = ''
    let stderr = ''
    let initialized = false
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }

    const timer = setTimeout(() => {
      finish(new SmokeError(`server did not answer tools/list within ${timeoutMs}ms`, { stderr }))
    }, timeoutMs)

    const write = (payload) => {
      // The child can die between the readiness check and the write; surface it as a verdict.
      child.stdin.write(payload, (error) => {
        if (error) finish(new SmokeError(`failed to write to server stdin: ${error.message}`, { stderr }))
      })
    }

    const handleResponse = (response) => {
      if (response.error) {
        finish(new SmokeError(`server returned a JSON-RPC error: ${response.error?.message ?? 'unknown'}`, JSON.stringify(response.error)))
        return
      }
      if (response.id === INITIALIZE_ID && !initialized) {
        initialized = true
        write(jsonRpcNotification('notifications/initialized'))
        write(jsonRpcRequest(TOOLS_LIST_ID, 'tools/list', {}))
        return
      }
      if (response.id !== TOOLS_LIST_ID) return
      try {
        const tools = toolNamesOf(response)
        const mismatch = describeToolMismatch(tools)
        if (mismatch) {
          finish(new SmokeError(mismatch, { tools }))
          return
        }
        finish(null, { tools })
      } catch (error) {
        finish(error instanceof SmokeError ? error : new SmokeError(`could not read tools/list response: ${error.message}`))
      }
    }

    child.on('error', (error) => finish(new SmokeError(`failed to spawn ${command}: ${error.message}`)))
    child.on('exit', (code, signal) => {
      finish(new SmokeError(`server exited (code ${code}, signal ${signal ?? 'none'}) before answering tools/list`, { stderr }))
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        // npx and npm print progress noise on stdout; only JSON-RPC frames matter.
        if (!trimmed.startsWith('{')) continue
        let response
        try {
          response = JSON.parse(trimmed)
        } catch {
          continue
        }
        handleResponse(response)
        if (settled) return
      }
    })

    write(
      jsonRpcRequest(INITIALIZE_ID, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })
    )
  })
}

/** Parse argv (without node/script) into a validated mode. Throws UsageError on bad input. */
export function parseArgs(argv) {
  const modes = []
  let version
  let tarball
  let timeoutMs = DEFAULT_TIMEOUT_MS

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version') {
      version = argv[i + 1]
      i += 1
      modes.push('version')
      continue
    }
    if (arg === '--tarball') {
      tarball = argv[i + 1]
      i += 1
      modes.push('tarball')
      continue
    }
    if (arg === '--tarball-from-pack') {
      modes.push('tarball-from-pack')
      continue
    }
    if (arg === '--timeout-ms') {
      const raw = argv[i + 1]
      i += 1
      const parsed = raw === undefined ? Number.NaN : Number(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsageError(`--timeout-ms requires a positive number (got: ${raw ?? '<missing>'})`)
      }
      timeoutMs = parsed
      continue
    }
    throw new UsageError(`unknown argument: ${arg}`)
  }

  if (modes.length === 0) throw new UsageError('one of --version, --tarball or --tarball-from-pack is required')
  if (modes.length > 1) throw new UsageError(`--version, --tarball and --tarball-from-pack are mutually exclusive (got: ${modes.join(', ')})`)

  const mode = modes[0]
  if (mode === 'version') {
    if (version === undefined || !VERSION_PATTERN.test(version)) {
      throw new UsageError(`--version requires a version like 0.26.0 (got: ${version ?? '<missing>'})`)
    }
    return { mode, version, timeoutMs }
  }
  if (mode === 'tarball') {
    if (tarball === undefined || tarball.length === 0 || tarball.startsWith('--')) {
      throw new UsageError(`--tarball requires a path to a packed tarball (got: ${tarball ?? '<missing>'})`)
    }
    return { mode, tarball: path.resolve(tarball), timeoutMs }
  }
  return { mode, timeoutMs }
}

async function runNpm(args, cwd) {
  try {
    const { stdout } = await execFileAsync(npmBin(), args, {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: NPM_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout
  } catch (error) {
    throw new SmokeError(`npm ${args.join(' ')} failed in ${cwd}`, error?.stderr ?? error?.message)
  }
}

async function packRepo(repoRoot, packDir) {
  const stdout = await runNpm(['pack', '--json', '--pack-destination', packDir], repoRoot)
  let entries
  try {
    entries = JSON.parse(stdout)
  } catch {
    throw new SmokeError('npm pack --json did not print JSON', stdout)
  }
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new SmokeError('npm pack --json did not report exactly one tarball filename', stdout)
  }
  const tarballPath = path.join(packDir, entries[0].filename)
  if (!existsSync(tarballPath)) throw new SmokeError(`packed tarball not found at ${tarballPath}`)
  return tarballPath
}

/** Install the tarball into a scratch project and return the entry point a consumer would run. */
async function installTarball(tarballPath, scratchDir) {
  if (!existsSync(tarballPath)) throw new SmokeError(`tarball not found: ${tarballPath}`)
  const manifest = { name: 'npm-smoke-scratch', version: '0.0.0', private: true }
  writeFileSync(path.join(scratchDir, 'package.json'), JSON.stringify(manifest, null, 2))
  await runNpm(['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', tarballPath], scratchDir)
  const entryPath = path.join(scratchDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'index.js')
  if (!existsSync(entryPath)) throw new SmokeError(`installed package has no entry point at ${entryPath}`)
  return entryPath
}

async function main(argv, repoRoot) {
  const options = parseArgs(argv)

  if (options.mode === 'version') {
    const spec = `${PACKAGE_NAME}@${options.version}`
    console.log(`smoking published ${spec}`)
    const { tools } = await runSmoke({ command: npxBin(), args: ['-y', spec], timeoutMs: options.timeoutMs })
    console.log(`PASS: ${spec} advertises ${tools.length} tools (${tools.join(', ')})`)
    return
  }

  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-npm-smoke-'))
  const packDir = options.mode === 'tarball-from-pack' ? mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-npm-pack-')) : undefined
  try {
    const tarballPath = options.mode === 'tarball-from-pack' ? await packRepo(repoRoot, packDir) : options.tarball
    console.log(`smoking tarball ${tarballPath}`)
    const entryPath = await installTarball(tarballPath, scratchDir)
    const { tools } = await runSmoke({
      command: process.execPath,
      args: [entryPath],
      timeoutMs: options.timeoutMs,
      cwd: scratchDir,
    })
    console.log(`PASS: installed tarball advertises ${tools.length} tools (${tools.join(', ')})`)
  } finally {
    for (const dir of [scratchDir, packDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  main(process.argv.slice(2), repoRoot).then(
    () => process.exit(EXIT_OK),
    (error) => {
      if (error instanceof UsageError) {
        console.error(`npm-smoke: ${error.message}`)
        console.error(USAGE)
        process.exit(EXIT_USAGE)
      }
      console.error(`FAIL: ${error.message}`)
      if (error?.detail !== undefined) {
        console.error('detail:', typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail, null, 2))
      }
      process.exit(EXIT_FAILURE)
    }
  )
}
