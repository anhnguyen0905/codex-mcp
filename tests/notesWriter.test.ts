import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { writeNotes, type NotesRequest } from '../src/notesWriter.js'
import type { CodexResult } from '../src/types.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

const mkCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-notes-'))
  tempDirs.push(cwd)
  return cwd
}

const okParsed = (): CodexResult => ({
  sessionId: 'abc-123',
  agentMessage: 'ok',
  fileChanges: [{ path: 'a.ts', kind: 'edit' }],
  commands: [{ command: 'npm test', exitCode: 0 }],
  usage: null,
  errors: [],
})

const req = (cwd: string, overrides: Partial<NotesRequest> = {}): NotesRequest => ({
  cwd,
  sessionId: 'abc-123',
  prompt: 'implement feature X',
  mode: 'execute',
  parsed: okParsed(),
  exitCode: 0,
  startedAt: '2026-07-16T00:00:00.000Z',
  ...overrides,
})

describe('writeNotes', () => {
  test('writes a markdown note under .codex-flow/notes/<sessionId>.md', () => {
    const cwd = mkCwd()
    const path = writeNotes(req(cwd))

    expect(path).toBe(join(cwd, '.codex-flow', 'notes', 'abc-123.md'))
    const content = readFileSync(path!, 'utf8')
    expect(content).toContain('# Session abc-123')
    expect(content).toContain('- Cwd: ' + cwd)
    expect(content).toContain('implement feature X')
    expect(content).toContain('a.ts (edit)')
    expect(content).toContain('npm test')
  })

  test('creates the file with mode 0o600 (transcript may hold secrets)', () => {
    const cwd = mkCwd()
    const path = writeNotes(req(cwd))!
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('appends a Continuation block on mode=continue when the file already exists', () => {
    const cwd = mkCwd()
    writeNotes(req(cwd))
    const path = writeNotes(req(cwd, { mode: 'continue', prompt: 'fix the failing test' }))!
    const content = readFileSync(path, 'utf8')

    expect(content).toContain('# Session abc-123') // original header preserved
    expect(content).toContain('## Continuation @')
    expect(content).toContain('fix the failing test')
  })

  test('continue on a missing file seeds a header instead of dangling under nothing', () => {
    const cwd = mkCwd()
    const path = writeNotes(req(cwd, { mode: 'continue' }))!
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('# Session abc-123')
    expect(content).not.toContain('Continuation @')
  })

  test('refuses to write through a symlinked .codex-flow', () => {
    const cwd = mkCwd()
    const target = mkCwd()
    symlinkSync(target, join(cwd, '.codex-flow'))

    expect(() => writeNotes(req(cwd))).toThrow(/symlink/i)
    expect(existsSync(join(target, 'notes'))).toBe(false)
  })

  test('refuses to write through a symlinked nested notes dir', () => {
    const cwd = mkCwd()
    const target = mkCwd()
    mkdirSync(join(cwd, '.codex-flow'))
    symlinkSync(target, join(cwd, '.codex-flow', 'notes'))

    expect(() => writeNotes(req(cwd))).toThrow(/symlink/i)
  })

  test('rejects unsafe sessionIds (path traversal / weird chars)', () => {
    const cwd = mkCwd()
    for (const bad of ['..', '../evil', 'a/b', 'has space', '.dotfile', 'x'.repeat(200)]) {
      expect(writeNotes(req(cwd, { sessionId: bad }))).toBeNull()
    }
    // nothing was written for any of them
    expect(existsSync(join(cwd, '.codex-flow', 'notes'))).toBe(false)
  })
})
