#!/usr/bin/env node
// Generic MCP client: node scripts/call-tool.mjs <toolName> '<jsonArgs>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [toolName, jsonArgs = '{}'] = process.argv.slice(2)
if (!toolName) {
  console.error('usage: call-tool.mjs <toolName> <jsonArgs>')
  process.exit(1)
}

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const client = new Client({ name: 'call-tool', version: '0.0.1' })
await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath] }))

const result = await client.callTool({ name: toolName, arguments: JSON.parse(jsonArgs) })
console.log('isError:', result.isError ?? false)
console.log(result.content?.[0]?.text ?? '')
await client.close()
process.exit(result.isError ? 2 : 0)
