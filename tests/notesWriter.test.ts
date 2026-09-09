import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
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

  // POSIX permissions don't exist on Windows: statSync().mode reports 0o666 regardless.
  test.skipIf(process.platform === 'win32')('creates the file with mode 0o600 (transcript may hold secrets)', () => {
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

  test('refuses to write through a symlinked leaf notes file and leaves the target untouched', () => {
    const cwd = mkCwd()
    const outside = mkCwd()
    const targetFile = join(outside, 'victim.md')
    writeFileSync(targetFile, 'precious content')
    mkdirSync(join(cwd, '.codex-flow', 'notes'), { recursive: true })
    symlinkSync(targetFile, join(cwd, '.codex-flow', 'notes', 'abc-123.md'))

    expect(() => writeNotes(req(cwd))).toThrow(/symlink/i)
    expect(readFileSync(targetFile, 'utf8')).toBe('precious content')
  })

  test('refuses to append through a symlinked leaf notes file on mode=continue', () => {
    const cwd = mkCwd()
    const outside = mkCwd()
    const targetFile = join(outside, 'victim.md')
    writeFileSync(targetFile, 'precious content')
    mkdirSync(join(cwd, '.codex-flow', 'notes'), { recursive: true })
    symlinkSync(targetFile, join(cwd, '.codex-flow', 'notes', 'abc-123.md'))

    expect(() => writeNotes(req(cwd, { mode: 'continue' }))).toThrow(/symlink/i)
    expect(readFileSync(targetFile, 'utf8')).toBe('precious content')
  })

  test('leaves no temp files behind after a successful write', () => {
    const cwd = mkCwd()
    writeNotes(req(cwd))
    writeNotes(req(cwd, { mode: 'continue' }))

    expect(readdirSync(join(cwd, '.codex-flow', 'notes'))).toEqual(['abc-123.md'])
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

describe('notes redaction (R5.2, C4)', () => {
  test('redacts a credential carried in a command string', () => {
    // Arrange
    const cwd = mkCwd()
    const leaky =
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk" https://api.example.com'

    // Act
    const path = writeNotes(
      req(cwd, { parsed: { ...okParsed(), commands: [{ command: leaky, exitCode: 0 }] } }),
    )

    // Assert
    const content = readFileSync(path!, 'utf8')
    expect(content).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(content).toContain('[REDACTED:jwt]')
  })
})

describe('continue-mode append refuses a symlink at open time (TOCTOU)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  // O_NOFOLLOW is a POSIX flag; Windows keeps only the (racy) lstat pre-check.
  test.skipIf(process.platform === 'win32')(
    'refuses the append even when the lstat pre-check is defeated',
    async () => {
      // Arrange — a symlinked leaf that lstat reports as a plain regular file, i.e. exactly the
      // state an attacker creates by swapping the path after the check and before the write.
      const cwd = mkCwd()
      const outside = mkCwd()
      const targetFile = join(outside, 'victim.md')
      writeFileSync(targetFile, 'precious content')
      const notesDir = join(cwd, '.codex-flow', 'notes')
      mkdirSync(notesDir, { recursive: true })
      const leaf = join(notesDir, 'abc-123.md')
      symlinkSync(targetFile, leaf)

      vi.resetModules()
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        return {
          ...actual,
          default: actual,
          lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) =>
            String(path) === leaf
              ? ({ isSymbolicLink: () => false } as ReturnType<typeof actual.lstatSync>)
              : (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest),
        }
      })
      const { writeNotes: writeNotesMocked } = await import('../src/notesWriter.js')

      // Act + Assert
      expect(() => writeNotesMocked(req(cwd, { mode: 'continue' }))).toThrow(/symlink/i)
      expect(readFileSync(targetFile, 'utf8')).toBe('precious content')
    },
  )
})

describe('continue-mode append fails closed without O_NOFOLLOW (IMP-52)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  /** Mock node:fs with O_NOFOLLOW absent, plus an optional lstat override for the given leaf. */
  const importWithoutNoFollow = async (
    defeatedLeaf?: string,
  ): Promise<typeof import('../src/notesWriter.js')> => {
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      const constants = { ...actual.constants, O_NOFOLLOW: undefined }
      const lstatSync = (path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) =>
        defeatedLeaf !== undefined && String(path) === defeatedLeaf
          ? ({
              isSymbolicLink: () => false,
              isFile: () => true,
              dev: 1,
              ino: 999_999,
            } as unknown as ReturnType<typeof actual.lstatSync>)
          : (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest)
      return { ...actual, default: actual, constants, lstatSync }
    })
    return import('../src/notesWriter.js')
  }

  test('refuses the append when the pre-open identity does not match the opened fd', async () => {
    // Arrange — the flag cannot be requested, and the lstat pre-check is defeated exactly as an
    // attacker would defeat it, so only the fstat dev/ino comparison can stop the write.
    const cwd = mkCwd()
    const outside = mkCwd()
    const targetFile = join(outside, 'victim.md')
    writeFileSync(targetFile, 'precious content')
    const notesDir = join(cwd, '.codex-flow', 'notes')
    mkdirSync(notesDir, { recursive: true })
    const leaf = join(notesDir, 'abc-123.md')
    symlinkSync(targetFile, leaf)
    const { writeNotes: writeNotesMocked } = await importWithoutNoFollow(leaf)

    // Act + Assert
    // "swapped" can only come from the fstat identity check, so the assertion cannot pass via
    // the real O_NOFOLLOW path if the constants mock ever stops taking effect.
    expect(() => writeNotesMocked(req(cwd, { mode: 'continue' }))).toThrow(/swapped/i)
    expect(readFileSync(targetFile, 'utf8')).toBe('precious content')
  })

  test('still appends normally to a real regular file', async () => {
    // Arrange
    const cwd = mkCwd()
    const { writeNotes: writeNotesMocked } = await importWithoutNoFollow()
    writeNotesMocked(req(cwd))

    // Act
    const path = writeNotesMocked(req(cwd, { mode: 'continue', prompt: 'second turn' }))!

    // Assert
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('# Session abc-123')
    expect(content).toContain('second turn')
  })
})
