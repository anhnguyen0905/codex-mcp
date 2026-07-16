import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

const setupCodexHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  tempDirs.push(home)
  const dir = join(home, 'sessions', '2026', '07', '14')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'rollout-2026-07-14T10-00-00-uuid-A.jsonl'),
    JSON.stringify({
      timestamp: '2026-07-14T10:00:00Z',
      type: 'session_meta',
      payload: { id: 'uuid-A', cwd: '/w/x', timestamp: '2026-07-14T10:00:00Z', cli_version: '0.144.0' },
    }) + '\n',
  )
  return home
}

describe('codex_sessions tool', () => {
  test('lists prior sessions parsed from ~/.codex/sessions/', async () => {
    const home = setupCodexHome()
    const runFn = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) as RunOutcome)
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    try {
      const server = createServer({ runFn })
      const client = new Client({ name: 'test-client', version: '0.0.1' })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(st), client.connect(ct)])

      const r = await client.callTool({ name: 'codex_sessions', arguments: {} })
      const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

      expect(payload.total).toBe(1)
      expect(payload.sessions[0].sessionId).toBe('uuid-A')
      expect(payload.sessions[0].cwd).toBe('/w/x')
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  test('returns empty when no sessions dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'codex-empty-'))
    tempDirs.push(empty)
    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = empty
    try {
      const server = createServer({ runFn: vi.fn() as never })
      const client = new Client({ name: 'test-client', version: '0.0.1' })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(st), client.connect(ct)])

      const r = await client.callTool({ name: 'codex_sessions', arguments: {} })
      const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

      expect(payload).toEqual({ sessions: [], total: 0 })
      expect(r.isError).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })
})
