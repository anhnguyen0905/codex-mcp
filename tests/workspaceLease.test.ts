import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { acquireWorkspaceLease, leasePathFor } from '../src/workspaceLease.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const okOutcome: RunOutcome = { stdout: '', stderr: '', exitCode: 0, timedOut: false }

const tempDirs: string[] = []

const makeDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Spawn a short-lived process and return its (now dead) pid. */
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', ''])
  if (typeof child.pid !== 'number') throw new Error('spawnSync returned no pid')
  return child.pid
}

describe('acquireWorkspaceLease', () => {
  test('rejects a second acquire on the same cwd while the first is held', async () => {
    const locksDir = makeDir('codex-mcp-locks-')
    const cwd = makeDir('codex-mcp-ws-')

    const lease = await acquireWorkspaceLease(cwd, 'run-1', { locksDir })

    await expect(acquireWorkspaceLease(cwd, 'run-2', { locksDir })).rejects.toThrow(
      /workspace busy \(pid \d+ since /,
    )
    lease.release()
  })

  test('reclaims a stale lease whose owning pid is dead', async () => {
    const locksDir = makeDir('codex-mcp-locks-')
    const cwd = makeDir('codex-mcp-ws-')
    const stale = {
      pid: deadPid(),
      startTimeMs: Date.now() - 60_000,
      runId: 'stale-run',
      hostname: 'test-host',
      cwd,
    }
    writeFileSync(leasePathFor(cwd, locksDir), JSON.stringify(stale))

    const lease = await acquireWorkspaceLease(cwd, 'run-2', { locksDir })

    const onDisk = JSON.parse(readFileSync(lease.leasePath, 'utf8')) as { runId: string; pid: number }
    expect(onDisk.runId).toBe('run-2')
    expect(onDisk.pid).toBe(process.pid)
    lease.release()
  })

  test('release then re-acquire works', async () => {
    const locksDir = makeDir('codex-mcp-locks-')
    const cwd = makeDir('codex-mcp-ws-')

    const first = await acquireWorkspaceLease(cwd, 'run-1', { locksDir })
    first.release()
    const second = await acquireWorkspaceLease(cwd, 'run-2', { locksDir })

    expect(second.leasePath).toBe(first.leasePath)
    second.release()
  })

  test('release is idempotent and tolerates a missing lease file', async () => {
    const locksDir = makeDir('codex-mcp-locks-')
    const cwd = makeDir('codex-mcp-ws-')

    const lease = await acquireWorkspaceLease(cwd, 'run-1', { locksDir })
    lease.release()

    expect(() => lease.release()).not.toThrow()
  })

  test('symlinked cwd variants map to one lease (realpath)', async () => {
    const locksDir = makeDir('codex-mcp-locks-')
    const cwd = makeDir('codex-mcp-ws-')
    const linkParent = makeDir('codex-mcp-ln-')
    const link = join(linkParent, 'alias')
    symlinkSync(cwd, link)

    expect(leasePathFor(link, locksDir)).toBe(leasePathFor(cwd, locksDir))

    const lease = await acquireWorkspaceLease(cwd, 'run-1', { locksDir })
    await expect(acquireWorkspaceLease(link, 'run-2', { locksDir })).rejects.toThrow(/workspace busy/)
    lease.release()
  })
})

describe('cross-process lease wiring in the server', () => {
  const connect = async (runFn: unknown) => {
    const server = createServer({ runFn: runFn as never })
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }

  test('a second server instance (fresh in-memory guard) is rejected by the lease', async () => {
    const cwd = makeDir('codex-mcp-ws-')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runA = vi.fn(async (): Promise<RunOutcome> => {
      await gate
      return okOutcome
    })
    const runB = vi.fn(async (): Promise<RunOutcome> => okOutcome)
    const clientA = await connect(runA)
    const clientB = await connect(runB)

    const first = clientA.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd } })
    await vi.waitFor(() => expect(runA).toHaveBeenCalled())
    const second = await clientB.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd } })

    expect(second.isError).toBe(true)
    const payload = JSON.parse((second.content as Array<{ text: string }>)[0].text) as { error: string }
    expect(payload.error).toMatch(/workspace busy/i)

    release?.()
    await first
    const retry = await clientB.callTool({ name: 'codex_execute', arguments: { prompt: 'c', cwd } })
    expect(retry.isError).toBeFalsy()
  })
})
