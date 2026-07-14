import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { captureWorkspaceDiff } from '../src/workspaceDiff.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const tempDirs: string[] = []

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-diff-'))
  tempDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'original\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('captureWorkspaceDiff', () => {
  test('reports modified and untracked files with a patch', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'brand new\n')

    const diff = await captureWorkspaceDiff(repo)

    expect(diff).not.toBeNull()
    expect(diff?.status).toContain('a.txt')
    expect(diff?.status).toContain('new.txt')
    expect(diff?.patch).toContain('-original')
    expect(diff?.patch).toContain('+changed')
    expect(diff?.truncated).toBe(false)
  })

  test('returns an empty diff for a clean repo', async () => {
    const repo = makeRepo()

    const diff = await captureWorkspaceDiff(repo)

    expect(diff).toEqual({ status: '', statusTruncated: false, patch: '', truncated: false })
  })

  test('keeps a valid status when the repo has no commits yet (unborn HEAD)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-unborn-'))
    tempDirs.push(dir)
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'new.txt'), 'brand new\n')

    // `git diff HEAD` fails here (no HEAD), but status must still survive — not swallowed to null.
    const diff = await captureWorkspaceDiff(dir)

    expect(diff).not.toBeNull()
    expect(diff?.status).toContain('new.txt')
  })

  test('truncates an oversized status and flags it', async () => {
    const repo = makeRepo()
    for (let i = 0; i < 50; i++) writeFileSync(join(repo, `f${i}.txt`), 'x\n')

    const diff = await captureWorkspaceDiff(repo, { maxStatusBytes: 64 })

    expect(diff?.statusTruncated).toBe(true)
    expect(diff?.status.length).toBeLessThanOrEqual(64)
  })

  test('returns null outside a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-nogit-'))
    tempDirs.push(dir)

    const diff = await captureWorkspaceDiff(dir)

    expect(diff).toBeNull()
  })

  test('truncates very large patches', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), `${'x'.repeat(200)}\n`.repeat(1000))

    const diff = await captureWorkspaceDiff(repo, { maxPatchBytes: 1024 })

    expect(diff?.truncated).toBe(true)
    expect(diff?.patch.length).toBeLessThanOrEqual(1024)
  })
})

describe('server diff wiring', () => {
  test('includes the workspace diff in the tool payload', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
    const diffFn = vi.fn(async () => ({ status: 'M a.txt', patch: 'diff --git a/a.txt', truncated: false }))
    const server = createServer({ runFn: runFn as never, diffFn })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(diffFn).toHaveBeenCalledWith('/repo')
    expect(payload.diff).toEqual({ status: 'M a.txt', patch: 'diff --git a/a.txt', truncated: false })
  })

  test('diff failures never fail the tool call', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
    const diffFn = vi.fn(async () => {
      throw new Error('git exploded')
    })
    const server = createServer({ runFn: runFn as never, diffFn: diffFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(result.isError).toBeFalsy()
    expect(payload.diff).toBeNull()
  })
})
