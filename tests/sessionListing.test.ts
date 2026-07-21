import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { listSessions } from '../src/sessionStore.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface SessionFileSpec {
  date: string
  iso: string
  id: string
  cwd?: string
  /** Override the file mtime (seconds precision) to simulate later activity. */
  mtime?: Date
}

const makeCodexHome = (files: SessionFileSpec[]): string => {
  const home = mkdtempSync(join(tmpdir(), 'codex-listing-'))
  tempDirs.push(home)
  for (const file of files) {
    const [y, m, d] = file.date.split('-')
    const dir = join(home, 'sessions', y, m, d)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `rollout-${file.iso}-${file.id}.jsonl`)
    const meta = JSON.stringify({
      timestamp: file.iso,
      type: 'session_meta',
      payload: { id: file.id, cwd: file.cwd ?? '/some/cwd', timestamp: file.iso, cli_version: '0.144.0' },
    })
    writeFileSync(filePath, `${meta}\n`)
    if (file.mtime) utimesSync(filePath, file.mtime, file.mtime)
  }
  return home
}

describe('session listing accuracy (T4.5)', () => {
  test('cwd filter matches canonical paths (symlink resolves to the same session)', async () => {
    const realWorkspace = mkdtempSync(join(tmpdir(), 'codex-real-ws-'))
    tempDirs.push(realWorkspace)
    const linkParent = mkdtempSync(join(tmpdir(), 'codex-link-'))
    tempDirs.push(linkParent)
    const linkPath = join(linkParent, 'ws-link')
    symlinkSync(realWorkspace, linkPath)
    const home = makeCodexHome([
      { date: '2026-07-20', iso: '2026-07-20T10-00-00', id: 'in-ws', cwd: realWorkspace },
      { date: '2026-07-20', iso: '2026-07-20T11-00-00', id: 'elsewhere', cwd: '/w/other' },
    ])

    const sessions = await listSessions({ codexHome: home, cwd: linkPath })

    expect(sessions.map((s) => s.sessionId)).toEqual(['in-ws'])
  })

  test('cwd filter tolerates nonexistent paths with an exact-path fallback', async () => {
    const home = makeCodexHome([
      { date: '2026-07-20', iso: '2026-07-20T10-00-00', id: 'gone', cwd: '/does/not/exist/anymore' },
      { date: '2026-07-20', iso: '2026-07-20T11-00-00', id: 'other', cwd: '/w/other' },
    ])

    const sessions = await listSessions({ codexHome: home, cwd: '/does/not/exist/anymore' })

    expect(sessions.map((s) => s.sessionId)).toEqual(['gone'])
  })

  test('orders sessions by real last activity (file mtime), not creation timestamp', async () => {
    // "old" was created first but touched most recently — it must sort first.
    const home = makeCodexHome([
      { date: '2026-07-10', iso: '2026-07-10T08-00-00', id: 'old-but-active', mtime: new Date('2026-07-20T12:00:00Z') },
      { date: '2026-07-15', iso: '2026-07-15T09-00-00', id: 'new-but-idle', mtime: new Date('2026-07-15T09:00:00Z') },
    ])

    const sessions = await listSessions({ codexHome: home })

    expect(sessions.map((s) => s.sessionId)).toEqual(['old-but-active', 'new-but-idle'])
  })

  test('lastActivity reflects the file mtime as an ISO timestamp', async () => {
    const lastTouch = new Date('2026-07-20T12:34:56Z')
    const home = makeCodexHome([
      { date: '2026-07-10', iso: '2026-07-10T08-00-00', id: 'touched', mtime: lastTouch },
    ])

    const sessions = await listSessions({ codexHome: home })

    expect(sessions).toHaveLength(1)
    expect(new Date(sessions[0].lastActivity).getTime()).toBe(lastTouch.getTime())
  })

  test('limit applies after mtime ordering (keeps the most recently active)', async () => {
    const home = makeCodexHome([
      { date: '2026-07-10', iso: '2026-07-10T08-00-00', id: 'active', mtime: new Date('2026-07-21T00:00:00Z') },
      { date: '2026-07-15', iso: '2026-07-15T09-00-00', id: 'idle-1', mtime: new Date('2026-07-15T09:00:00Z') },
      { date: '2026-07-16', iso: '2026-07-16T09-00-00', id: 'idle-2', mtime: new Date('2026-07-16T09:00:00Z') },
    ])

    const sessions = await listSessions({ codexHome: home, limit: 2 })

    expect(sessions.map((s) => s.sessionId)).toEqual(['active', 'idle-2'])
  })
})
