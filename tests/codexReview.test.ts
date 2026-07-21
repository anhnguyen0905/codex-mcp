import { describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const okOutcome: RunOutcome = { stdout: '', stderr: '', exitCode: 0, timedOut: false }

const connect = async (runFn: unknown, deps: Record<string, unknown> = {}) => {
  const server = createServer({ runFn: runFn as never, ...deps })
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

    expect(names).toEqual([
      'codex_batch',
      'codex_continue',
      'codex_execute',
      'codex_health',
      'codex_metrics',
      'codex_review',
      'codex_sessions',
    ])
  })

  test('always runs in the read-only sandbox with a review prompt', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })

    const [args, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    expect(args).toContain('read-only')
    expect(args).not.toContain('workspace-write')
    // The prompt travels over stdin; argv carries only the `-` marker.
    expect(args[args.length - 1]).toBe('-')
    const prompt = opts.stdinInput ?? ''
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

    const [, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    expect(opts.stdinInput).toContain('security of the auth module')
  })

  test('rejects a relative cwd', async () => {
    const client = await connect(vi.fn(async () => okOutcome))

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: 'relative/path' } })

    expect(result.isError).toBe(true)
  })
})

describe('codex_review baselineRef', () => {
  test('rejects a baselineRef starting with a dash without running Codex', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', baselineRef: '--upload-pack=/bin/sh' },
    })

    expect(result.isError).toBe(true)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('rejects a baselineRef containing whitespace', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    const result = await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', baselineRef: 'main; rm -rf' },
    })

    expect(result.isError).toBe(true)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('accepts a plausible ref and puts the baseline..HEAD range in the prompt', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const verifyRefFn = vi.fn(async () => true)
    const client = await connect(runFn, { verifyRefFn })

    const result = await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', baselineRef: 'abc1234' },
    })

    expect(result.isError).toBeFalsy()
    expect(verifyRefFn).toHaveBeenCalledWith('/repo', 'abc1234')
    const [, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    const prompt = opts.stdinInput ?? ''
    expect(prompt).toContain('git diff abc1234..HEAD')
    expect(prompt.toLowerCase()).toContain('uncommitted')
  })

  test('returns a clear error when the baselineRef does not resolve', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const verifyRefFn = vi.fn(async () => false)
    const client = await connect(runFn, { verifyRefFn })

    const result = await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', baselineRef: 'gone-branch' },
    })

    expect(result.isError).toBe(true)
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { error: string }
    expect(payload.error).toContain('gone-branch')
    expect(payload.error).toMatch(/does not resolve|not found|invalid/i)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('does not verify anything when baselineRef is absent (unchanged behavior)', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const verifyRefFn = vi.fn(async () => true)
    const client = await connect(runFn, { verifyRefFn })

    await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })

    expect(verifyRefFn).not.toHaveBeenCalled()
    const [args] = runFn.mock.calls[0] as [string[]]
    expect(args[args.length - 1]).not.toContain('..HEAD')
  })
})
