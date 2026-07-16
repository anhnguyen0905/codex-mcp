import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { listSessions } from '../src/sessionStore.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

/** Build a fake $CODEX_HOME with `sessions/YYYY/MM/DD/rollout-*.jsonl` for testing. */
const makeCodexHome = (files: Array<{ date: string; iso: string; id: string; cwd?: string; badFirstLine?: string }>): string => {
  const home = mkdtempSync(join(tmpdir(), 'codex-store-'))
  tempDirs.push(home)
  for (const f of files) {
    const [y, m, d] = f.date.split('-')
    const dir = join(home, 'sessions', y, m, d)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `rollout-${f.iso}-${f.id}.jsonl`)
    const line = f.badFirstLine ?? JSON.stringify({
      timestamp: f.iso,
      type: 'session_meta',
      payload: { id: f.id, cwd: f.cwd ?? '/some/cwd', timestamp: f.iso, cli_version: '0.144.0' },
    })
    // Add a second (event) line to be realistic.
    writeFileSync(filePath, `${line}\n${JSON.stringify({ type: 'event_msg', payload: {} })}\n`)
  }
  return home
}

describe('listSessions', () => {
  test('returns [] when the sessions dir does not exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-store-empty-'))
    tempDirs.push(home)
    const sessions = await listSessions({ codexHome: home })
    expect(sessions).toEqual([])
  })

  test('extracts sessionId and cwd from the session_meta first line', async () => {
    const home = makeCodexHome([
      { date: '2026-07-14', iso: '2026-07-14T10-11-24', id: 'abc-111', cwd: '/w/one' },
      { date: '2026-07-14', iso: '2026-07-14T10-11-25', id: 'abc-222', cwd: '/w/two' },
    ])
    const sessions = await listSessions({ codexHome: home })

    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['abc-111', 'abc-222'])
    expect(sessions.find((s) => s.sessionId === 'abc-111')?.cwd).toBe('/w/one')
    expect(sessions.every((s) => s.cliVersion === '0.144.0')).toBe(true)
  })

  test('returns newest first (filename encodes ISO timestamp)', async () => {
    const home = makeCodexHome([
      { date: '2026-07-14', iso: '2026-07-14T10-11-24', id: 'older' },
      { date: '2026-07-15', iso: '2026-07-15T09-00-00', id: 'newer' },
    ])
    const sessions = await listSessions({ codexHome: home })
    expect(sessions[0].sessionId).toBe('newer')
    expect(sessions[1].sessionId).toBe('older')
  })

  test('filters by cwd (exact match)', async () => {
    const home = makeCodexHome([
      { date: '2026-07-14', iso: '2026-07-14T10-11-24', id: 'a', cwd: '/w/one' },
      { date: '2026-07-14', iso: '2026-07-14T10-11-25', id: 'b', cwd: '/w/two' },
      { date: '2026-07-14', iso: '2026-07-14T10-11-26', id: 'c', cwd: '/w/one' },
    ])
    const sessions = await listSessions({ codexHome: home, cwd: '/w/one' })
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'c'])
  })

  test('skips malformed files without failing the listing', async () => {
    const home = makeCodexHome([
      { date: '2026-07-14', iso: '2026-07-14T10-11-24', id: 'good' },
      { date: '2026-07-14', iso: '2026-07-14T10-11-25', id: 'ignored', badFirstLine: '{not json' },
      { date: '2026-07-14', iso: '2026-07-14T10-11-26', id: 'wrong', badFirstLine: '{"type":"event_msg","payload":{}}' },
    ])
    const sessions = await listSessions({ codexHome: home })
    expect(sessions.map((s) => s.sessionId)).toEqual(['good'])
  })

  test('respects limit', async () => {
    const home = makeCodexHome(
      Array.from({ length: 5 }, (_, i) => ({
        date: '2026-07-14',
        iso: `2026-07-14T10-11-${String(20 + i).padStart(2, '0')}`,
        id: `s${i}`,
      })),
    )
    const sessions = await listSessions({ codexHome: home, limit: 2 })
    expect(sessions).toHaveLength(2)
    // Should be the two newest by filename (s4, s3).
    expect(sessions.map((s) => s.sessionId)).toEqual(['s4', 's3'])
  })
})
