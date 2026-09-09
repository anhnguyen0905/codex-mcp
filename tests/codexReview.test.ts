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

describe('codex_review structured findings', () => {
  const findingsMessage = [
    'Findings:',
    '1. [HIGH] src/a.ts:42 — wrong status',
    '',
    '```json',
    JSON.stringify({
      findings: [{ severity: 'HIGH', file: 'src/a.ts', line: 42, summary: 'wrong status', expected: '404', observed: '200' }],
      improvements: [{ id: 'IMP-1', summary: 'dedupe validator', file: 'src/a.ts:15' }],
    }),
    '```',
  ].join('\n')
  const outcomeWith = (text: string): RunOutcome => ({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'rev-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ].join('\n'),
    stderr: '',
    exitCode: 0,
    timedOut: false,
  })
  const payloadOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0].text)

  test('asks Codex for the fenced json findings block in the review prompt', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })

    const [, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    expect(opts.stdinInput).toContain('```json')
    expect(opts.stdinInput).toContain('"findings"')
  })

  test('attaches parsed reviewFindings to the payload and structuredContent', async () => {
    const client = await connect(vi.fn(async () => outcomeWith(findingsMessage)))

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })
    const payload = payloadOf(result)

    expect(payload.reviewFindings.parsed).toBe(true)
    expect(payload.reviewFindings.findings).toEqual([
      { severity: 'HIGH', file: 'src/a.ts', line: 42, summary: 'wrong status', expected: '404', observed: '200' },
    ])
    expect(payload.reviewFindings.improvements[0].id).toBe('IMP-1')
    expect(payload.reviewFindings.droppedReasons).toEqual([])
    expect(payload.accepted).toBe(true)
    expect((result.structuredContent as { reviewFindings: unknown }).reviewFindings).toEqual(payload.reviewFindings)
  })

  test('reports parsed=false when Codex answered in prose only, without failing the tool', async () => {
    const client = await connect(vi.fn(async () => outcomeWith('Looks fine, no findings.')))

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })
    const payload = payloadOf(result)

    expect(result.isError).toBe(false)
    expect(payload.reviewFindings.parsed).toBe(false)
    expect(payload.reviewFindings.findings).toEqual([])
  })

  test('codex_execute payloads carry no reviewFindings field', async () => {
    const client = await connect(vi.fn(async () => outcomeWith('done')))

    const payload = payloadOf(await client.callTool({ name: 'codex_execute', arguments: { prompt: 'x', cwd: '/repo' } }))

    expect(payload).not.toHaveProperty('reviewFindings')
  })
})

describe('codex_review accepted verdict and recovery policy', () => {
  const outcomeWith = (text: string): RunOutcome => ({
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: 'rev-2' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ].join('\n'),
    stderr: '',
    exitCode: 0,
    timedOut: false,
  })
  const structured = '```json\n' + JSON.stringify({ findings: [], improvements: [] }) + '\n```'
  const payloadOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0].text)

  const withDroppedFinding =
    '```json\n' +
    JSON.stringify({
      findings: [{ severity: 'HIGH', file: 'src/a.ts', summary: 'no line', expected: 'e', observed: 'o' }],
      improvements: [],
    }) +
    '\n```'

  test('accepted is false and droppedReasons are reported when the review dropped an entry', async () => {
    // Arrange
    const client = await connect(vi.fn(async () => outcomeWith(withDroppedFinding)))

    // Act
    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })
    const payload = payloadOf(result)

    // Assert
    expect(result.isError).toBe(false)
    expect(payload.status).toBe('success')
    expect(payload.reviewFindings.parsed).toBe(true)
    expect(payload.reviewFindings.dropped).toBe(1)
    expect(payload.reviewFindings.droppedReasons).toEqual(['findings[0].line'])
    expect(payload.accepted).toBe(false)
  })

  test('accepted is true only when the review parsed', async () => {
    const parsed = payloadOf(await (await connect(vi.fn(async () => outcomeWith(structured)))).callTool({ name: 'codex_review', arguments: { cwd: '/repo' } }))
    const prose = payloadOf(await (await connect(vi.fn(async () => outcomeWith('looks fine')))).callTool({ name: 'codex_review', arguments: { cwd: '/repo' } }))

    expect(parsed.accepted).toBe(true)
    expect(parsed.reviewFindings.dropped).toBe(0)
    expect(parsed.reviewFindings.droppedReasons).toEqual([])
    expect(prose.status).toBe('success')
    expect(prose.accepted).toBe(false)
  })

  test('a timed-out review is not auto-resumed (single attempt)', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: JSON.stringify({ type: 'thread.started', thread_id: 'rev-timeout' }),
      stderr: '',
      exitCode: null,
      timedOut: true,
    }))
    const client = await connect(runFn)

    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } })
    const payload = payloadOf(result)

    expect(runFn).toHaveBeenCalledTimes(1)
    expect(payload.attempts).toBe(1)
    expect(payload.status).toBe('failed')
    expect(payload.accepted).toBe(false)
  })
})

/** A review run whose agent message ends in the fenced findings block the parser expects. */
const reviewOutcome = (findings: readonly Record<string, unknown>[]): RunOutcome => ({
  stdout: [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-review' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: [
          'prose',
          '```json',
          JSON.stringify({ findings, improvements: [] }),
          '```',
        ].join('\n'),
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'),
  stderr: '',
  exitCode: 0,
  timedOut: false,
})

