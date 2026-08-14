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

const { execFileCall } = vi.hoisted(() => ({ execFileCall: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      execFileCall(args[0], args[1])
      return Reflect.apply(actual.execFile, actual, args)
    },
  }
})

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
    expect(Buffer.byteLength(diff?.status ?? '', 'utf8')).toBeLessThanOrEqual(64)
  })

  test('truncates the patch by BYTES (not UTF-16 length) without leaving a broken multibyte tail', async () => {
    const repo = makeRepo()
    // multibyte content: each 'é' is 2 UTF-8 bytes; String.length would under-count vs bytes
    writeFileSync(join(repo, 'a.txt'), `${'é'.repeat(2000)}\n`)

    const diff = await captureWorkspaceDiff(repo, { maxPatchBytes: 100 })

    expect(diff?.truncated).toBe(true)
    expect(Buffer.byteLength(diff?.patch ?? '', 'utf8')).toBeLessThanOrEqual(100)
    expect(diff?.patch.endsWith('�')).toBe(false) // no split-codepoint replacement char
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

  test('formats rename paths with Git-compatible independent quoting', async () => {
    const repo = makeRepo()
    const statusPorcelainZ = Promise.resolve(
      'R  dest.txt\0orig"name.txt\0R  dest\nname.txt\0orig.txt\0R  plain-dest.txt\0plain-orig.txt\0',
    )

    const diff = await captureWorkspaceDiff(repo, { statusPorcelainZ })

    expect(diff?.status).toBe(
      'R  "orig\\"name.txt" -> dest.txt\n' +
        'R  orig.txt -> "dest\\nname.txt"\n' +
        'R  plain-orig.txt -> plain-dest.txt',
    )
  })

  test('C-quotes newline and double-quote bytes like git status porcelain', async () => {
    const repo = makeRepo()
    const statusPorcelainZ = Promise.resolve('?? line\nbreak.txt\0?? quote"name.txt\0')

    const diff = await captureWorkspaceDiff(repo, { statusPorcelainZ })

    expect(diff?.status).toBe('?? "line\\nbreak.txt"\n?? "quote\\"name.txt"')
  })

  test('C-quotes backslash, control, DEL, and non-ASCII bytes', async () => {
    const repo = makeRepo()
    const statusPorcelainZ = Promise.resolve(
      '?? slash\\name\0?? tab\tname\0?? carriage\rname\0?? bell\u0007name\0?? café\0?? del\u007fname\0',
    )

    const diff = await captureWorkspaceDiff(repo, { statusPorcelainZ })

    expect(diff?.status).toBe(
      '?? "slash\\\\name"\n' +
        '?? "tab\\tname"\n' +
        '?? "carriage\\rname"\n' +
        '?? "bell\\007name"\n' +
        '?? "caf\\303\\251"\n' +
        '?? "del\\177name"',
    )
  })
})

describe('server diff wiring', () => {
  test('shares post-run status while preserving dirty-repo diff and attribution', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'dirty before run\n')
    const runFn = vi.fn(async (): Promise<RunOutcome> => {
      writeFileSync(join(repo, 'new.txt'), 'brand new\n')
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    execFileCall.mockClear()

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'go', cwd: repo, terminal: false },
    })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    const gitCalls = execFileCall.mock.calls.filter(([command]) => command === 'git')

    expect(gitCalls).toHaveLength(3)
    expect(payload.diff).toEqual({
      status: ' M a.txt\n?? new.txt',
      statusTruncated: false,
      patch: expect.stringContaining('+dirty before run'),
      truncated: false,
    })
    expect(payload.attribution).toEqual({
      files: [
        { path: 'a.txt', status: ' M', attribution: 'preExisting' },
        { path: 'new.txt', status: '??', attribution: 'changedByRun' },
      ],
      untracked: [
        {
          path: 'new.txt',
          content: 'brand new\n',
          truncated: false,
          binary: false,
        },
      ],
    })
  })

  test('starts diff and attribution concurrently and isolates a diff failure', async () => {
    let diffSettled = false
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    const diffFn = vi.fn(async () => {
      await Promise.resolve()
      diffSettled = true
      throw new Error('git exploded')
    })
    const attribution = { files: [], untracked: [] }
    const attributeFn = vi.fn(async () => {
      expect(diffSettled).toBe(false)
      return attribution
    })
    const server = createServer({
      runFn: runFn as never,
      diffFn: diffFn as never,
      snapshotFn: vi.fn(async () => null),
      attributeFn,
    })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'go', cwd: '/repo' },
    })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(payload.diff).toBeNull()
    expect(payload.attribution).toEqual(attribution)
  })

  test('includes the workspace diff in the tool payload', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }))
    const diffFn = vi.fn(async () => ({ status: 'M a.txt', statusTruncated: false, patch: 'diff --git a/a.txt', truncated: false }))
    const server = createServer({ runFn: runFn as never, diffFn })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(diffFn).toHaveBeenCalledWith('/repo')
    expect(payload.diff).toEqual({ status: 'M a.txt', statusTruncated: false, patch: 'diff --git a/a.txt', truncated: false })
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
