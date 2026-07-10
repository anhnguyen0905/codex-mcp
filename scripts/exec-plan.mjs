#!/usr/bin/env node
// Drive codex_execute / codex_continue via the real MCP server, with long timeouts.
// usage:
//   exec-plan.mjs execute <projectDir>
//   exec-plan.mjs continue <projectDir> <sessionId> <feedbackFile>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'dist', 'index.js')
const CLIENT_TIMEOUT_MS = 40 * 60 * 1000
const CODEX_TIMEOUT_MS = 35 * 60 * 1000

const [mode, projectDir, sessionId, feedbackFile] = process.argv.slice(2)
if (!mode || !projectDir) {
  console.error('usage: exec-plan.mjs <execute|continue> <projectDir> [sessionId] [feedbackFile]')
  process.exit(1)
}

const planPath = join(projectDir, '.codex-flow', 'PLAN.md')
const plan = readFileSync(planPath, 'utf8')

const client = new Client({ name: 'exec-plan', version: '0.0.1' })
await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER] }))

const common = { cwd: projectDir, sandbox: 'workspace-write', timeoutMs: CODEX_TIMEOUT_MS }
let call
if (mode === 'execute') {
  const prompt = [
    'You are implementing a plan. The plan file is at .codex-flow/PLAN.md in your working directory.',
    'Read it and implement it EXACTLY. Follow the acceptance criteria. Run `pytest` before finishing.',
    'Do not deviate from the "Out of scope" section.',
    '',
    '===== BEGIN PLAN (copy, in case the file is unreadable) =====',
    plan,
    '===== END PLAN =====',
  ].join('\n')
  call = { name: 'codex_execute', arguments: { prompt, ...common } }
} else if (mode === 'continue') {
  const feedback = readFileSync(feedbackFile, 'utf8')
  call = { name: 'codex_continue', arguments: { sessionId, prompt: feedback, ...common } }
} else {
  console.error('unknown mode:', mode)
  process.exit(1)
}

console.log(`>>> calling ${call.name} (cwd=${projectDir})`)
const started = Date.now()
const result = await client.callTool(call, undefined, {
  timeout: CLIENT_TIMEOUT_MS,
  resetTimeoutOnProgress: true,
})
const secs = ((Date.now() - started) / 1000).toFixed(0)
console.log(`>>> done in ${secs}s, isError=${result.isError ?? false}`)
const text = result.content?.[0]?.text ?? ''
console.log(text)

try {
  const payload = JSON.parse(text)
  if (payload.sessionId) {
    writeFileSync(join(projectDir, '.codex-flow', 'session.txt'), payload.sessionId)
    console.log('>>> sessionId saved:', payload.sessionId)
  }
} catch {
  /* non-JSON error payloads are already printed above */
}

await client.close()
process.exit(result.isError ? 2 : 0)