const finding = (file: string): Record<string, unknown> => ({
  severity: 'HIGH',
  file,
  line: 12,
  summary: 'summary',
  expected: 'expected',
  observed: 'observed',
})

const payloadOf = (r: Awaited<ReturnType<Client['callTool']>>): Record<string, never> =>
  JSON.parse((r.content as Array<{ text: string }>)[0].text)

describe('codex_review scope (R4.1, R4.2, C3)', () => {
  test('appends the contract and file list under the fixed headings, contract first', async () => {
    // Arrange
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', scope: { files: ['src/a.ts', 'src/b.ts'], contract: 'ship A' } },
    })

    // Assert
    const [, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    const prompt = opts.stdinInput ?? ''
    expect(prompt).toContain('\n\n## Task contract\nship A')
    expect(prompt).toContain('\n\n## Task files\n- src/a.ts\n- src/b.ts')
    expect(prompt.indexOf('## Task contract')).toBeLessThan(prompt.indexOf('## Task files'))
  })

  test('omits the contract heading when only files are given', async () => {
    // Arrange
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    await client.callTool({
      name: 'codex_review',
      arguments: { cwd: '/repo', scope: { files: ['src/a.ts'] } },
    })

    // Assert
    const [, opts] = runFn.mock.calls[0] as [string[], { stdinInput?: string }]
    expect(opts.stdinInput).not.toContain('## Task contract')
    expect(opts.stdinInput).toContain('## Task files\n- src/a.ts')
  })

  test('annotates every finding with inScope and counts the out-of-scope ones', async () => {
    // Arrange — one declared file, one file outside the declared scope.
    const client = await connect(vi.fn(async () => reviewOutcome([finding('src/a.ts'), finding('src/other.ts')])))

    // Act
    const payload = payloadOf(
      await client.callTool({
        name: 'codex_review',
        arguments: { cwd: '/repo', scope: { files: ['src/a.ts'] } },
      }),
    )

    // Assert — annotated, never dropped.
    const reviewFindings = payload.reviewFindings as unknown as {
      findings: Array<{ file: string; inScope: boolean }>
      outOfScopeCount: number
      parsed: boolean
    }
    expect(reviewFindings.parsed).toBe(true)
    expect(reviewFindings.findings.map((f) => [f.file, f.inScope])).toEqual([
      ['src/a.ts', true],
      ['src/other.ts', false],
    ])
    expect(reviewFindings.outOfScopeCount).toBe(1)
  })

  test('leaves inScope and outOfScopeCount absent on an unscoped review', async () => {
    // Arrange
    const client = await connect(vi.fn(async () => reviewOutcome([finding('src/a.ts')])))

    // Act
    const payload = payloadOf(await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } }))

    // Assert
    const reviewFindings = payload.reviewFindings as unknown as {
      findings: Array<Record<string, unknown>>
      outOfScopeCount?: number
    }
    expect(reviewFindings.outOfScopeCount).toBeUndefined()
    expect(reviewFindings.findings[0]).not.toHaveProperty('inScope')
  })

  test('does not change accepted: an out-of-scope finding is still a clean parse', async () => {
    // Arrange
    const client = await connect(vi.fn(async () => reviewOutcome([finding('src/other.ts')])))

    // Act
    const payload = payloadOf(
      await client.callTool({
        name: 'codex_review',
        arguments: { cwd: '/repo', scope: { files: ['src/a.ts'] } },
      }),
    )

    // Assert
    expect(payload.accepted).toBe(true)
  })

  test.each([
    ['an empty files array', { files: [] }],
    ['an empty path entry', { files: [''] }],
    ['more than 200 files', { files: Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`) }],
    ['a contract over 4000 chars', { files: ['src/a.ts'], contract: 'x'.repeat(4001) }],
  ])('rejects %s without running Codex', async (_label, scope) => {
    // Arrange
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    const result = await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo', scope } })

    // Assert
    expect(result.isError).toBe(true)
    expect(runFn).not.toHaveBeenCalled()
  })

  test('accepts exactly 200 files and a 4000-char contract', async () => {
    // Arrange
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    const result = await client.callTool({
      name: 'codex_review',
      arguments: {
        cwd: '/repo',
        scope: { files: Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`), contract: 'x'.repeat(4000) },
      },
    })

    // Assert
    expect(result.isError).toBeFalsy()
    expect(runFn).toHaveBeenCalledTimes(1)
  })
})

describe('codex_review redaction ordering (R5.2, C4)', () => {
  test('redacts the agent message BEFORE parsing, so no finding field can carry a secret', async () => {
    // Arrange — the secret sits inside the fenced findings block the parser reads.
    const secret = `sk-ant-api03-${'A'.repeat(40)}`
    const client = await connect(
      vi.fn(async () => reviewOutcome([{ ...finding('src/a.ts'), summary: `leaked ${secret}` }])),
    )

    // Act
    const payload = payloadOf(await client.callTool({ name: 'codex_review', arguments: { cwd: '/repo' } }))

    // Assert
    const reviewFindings = payload.reviewFindings as unknown as { findings: Array<{ summary: string }> }
    expect(reviewFindings.findings[0].summary).not.toContain(secret)
    expect(reviewFindings.findings[0].summary).toContain('[REDACTED:')
    expect(payload.agentMessage as unknown as string).not.toContain(secret)
    expect(payload.redactions as unknown as number).toBeGreaterThan(0)
  })
})
