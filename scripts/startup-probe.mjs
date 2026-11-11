import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { npxBin, npmBin, npmSpawnOptions, runSmoke, shellArgs, SMOKE_ERROR_CODES } from './npm-smoke.mjs'

export const STARTUP_BUDGET_MS = 30_000
export const STARTUP_PROBE_MARGIN_MS = 5_000
export const STARTUP_PROBE_TIMEOUT_MS = STARTUP_BUDGET_MS + STARTUP_PROBE_MARGIN_MS
export const STARTUP_REASON_TIMEOUT = 'timeout'
export const STARTUP_REASON_EXITED = 'exited'
export const STARTUP_REASON_SPAWN = 'spawn'
export const STARTUP_REASON_ERROR = 'error'
const CLOUD_SYNC_FIX = 'Keep the folder downloaded or move the repo off cloud-synced storage, then reconnect with /mcp.'
const LAUNCHER_FIX = "Run the launcher command manually to see its error; inside the package's own repository npx resolves the local package — register `node dist/index.js` instead."

/** Resolve npm launchers and their platform-specific spawn arguments. */
export function resolveLauncher({ command, args = [], env } = {}, { platform = process.platform } = {}) {
  const npmCommand = command === 'npx' || command === 'npm'
  const resolvedCommand = command === 'npx' ? npxBin(platform) : command === 'npm' ? npmBin(platform) : command
  const spawnOptions = npmCommand ? npmSpawnOptions(platform) : {}
  const resolvedArgs = npmCommand && spawnOptions.shell ? shellArgs(args, platform) : [...args]
  if (env !== undefined) spawnOptions.env = { ...process.env, ...env }
  return { command: resolvedCommand, args: resolvedArgs, spawnOptions }
}

function reasonOf(error) {
  if (error?.code === SMOKE_ERROR_CODES.TIMEOUT) return STARTUP_REASON_TIMEOUT
  if (error?.code === SMOKE_ERROR_CODES.EXITED) return STARTUP_REASON_EXITED
  if (error?.code === SMOKE_ERROR_CODES.SPAWN) return STARTUP_REASON_SPAWN
  return STARTUP_REASON_ERROR
}

/** Probe an MCP launcher without allowing errors to escape. */
export async function probeStartup({
  command, args = [], cwd, env, spawnOptions = {}, timeoutMs = STARTUP_PROBE_TIMEOUT_MS, now = Date.now, smoke = runSmoke,
} = {}) {
  let startedAt
  try {
    startedAt = now()
    await smoke({ command, args, cwd, timeoutMs, spawnOptions: { ...spawnOptions, ...(env ? { env } : {}) } })
    return { ok: true, elapsedMs: now() - startedAt }
  } catch (error) {
    let elapsedMs = 0
    if (startedAt !== undefined) {
      try {
        elapsedMs = now() - startedAt
      } catch {
        elapsedMs = 0
      }
    }
    return { ok: false, elapsedMs, error: error instanceof Error ? error.message : String(error), reason: reasonOf(error) }
  }
}

const defaultRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/** Scan for macOS dataless files and report whether the scan was usable. */
export function countDatalessFiles(dir, { platform = process.platform, run = defaultRun } = {}) {
  if (platform !== 'darwin') return { count: null, status: 'unsupported' }
  try {
    const result = run('find', [dir, '-type', 'f', '-flags', '+dataless'])
    if (!result?.ok) return { count: null, status: 'failed' }
    return {
      count: result.output.split(/\r?\n/).filter((line) => line.trim() !== '').length,
      status: 'ok',
    }
  } catch {
    return { count: null, status: 'failed' }
  }
}

/** Classify startup health, keeping handshake failure distinct from slow startup. */
export function classifyStartup(probe, dataless, { budgetMs = STARTUP_BUDGET_MS } = {}) {
  if (!probe?.ok) {
    const reason = probe?.error ? `: ${probe.error}` : ''
    const fix = probe.reason === STARTUP_REASON_TIMEOUT ? CLOUD_SYNC_FIX : LAUNCHER_FIX
    return { level: 'fail', detail: `server failed to start${reason}`, fix }
  }
  if (probe.elapsedMs > budgetMs) {
    return { level: 'warn', detail: `server startup took ${probe.elapsedMs}ms (budget ${budgetMs}ms)`, fix: CLOUD_SYNC_FIX }
  }
  if (dataless?.status === 'failed') {
    return {
      level: 'warn', detail: `server started in ${probe.elapsedMs}ms; dataless file scan unavailable`, fix: CLOUD_SYNC_FIX,
    }
  }
  if ((dataless?.count ?? 0) > 0) {
    return {
      level: 'warn', detail: `server started in ${probe.elapsedMs}ms; ${dataless.count} dataless file(s) found`, fix: CLOUD_SYNC_FIX,
    }
  }
  return { level: 'ok', detail: `server started in ${probe.elapsedMs}ms` }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const main = async () => {
    const probe = await probeStartup({ command: process.execPath, args: [distEntry] })
    const datalessCount = existsSync(path.dirname(distEntry)) ? countDatalessFiles(path.dirname(distEntry)) : null
    return classifyStartup(probe, datalessCount)
  }
  main().then((classification) => {
    console.log(JSON.stringify(classification))
    if (classification.level === 'fail') process.exit(1)
  }, (error) => {
    console.log(JSON.stringify({ level: 'fail', detail: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
  })
}
