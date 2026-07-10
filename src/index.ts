#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

const main = async (): Promise<void> => {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('codex-mcp server running on stdio')
}

main().catch((error: unknown) => {
  console.error('codex-mcp fatal error:', error)
  process.exit(1)
})
