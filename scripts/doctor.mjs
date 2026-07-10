#!/usr/bin/env node
// First-time setup check: verifies the toolchain codex-flow depends on and tells
// the user exactly what to do for anything missing. Exits non-zero on blockers.
import { spawnSync } from 'node:child_process'

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

const blockers = checks.filter((check) => !check.passed)
console.log('')
if (blockers.length === 0) {
  console.log('All good. Register the MCP server (see README) and run /codex-flow in Claude Code.')
} else {
  console.log(`${blockers.length} issue(s) to fix before using codex-flow — see the arrows above.`)
  process.exit(1)
}
