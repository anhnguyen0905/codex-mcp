import { describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const okOutcome: RunOutcome = { stdout: '', stderr: '', exitCode: 0, timedOut: false }

const connect = async (runFn: unknown) => {
  const server = createServer({ runFn: runFn as never })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}

describe('codex_review tool', () => {
  test('is listed alongside the other tools', async () => {
    const client = await connect(vi.fn(async () => okOutcome))

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()

    expect(names).toEqual(['codex_continue', 'codex_execute', 'codex_health', 'codex_metrics', 'codex_review'])
  })

  test('always runs in the read-only sandbox with a review prompt', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })

    const [args] = runFn.mock.calls[0] as [string[]]
    expect(args).toContain('read-only')
    expect(args).not.toContain('workspace-write')
    const prompt = args[args.length - 1]
    expect(prompt.toLowerCase()).toContain('review')
    expect(prompt.toLowerCase()).toContain('do not modify')
  })

  test('appends the caller focus to the review prompt', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', focus: 'security of the auth module' },
    })

    const [args] = runFn.mock.calls[0] as [string[]]
    expect(args[args.length - 1]).toContain('security of the auth module')
  })

  test('rejects a relative cwd', async () => {
    const client = await connect(vi.fn(async () => okOutcome))

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: 'relative/path' } })

    expect(result.isError).toBe(true)
  })
})
