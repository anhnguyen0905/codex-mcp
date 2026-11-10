#!/usr/bin/env node
// First-time setup check: verifies the toolchain codex-flow depends on and tells
// the user exactly what to do for anything missing. Exits non-zero on blockers.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describeHistoryDir, resolveLogPath } from './session-cost.mjs'
import { classifyStartup, countDatalessFiles, probeStartup, resolveLauncher } from './startup-probe.mjs'

const isWindows = process.platform === 'win32'
const MIN_NODE_MAJOR = 20

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: isWindows })
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

const checks = []
let startupProbed = false
let startupFailed = false
let launcherProbed = false
let localDistProbed = false
const addCheck = (name, passed, detail, fix) => {
  checks.push({ name, passed, detail, fix })
  const icon = passed ? '✅' : '❌'
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!passed && fix) console.log(`   → ${fix}`)
}

console.log('codex-mcp doctor\n')

// 1. Node version
const nodeMajor = Number(process.versions.node.split('.')[0])
addCheck(
  `Node.js ≥ ${MIN_NODE_MAJOR}`,
  nodeMajor >= MIN_NODE_MAJOR,
  `found ${process.versions.node}`,
  `Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org`,
)

// 2. Codex CLI installed
const codexBin = process.env.CODEX_BIN?.trim() || (isWindows ? 'codex.cmd' : 'codex')
const codexVersion = run(codexBin, ['--version'])
addCheck(
  'Codex CLI installed',
  codexVersion.ok,
  codexVersion.ok ? codexVersion.output : 'not found on PATH',
  'npm i -g @openai/codex  (or set CODEX_BIN to your binary)',
)

// 3. Codex CLI logged in
if (codexVersion.ok) {
  const login = run(codexBin, ['login', 'status'])
  const loggedIn = login.ok && /logged in/i.test(login.output) && !/not logged in/i.test(login.output)
  addCheck(
    'Codex CLI logged in',
    loggedIn,
    login.output.split('\n')[0] ?? '',
    'Run: codex login  (ChatGPT Plus/Pro/Team) — or set OPENAI_API_KEY',
  )
}

// 4. Claude Code CLI installed (login happens inside Claude Code itself)
const claudeVersion = run('claude', ['--version'])
addCheck(
  'Claude Code CLI installed',
  claudeVersion.ok,
  claudeVersion.ok ? claudeVersion.output.split('\n')[0] : 'not found on PATH',
  'Install from https://claude.com/claude-code — then run `claude` once and log in when prompted',
)

// 5. MCP server startup
const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
const probeLauncher = process.argv.includes('--probe-launcher')
const launcherPath = fileURLToPath(new URL('../.mcp.json', import.meta.url))
let launcher
if (probeLauncher) {
  try {
    const config = JSON.parse(readFileSync(launcherPath, 'utf8'))
    const candidate = config?.mcpServers?.codex
    const env = candidate?.env
    const validEnv = env === undefined || (env !== null && typeof env === 'object' &&
      !Array.isArray(env) && Object.values(env).every((value) => typeof value === 'string'))
    if (typeof candidate?.command !== 'string' || candidate.command.length === 0 ||
      (candidate.args !== undefined && (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== 'string'))) || !validEnv) {
      throw new Error('launcher config has invalid types')
    }
    launcher = resolveLauncher(candidate)
  } catch {
    console.log(
      'ℹ️  MCP server startup not verified — launcher config missing or invalid (.mcp.json)',
    )
  }
}
const localTarget = existsSync(distEntry) ? { command: process.execPath, args: [distEntry] } : null
const startupTarget = probeLauncher ? launcher : localTarget
if (startupTarget) {
  startupProbed = true
  launcherProbed = probeLauncher
  localDistProbed = !probeLauncher
  const startupProbe = await probeStartup(startupTarget)
  const distDir = fileURLToPath(new URL('../dist', import.meta.url))
  const dataless = existsSync(distDir)
    ? countDatalessFiles(distDir)
    : { count: null, status: 'unsupported' }
  const classification = classifyStartup(startupProbe, dataless)
  startupFailed = classification.level === 'fail'
  if (classification.level === 'fail') addCheck('MCP server starts', false, classification.detail, classification.fix)
  else if (classification.level === 'warn') {
    console.log(`⚠️  MCP server starts — ${classification.detail}\n   → ${classification.fix}`)
  }
  else addCheck('MCP server starts', true, classification.detail)
} else {
  console.log('ℹ️  MCP server startup not verified — dist/index.js not present')
}

// 6. Metrics history archive (R6.4) — informational: nothing here can block a first run.
const history = describeHistoryDir(resolveLogPath({}, process.env))
console.log(`ℹ️  Metrics history — ${history.dir} (${history.files} files, ${history.bytes} bytes)`)
if (history.readError !== undefined) console.log(`   → ${history.readError}`)

const blockers = checks.filter((check) => !check.passed)
console.log('')
if (blockers.length === 0) {
  if (launcherProbed && !startupFailed) {
    console.log('All good. Register the MCP server (see README) and run /codex-flow in Claude Code.')
  }
  else if (localDistProbed && !startupFailed) {
    console.log('Toolchain ok; local dist/ server starts — the .mcp.json launcher was not probed '
      + '(run: node scripts/doctor.mjs --probe-launcher)')
  }
  else console.log('Toolchain ok; MCP server startup not verified — run: node scripts/doctor.mjs --probe-launcher')
} else {
  console.log(`${blockers.length} issue(s) to fix before using codex-flow — see the arrows above.`)
  process.exit(1)
}
