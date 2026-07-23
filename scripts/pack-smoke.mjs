#!/usr/bin/env node
/**
 * Pack/install smoke test.
 *
 * Verifies the published artifact actually works:
 *   1. `npm pack` the repo into a temp dir.
 *   2. Extract the tarball and assert key shipped files are present.
 *   3. `npm install` the tarball into a scratch project.
 *   4. Assert the installed bin/main entries exist, and that every relative
 *      file path referenced by advertised npm scripts exists in the installed tree.
 *   5. Spawn the installed server and assert it answers a JSON-RPC `initialize`
 *      over stdio within a short timeout (and does not exit nonzero).
 *
 * Requires `npm run build` first (dist/ must exist). Exits 1 on any failure.
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INITIALIZE_TIMEOUT_MS = 5000
const EXPECTED_SERVER_NAME = 'codex-mcp'
// Relative paths inside npm script commands, e.g. "node scripts/doctor.mjs" or "node dist/index.js".
const SCRIPT_PATH_PATTERN = /(?:^|\s)((?:\.\/)?(?:scripts|dist)\/[\w./-]+\.(?:mjs|cjs|js))(?=\s|$)/g
const COMMAND_SCRIPT_PATTERN = /\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+\.mjs)\b/g

class SmokeFailure extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'SmokeFailure'
    this.detail = detail
  }
}

function assertThat(condition, message, detail) {
  if (!condition) {
    throw new SmokeFailure(message, detail)
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

async function runNpm(args, cwd) {
  try {
    const { stdout } = await execFileAsync('npm', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (error) {
    throw new SmokeFailure(`npm ${args.join(' ')} failed in ${cwd}`, error?.stderr ?? error?.message)
  }
}

async function packTarball(packDir) {
  const stdout = await runNpm(['pack', '--json', '--pack-destination', packDir], REPO_ROOT)
  const entries = JSON.parse(stdout)
  assertThat(Array.isArray(entries) && entries.length === 1, 'npm pack --json did not report exactly one tarball', stdout)
  const tarballPath = join(packDir, entries[0].filename)
  assertThat(existsSync(tarballPath), `packed tarball not found at ${tarballPath}`)
  return tarballPath
}

async function verifyExtractedTarball(tarballPath, extractDir) {
  try {
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir])
  } catch (error) {
    throw new SmokeFailure(`tar -xzf failed for ${tarballPath}`, error?.stderr ?? error?.message)
  }
  const mustShip = ['package/package.json', 'package/dist/index.js', 'package/scripts/smoke-e2e.mjs']
  for (const relPath of mustShip) {
    assertThat(existsSync(join(extractDir, relPath)), `tarball is missing ${relPath}`)
  }
}

async function installIntoScratch(tarballPath, scratchDir) {
  const scratchManifest = { name: 'pack-smoke-scratch', version: '0.0.0', private: true }
  writeFileSync(join(scratchDir, 'package.json'), JSON.stringify(scratchManifest, null, 2))
  await runNpm(['install', '--no-audit', '--no-fund', '--ignore-scripts', tarballPath], scratchDir)
  const pkgName = readJson(join(REPO_ROOT, 'package.json')).name
  const installedRoot = join(scratchDir, 'node_modules', ...pkgName.split('/'))
  assertThat(existsSync(installedRoot), `installed package root not found at ${installedRoot}`)
  return installedRoot
}

function collectScriptReferencedPaths(scripts) {
  const paths = new Set()
  for (const command of Object.values(scripts ?? {})) {
    for (const match of command.matchAll(SCRIPT_PATH_PATTERN)) {
      paths.add(match[1].replace(/^\.\//, ''))
    }
  }
  return [...paths]
}

function verifyCommandScriptAllowlist() {
  const manifest = readJson(join(REPO_ROOT, 'package.json'))
  const command = readFileSync(join(REPO_ROOT, 'commands', 'codex-flow.md'), 'utf8')
  const referencedPaths = [...new Set([...command.matchAll(COMMAND_SCRIPT_PATTERN)].map((match) => match[1]))]
  assertThat(referencedPaths.length > 0, 'commands/codex-flow.md contains no plugin script references')
  assertThat(Array.isArray(manifest.files), 'package.json has no files allowlist')
  for (const relPath of referencedPaths) {
    assertThat(
      manifest.files.includes(relPath),
      `commands/codex-flow.md references ${relPath} but package.json files does not include it`,
      manifest.files
    )
  }
  return referencedPaths
}

function verifyInstalledTree(installedRoot) {
  const manifest = readJson(join(installedRoot, 'package.json'))

  const entryPoints = { main: manifest.main, ...(manifest.bin ?? {}) }
  for (const [label, relPath] of Object.entries(entryPoints)) {
    assertThat(typeof relPath === 'string' && relPath.length > 0, `package.json has no usable "${label}" entry`)
    assertThat(existsSync(join(installedRoot, relPath)), `entry "${label}" -> ${relPath} missing from installed tree`)
  }

  const referencedPaths = collectScriptReferencedPaths(manifest.scripts)
  assertThat(
    referencedPaths.includes('scripts/smoke-e2e.mjs'),
    'expected advertised scripts to reference scripts/smoke-e2e.mjs',
    manifest.scripts
  )
  for (const relPath of referencedPaths) {
    assertThat(existsSync(join(installedRoot, relPath)), `npm script references ${relPath} but it is missing from installed tree`)
  }

  return { binPath: join(installedRoot, Object.values(manifest.bin)[0]), referencedPaths }
}

function verifyInitializeHandshake(binPath, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) rejectPromise(error)
      else resolvePromise()
    }

    const timer = setTimeout(() => {
      finish(new SmokeFailure(`server did not answer initialize within ${INITIALIZE_TIMEOUT_MS}ms`, { stdout, stderr }))
    }, INITIALIZE_TIMEOUT_MS)

    child.on('error', (error) => finish(new SmokeFailure('failed to spawn installed server', error.message)))
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        finish(new SmokeFailure(`server exited with code ${code} before answering initialize`, { stdout, stderr }))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'))
      if (!line || !stdout.includes('\n')) return
      try {
        const response = JSON.parse(line)
        assertThat(response.jsonrpc === '2.0' && response.id === 1, 'initialize response is not a JSON-RPC reply to id 1', line)
        assertThat(
          response.result?.serverInfo?.name === EXPECTED_SERVER_NAME,
          `initialize response serverInfo.name != "${EXPECTED_SERVER_NAME}"`,
          line
        )
        finish()
      } catch (error) {
        finish(error instanceof SmokeFailure ? error : new SmokeFailure('could not parse initialize response', line))
      }
    })

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pack-smoke', version: '0.0.0' },
      },
    }
    child.stdin.write(`${JSON.stringify(initialize)}\n`)
  })
}

async function main() {
  assertThat(
    existsSync(join(REPO_ROOT, 'dist', 'index.js')),
    'dist/index.js not found — run `npm run build` before pack-smoke'
  )
  const commandScriptPaths = verifyCommandScriptAllowlist()
  console.log(`command script allowlist verified (${commandScriptPaths.join(', ')})`)

  const packDir = mkdtempSync(join(tmpdir(), 'codex-mcp-pack-'))
  const extractDir = mkdtempSync(join(tmpdir(), 'codex-mcp-extract-'))
  const scratchDir = mkdtempSync(join(tmpdir(), 'codex-mcp-scratch-'))
  try {
    const tarballPath = await packTarball(packDir)
    console.log(`packed: ${tarballPath}`)

    await verifyExtractedTarball(tarballPath, extractDir)
    console.log('tarball extraction verified (dist + smoke-e2e present)')

    const installedRoot = await installIntoScratch(tarballPath, scratchDir)
    console.log(`installed into scratch project: ${installedRoot}`)

    const { binPath, referencedPaths } = verifyInstalledTree(installedRoot)
    console.log(`installed tree verified: bin/main + script-referenced files exist (${referencedPaths.join(', ')})`)

    await verifyInitializeHandshake(binPath, scratchDir)
    console.log('installed server answered JSON-RPC initialize over stdio')

    console.log('PASS: pack/install smoke test')
  } finally {
    for (const dir of [packDir, extractDir, scratchDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`)
  if (error?.detail !== undefined) {
    console.error('detail:', typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail, null, 2))
  }
  process.exit(1)
})
