import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  attributeWorkspaceDiff,
  captureWorkspaceSnapshot,
  MAX_UNTRACKED_FILE_BYTES,
  verifyGitRef,
  type RunAttribution,
} from '../src/workspaceDiff.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-attr-'))
  tempDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'original a\n')
  writeFileSync(join(dir, 'b.txt'), 'original b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const attributionByPath = (attribution: RunAttribution): Record<string, string> =>
  Object.fromEntries(attribution.files.map((f) => [f.path, f.attribution]))

describe('captureWorkspaceSnapshot', () => {
  test('returns null outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-nogit-'))
    tempDirs.push(dir)

    expect(await captureWorkspaceSnapshot(dir)).toBeNull()
  })

  test('records a content hash per dirty/untracked file', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'dirty before run\n')
    writeFileSync(join(repo, 'loose.txt'), 'untracked before run\n')

    const snapshot = await captureWorkspaceSnapshot(repo)

    expect(snapshot).not.toBeNull()
    expect(Object.keys(snapshot?.fileHashes ?? {}).sort()).toEqual(['a.txt', 'loose.txt'])
    expect(snapshot?.fileHashes['a.txt']).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('attributeWorkspaceDiff', () => {
  test('pre-existing dirty file is NOT attributed to the run; file modified by run IS', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'dirty before run\n')
    const snapshot = await captureWorkspaceSnapshot(repo)
    writeFileSync(join(repo, 'b.txt'), 'changed by run\n')

    const attribution = await attributeWorkspaceDiff(repo, snapshot)

    expect(attribution).not.toBeNull()
    const byPath = attributionByPath(attribution as RunAttribution)
    expect(byPath['a.txt']).toBe('preExisting')
    expect(byPath['b.txt']).toBe('changedByRun')
  })

  test('a pre-existing dirty file modified AGAIN by the run is changedByRun', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'dirty before run\n')
    const snapshot = await captureWorkspaceSnapshot(repo)
    writeFileSync(join(repo, 'a.txt'), 'dirty before run, then touched by run\n')

    const attribution = await attributeWorkspaceDiff(repo, snapshot)

    expect(attributionByPath(attribution as RunAttribution)['a.txt']).toBe('changedByRun')
  })

  test('untracked file created by the run has its content included', async () => {
    const repo = makeRepo()
    const snapshot = await captureWorkspaceSnapshot(repo)
    writeFileSync(join(repo, 'new.txt'), 'hello from the run\n')

    const attribution = await attributeWorkspaceDiff(repo, snapshot)

    expect(attribution?.untracked).toEqual([
      { path: 'new.txt', content: 'hello from the run\n', truncated: false, binary: false },
    ])
  })

  test('untracked content is bounded with a truncated flag', async () => {
    const repo = makeRepo()
    const snapshot = await captureWorkspaceSnapshot(repo)
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(1000))

    const attribution = await attributeWorkspaceDiff(repo, snapshot, { maxUntrackedFileBytes: 16 })

    const entry = attribution?.untracked.find((u) => u.path === 'big.txt')
    expect(entry?.truncated).toBe(true)
    expect(Buffer.byteLength(entry?.content ?? '', 'utf8')).toBeLessThanOrEqual(16)
  })

  test('the default untracked-content bound is 200KB', () => {
    expect(MAX_UNTRACKED_FILE_BYTES).toBe(200 * 1024)
  })

  test('binary untracked files are flagged and carry no content', async () => {
    const repo = makeRepo()
    const snapshot = await captureWorkspaceSnapshot(repo)
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))

    const attribution = await attributeWorkspaceDiff(repo, snapshot)

    expect(attribution?.untracked).toEqual([
      { path: 'blob.bin', content: null, truncated: false, binary: true },
    ])
  })

  test('a pre-existing untracked file untouched by the run is preExisting with no content block', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'loose.txt'), 'untracked before run\n')
    const snapshot = await captureWorkspaceSnapshot(repo)

    const attribution = await attributeWorkspaceDiff(repo, snapshot)

    expect(attributionByPath(attribution as RunAttribution)['loose.txt']).toBe('preExisting')
    expect(attribution?.untracked).toEqual([])
  })

  test('returns null outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-nogit-'))
    tempDirs.push(dir)

    expect(await attributeWorkspaceDiff(dir, null)).toBeNull()
  })
})

describe('verifyGitRef', () => {
  test('resolves true for an existing commit ref', async () => {
    const repo = makeRepo()

    expect(await verifyGitRef(repo, 'HEAD')).toBe(true)
  })

  test('resolves false for a missing ref', async () => {
    const repo = makeRepo()

    expect(await verifyGitRef(repo, 'no-such-branch')).toBe(false)
  })

  test('resolves false for a ref starting with a dash', async () => {
    const repo = makeRepo()

    expect(await verifyGitRef(repo, '--all')).toBe(false)
  })
})

describe('server run attribution wiring', () => {
  const connect = async (runFn: unknown, deps: Record<string, unknown> = {}) => {
    const server = createServer({ runFn: runFn as never, ...deps })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }

  const parsePayload = (result: { content?: unknown }) =>
    JSON.parse((result.content as Array<{ text: string }>)[0].text)

  test('captures the diff and a runId even when the run timed out', async () => {
    const runFn = vi.fn(
      async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
    )
    const diffFn = vi.fn(async () => ({ status: 'M a.txt', statusTruncated: false, patch: '', truncated: false }))
    const client = await connect(runFn, { diffFn })

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = parsePayload(result)

    expect(diffFn).toHaveBeenCalledWith('/repo')
    expect(payload.diff).toEqual({ status: 'M a.txt', statusTruncated: false, patch: '', truncated: false })
    expect(payload.runId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('captures the diff on aborted runs too', async () => {
    const runFn = vi.fn(
      async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true }),
    )
    const diffFn = vi.fn(async () => ({ status: '', statusTruncated: false, patch: '', truncated: false }))
    const client = await connect(runFn, { diffFn })

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })

    expect(diffFn).toHaveBeenCalled()
  })

  test('includes the snapshot-based attribution in the payload', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
    const diffFn = vi.fn(async () => null)
    const snapshot = { fileHashes: { 'a.txt': 'deadbeef' } }
    const snapshotFn = vi.fn(async () => snapshot)
    const attribution: RunAttribution = {
      files: [{ path: 'a.txt', status: ' M', attribution: 'preExisting' }],
      untracked: [],
    }
    const attributeFn = vi.fn(async () => attribution)
    const client = await connect(runFn, { diffFn, snapshotFn, attributeFn })

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = parsePayload(result)

    expect(snapshotFn).toHaveBeenCalledWith('/repo')
    expect(attributeFn).toHaveBeenCalledWith('/repo', snapshot)
    expect(payload.attribution).toEqual(attribution)
  })

  test('the runId flows into the metrics log entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-metrics-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'metrics.jsonl')
    const previous = process.env.CODEX_MCP_METRICS_LOG
    process.env.CODEX_MCP_METRICS_LOG = logPath
    try {
      const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
      const client = await connect(runFn, { diffFn: vi.fn(async () => null) })

      const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
      const payload = parsePayload(result)

      const lines = readFileSync(logPath, 'utf8').trim().split('\n')
      const entry = JSON.parse(lines[lines.length - 1]) as { runId?: string }
      expect(entry.runId).toBe(payload.runId)
    } finally {
      if (previous === undefined) delete process.env.CODEX_MCP_METRICS_LOG
      else process.env.CODEX_MCP_METRICS_LOG = previous
    }
  })
})
