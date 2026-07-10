import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const WORKDIR = mkdtempSync(join(tmpdir(), 'codex-mcp-e2e-'))

mkdirSync(WORKDIR, { recursive: true })

const client = new Client({ name: 'smoke', version: '0.0.1' })
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] })
await client.connect(transport)

const health = await client.callTool({ name: 'codex_health', arguments: {} })
console.log('=== codex_health ===')
console.log(health.content[0].text)

const exec = await client.callTool({
  name: 'codex_execute',
  arguments: {
    prompt: 'Create a file named hello.txt containing exactly the line "codex-mcp e2e ok". Do nothing else.',
    cwd: WORKDIR,
    sandbox: 'workspace-write',
    timeoutMs: 300000,
  },
})
console.log('=== codex_execute ===')
console.log('isError:', exec.isError ?? false)
console.log(exec.content[0].text)

const payload = JSON.parse(exec.content[0].text)

if (payload.sessionId) {
  const cont = await client.callTool({
    name: 'codex_continue',
    arguments: {
      sessionId: payload.sessionId,
      prompt: 'Append a second line "review feedback applied" to hello.txt. Do nothing else.',
      cwd: WORKDIR,
      sandbox: 'workspace-write',
      timeoutMs: 300000,
    },
  })
  console.log('=== codex_continue ===')
  console.log('isError:', cont.isError ?? false)
  console.log(cont.content[0].text)
}

await client.close()
