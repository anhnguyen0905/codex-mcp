import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { combineSinks } from '../src/progressNotifier.js'
import { createServer, cwdLockKey } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('cwdLockKey', () => {
  test('folds case on case-insensitive platforms so path spellings share one lock', () => {
    expect(cwdLockKey('/Repo/Project', 'win32')).toBe(cwdLockKey('/repo/project', 'win32'))
    expect(cwdLockKey('/Repo/Project', 'darwin')).toBe(cwdLockKey('/repo/project', 'darwin'))
  })

  test('preserves case on linux', () => {
    expect(cwdLockKey('/Repo/Project', 'linux')).not.toBe(cwdLockKey('/repo/project', 'linux'))
  })

  test('resolves symlinks to the physical directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-lock-'))
    tempDirs.push(dir)

    // realpath of an existing dir must match itself regardless of trailing indirection
    expect(cwdLockKey(dir)).toBe(cwdLockKey(join(dir, '.')))
  })

  test('stays stable when the leaf dir does not exist yet, then is created mid-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-lock-'))
    tempDirs.push(dir)
    const leaf = join(dir, 'scaffolded')

    // Key computed before the dir exists must equal the key after it's created —
    // otherwise a run that scaffolds its own cwd could let a second run bypass the lock.
    const before = cwdLockKey(leaf)
    mkdirSync(leaf)
    const after = cwdLockKey(leaf)

    expect(before).toBe(after)
  })
})

describe('combineSinks isolation', () => {
  test('a throwing sink does not starve its siblings or leak', () => {
    const seen: string[] = []
    const combined = combineSinks(
      () => {
        throw new Error('broken stream')
      },
      (chunk) => seen.push(chunk.toString()),
    )

    expect(() => combined?.(Buffer.from('data'))).not.toThrow()
    expect(seen).toEqual(['data'])
  })

  test('a single throwing sink is also contained', () => {
    const combined = combineSinks(() => {
      throw new Error('broken')
    })

    expect(() => combined?.(Buffer.from('data'))).not.toThrow()
  })
})

describe('diff skipping on cancelled runs', () => {
  const connect = async (runFn: unknown, diffFn: unknown) => {
    const server = createServer({ runFn: runFn as never, diffFn: diffFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }

  test('does not capture a diff when the run was aborted', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
    }))
    const diffFn = vi.fn(async () => ({ status: '', patch: '', truncated: false }))
    const client = await connect(runFn, diffFn)

    const result = await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)

    expect(diffFn).not.toHaveBeenCalled()
    expect(payload.diff).toBeNull()
  })

  test('does not capture a diff when the run timed out', async () => {
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
    }))
    const diffFn = vi.fn(async () => ({ status: '', patch: '', truncated: false }))
    const client = await connect(runFn, diffFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'go', cwd: '/repo' } })

    expect(diffFn).not.toHaveBeenCalled()
  })
})
