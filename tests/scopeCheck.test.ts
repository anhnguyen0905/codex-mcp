import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  DEFAULT_TASKS_PATH,
  ScopeDeclarationError,
  canonicalPath,
  collectChangedPaths,
  isExcludedPath,
  main,
  parseCliArgs,
  parseTaskFilesField,
  scopeCheck,
} from '../scripts/scope-check.mjs'

const TASKS = `# Backlog

## T1: Add the trip-wire
- Depends on: —
- Files: scripts/scope-check.mjs, tests/scopeCheck.test.ts
- Acceptance: vitest
- Status: pending

## T2: Placeholder task
- Files: <files to create>
- Status: pending

## T3: Empty task
- Files:
- Status: pending

## Notes
- Files: docs/should-not-leak.md
`

const tempDirectories: string[] = []

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A repo whose base commit contains the declared files plus a TASKS.md. */
function makeRepo(tasksText = TASKS): { directory: string; base: string } {
  const directory = makeTempDirectory('scope-check-')
  git(directory, 'init', '-q')
  git(directory, 'config', 'user.email', 'test@example.com')
  git(directory, 'config', 'user.name', 'test')
  mkdirSync(join(directory, 'scripts'))
  mkdirSync(join(directory, 'tests'))
  mkdirSync(join(directory, '.codex-flow'))
  writeFileSync(join(directory, 'scripts', 'scope-check.mjs'), '// base\n')
  writeFileSync(join(directory, 'tests', 'scopeCheck.test.ts'), '// base\n')
  writeFileSync(join(directory, 'src.ts'), '// base\n')
  writeFileSync(join(directory, '.codex-flow', 'TASKS.md'), tasksText)
  git(directory, 'add', '.')
  git(directory, 'commit', '-q', '-m', 'base')
  return { directory, base: git(directory, 'rev-parse', 'HEAD').trim() }
}

function captureConsole(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    out.push(String(line))
  })
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    err.push(String(line))
  })
  return { out, err }
}

describe('canonicalPath', () => {
  test('treats equivalent spellings of one path as equal', () => {
    // Arrange
    const spellings = ['src/a.ts', './src/a.ts', 'src//a.ts', 'src/./a.ts']

    // Act
    const canonicalized = spellings.map((spelling) => canonicalPath(spelling, 'linux'))

    // Assert
    expect(new Set(canonicalized)).toEqual(new Set(['src/a.ts']))
  })

  test('keeps a POSIX backslash filename distinct from the slash path', () => {
    // Arrange & Act
    const onLinux = canonicalPath('src\\secret.ts', 'linux')
    const onDarwin = canonicalPath('src\\secret.ts', 'darwin')

    // Assert — `\` is a legal POSIX filename character, not a separator.
    expect(onLinux).toBe('src\\secret.ts')
    expect(onDarwin).toBe('src\\secret.ts')
  })

  test('keeps surrounding whitespace, which is a legal filename character', () => {
    expect(canonicalPath(' secret.ts', 'linux')).toBe(' secret.ts')
    expect(canonicalPath('src/a.ts ', 'linux')).toBe('src/a.ts ')
  })

  test('treats a backslash as a separator on win32', () => {
    expect(canonicalPath('src\\secret.ts', 'win32')).toBe('src/secret.ts')
  })

  test('folds case only on case-insensitive platforms', () => {
    // Arrange & Act
    const onDarwin = canonicalPath('Src/A.ts', 'darwin')
    const onWindows = canonicalPath('Src\\A.ts', 'win32')
    const onLinux = canonicalPath('Src/A.ts', 'linux')

    // Assert
    expect(onDarwin).toBe('src/a.ts')
    expect(onWindows).toBe('src/a.ts')
    expect(onLinux).toBe('Src/A.ts')
  })

  test('rejects a non-string path', () => {
    expect(() => canonicalPath(undefined)).toThrow('filePath must be a string')
  })

  test.each(['linux', 'darwin', 'win32'])(
    'keeps the leading separator of an absolute path on %s',
    (platform) => {
      // Act
      const absolute = canonicalPath('/src/a.ts', platform)
      const relative = canonicalPath('src/a.ts', platform)

      // Assert — dropping the root would fold `/src/a.ts` onto a declared `src/a.ts`.
      expect(absolute).toBe('/src/a.ts')
      expect(absolute).not.toBe(relative)
    },
  )

  test.each(['linux', 'darwin', 'win32'])(
    'keeps a `..` component distinct instead of resolving it on %s',
    (platform) => {
      // Act
      const traversal = canonicalPath('src/../secret.ts', platform)

      // Assert — resolving would need the real tree; staying distinct fails closed.
      expect(traversal).toBe('src/../secret.ts')
      expect(traversal).not.toBe(canonicalPath('secret.ts', platform))
    },
  )
})

describe('isExcludedPath', () => {
  test('excludes the four generated lockfiles and every .codex-flow path', () => {
    const excluded = [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      '.codex-flow',
      '.codex-flow/TASKS.md',
      '.codex-flow/live/T1.log',
    ]

    expect(excluded.map((entry) => isExcludedPath(entry))).toEqual(excluded.map(() => true))
  })

  test('excludes a node_modules entry at any depth', () => {
    // Arrange — the bare symlink a parallel worktree carries, plus nested trees.
    const excluded = ['node_modules', 'packages/app/node_modules', 'a/b/c/node_modules']

    expect(excluded.map((entry) => isExcludedPath(entry))).toEqual(excluded.map(() => true))
  })

  test('does not exclude ordinary sources or lookalike names', () => {
    const included = [
      'src/a.ts',
      'codex-flow/TASKS.md',
      'docs/package-lock.json.md',
      'docs/node_modules.md',
      'src/node_modules_shim.ts',
      '',
    ]

    expect(included.map((entry) => isExcludedPath(entry))).toEqual(included.map(() => false))
  })
})

describe('parseTaskFilesField', () => {
  test('reads the declaration of the requested task only', () => {
    // Act
    const task = parseTaskFilesField(TASKS, 'T1')

    // Assert
    expect(task).toEqual({
      id: 'T1',
      title: 'Add the trip-wire',
      declaration: 'scripts/scope-check.mjs, tests/scopeCheck.test.ts',
    })
  })

  test('does not leak a Files bullet from a following documentation section', () => {
    // Act
    const task = parseTaskFilesField(TASKS, 'T3')

    // Assert
    expect(task).toEqual({ id: 'T3', title: 'Empty task', declaration: '' })
  })

  test('parses a CRLF tasks file identically', () => {
    // Arrange
    const crlf = TASKS.replaceAll('\n', '\r\n')

    // Act & Assert
    expect(parseTaskFilesField(crlf, 't1')).toEqual(parseTaskFilesField(TASKS, 'T1'))
  })

  test('returns null for an absent task and rejects a malformed id', () => {
    expect(parseTaskFilesField(TASKS, 'T99')).toBeNull()
    expect(() => parseTaskFilesField(TASKS, 'nope')).toThrow('taskId must look like T<n>')
  })
})

describe('scopeCheck', () => {
  const base = 'abc1234'

  test('reports every path outside the declared Files set', () => {
    // Arrange
    const changed = ['scripts/scope-check.mjs', 'src/server.ts', 'docs/notes.md']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'linux')

    // Assert
    expect(result.extras).toEqual(['docs/notes.md', 'src/server.ts'])
    expect(result.allowed).toEqual(['scripts/scope-check.mjs', 'tests/scopeCheck.test.ts'])
    expect(result.changed).toEqual(['docs/notes.md', 'scripts/scope-check.mjs', 'src/server.ts'])
  })

  test('accepts declared paths spelled differently and the allowed exclusions', () => {
    // Arrange
    const changed = [
      './scripts/scope-check.mjs',
      'tests//scopeCheck.test.ts',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      '.codex-flow/TASKS.md',
      '',
    ]

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'linux')

    // Assert
    expect(result.extras).toEqual([])
  })

  test.each(['linux', 'darwin'])(
    'reports a POSIX backslash filename as an extra on %s',
    (platform) => {
      // Arrange — a real file literally named `src\secret.ts`, not `src/secret.ts`.
      const changed = ['scripts\\scope-check.mjs']

      // Act
      const result = scopeCheck('T1', base, TASKS, changed, platform)

      // Assert
      expect(result.extras).toEqual(['scripts\\scope-check.mjs'])
    },
  )

  test('prints a darwin extra in its original spelling, not the folded one', () => {
    // Arrange — darwin folds case for the comparison; the report must not.
    const changed = ['Docs/Notes.MD']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'darwin')

    // Assert
    expect(result.extras).toEqual(['Docs/Notes.MD'])
    expect(result.changed).toEqual(['docs/notes.md'])
  })

  test('matches a declared path spelled with different case on darwin', () => {
    // Arrange
    const changed = ['Scripts/Scope-Check.mjs']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'darwin')

    // Assert
    expect(result.extras).toEqual([])
  })

  test('reports a changed path with leading whitespace as an extra', () => {
    // Arrange
    const changed = [' scripts/scope-check.mjs']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'linux')

    // Assert
    expect(result.extras).toEqual([' scripts/scope-check.mjs'])
  })

  test('still matches the backslash spelling of a declared path on win32', () => {
    // Arrange
    const changed = ['scripts\\scope-check.mjs', 'tests\\scopeCheck.test.ts']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'win32')

    // Assert
    expect(result.extras).toEqual([])
  })

  test('prints a win32 extra in its original spelling, not the folded one', () => {
    // Arrange — win32 folds case AND rewrites `\`; the report must do neither.
    const changed = ['Docs\\Notes.MD']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'win32')

    // Assert
    expect(result.extras).toEqual(['Docs\\Notes.MD'])
    expect(result.changed).toEqual(['docs/notes.md'])
  })

  test.each(['linux', 'darwin', 'win32'])(
    'reports an absolute spelling of a declared path as an extra on %s',
    (platform) => {
      // Arrange — an absolute path is not the declared relative path.
      const changed = ['/scripts/scope-check.mjs']

      // Act
      const result = scopeCheck('T1', base, TASKS, changed, platform)

      // Assert
      expect(result.extras).toEqual(['/scripts/scope-check.mjs'])
    },
  )

  test.each(['linux', 'darwin', 'win32'])(
    'reports a `..` traversal onto a declared path as an extra on %s',
    (platform) => {
      // Arrange — `scripts/../scripts/scope-check.mjs` is not resolved, so it stays distinct.
      const changed = ['scripts/../scripts/scope-check.mjs']

      // Act
      const result = scopeCheck('T1', base, TASKS, changed, platform)

      // Assert
      expect(result.extras).toEqual(['scripts/../scripts/scope-check.mjs'])
    },
  )

  test('excludes a node_modules symlink and nested dependency directories', () => {
    // Arrange
    const changed = ['node_modules', 'packages/app/node_modules', 'scripts/scope-check.mjs']

    // Act
    const result = scopeCheck('T1', base, TASKS, changed, 'linux')

    // Assert
    expect(result.extras).toEqual([])
  })

  test('does not mutate the caller-supplied changed paths', () => {
    // Arrange
    const changed = ['src/server.ts', 'scripts/scope-check.mjs']
    const snapshot = [...changed]

    // Act
    scopeCheck('T1', base, TASKS, changed, 'linux')

    // Assert
    expect(changed).toEqual(snapshot)
  })

  test('rejects a placeholder Files field by task name', () => {
    // Act
    const check = () => scopeCheck('T2', base, TASKS, [], 'linux')

    // Assert
    expect(check).toThrow(ScopeDeclarationError)
    expect(check).toThrow('T2 has a placeholder Files: field')
    expect(check).toThrow('refusing to treat "no files" as "everything allowed"')
  })

  test('rejects an empty Files field by task name', () => {
    // Act
    const check = () => scopeCheck('T3', base, TASKS, ['src/server.ts'], 'linux')

    // Assert
    expect(check).toThrow(ScopeDeclarationError)
    expect(check).toThrow('T3 declares an empty Files: field')
  })

  test('rejects a task that is absent from the tasks file', () => {
    expect(() => scopeCheck('T42', base, TASKS, [], 'linux')).toThrow(
      'T42 not found in the tasks file',
    )
  })

  test('validates its own inputs', () => {
    expect(() => scopeCheck('nope', base, TASKS, [], 'linux')).toThrow('taskId must look like T<n>')
    expect(() => scopeCheck('T1', '  ', TASKS, [], 'linux')).toThrow(
      'base must be a non-empty string',
    )
    expect(() => scopeCheck('T1', base, TASKS, [42], 'linux')).toThrow(
      'changedPaths must be an array of strings',
    )
  })
})

describe('parseCliArgs', () => {
  test('defaults the tasks path and upper-cases the task id', () => {
    // Act
    const parsed = parseCliArgs(['--task', 't7', '--base', 'DEADBEEF'])

    // Assert
    expect(parsed).toEqual({ task: 'T7', base: 'DEADBEEF', tasks: DEFAULT_TASKS_PATH })
  })

  test('rejects missing values, unknown flags, and malformed ids', () => {
    expect(() => parseCliArgs(['--task', 'T1'])).toThrow('--base requires a git object name')
    expect(() => parseCliArgs(['--base', 'abc1234'])).toThrow('--task requires a task id like T3')
    expect(() => parseCliArgs(['--task', '--base', 'abc1234'])).toThrow('--task requires a value')
    expect(() => parseCliArgs(['--mystery', 'x'])).toThrow('unknown argument --mystery')
    expect(() => parseCliArgs(['--task', 'T1', '--base', 'not-a-sha'])).toThrow(
      '--base requires a git object name',
    )
  })

  test.each(['--task', '--base', '--tasks'])('rejects a repeated %s flag', (flag) => {
    // Arrange — last-wins would compare against an argument the operator never meant.
    const argv = ['--task', 'T1', '--base', 'abc1234', flag, 'first', flag, 'second']

    // Act & Assert
    expect(() => parseCliArgs(argv)).toThrow(`duplicate argument ${flag}`)
  })
})

describe('collectChangedPaths', () => {
  test('returns tracked changes since base plus untracked files', () => {
    // Arrange
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'scripts', 'scope-check.mjs'), '// changed\n')
    writeFileSync(join(directory, 'untracked.txt'), 'new\n')

    // Act
    const changed = collectChangedPaths(base, directory)

    // Assert
    expect(changed.sort()).toEqual(['scripts/scope-check.mjs', 'untracked.txt'])
  })

  test('rejects a base that is not a git object name', () => {
    expect(() => collectChangedPaths('HEAD~1', process.cwd())).toThrow(
      'base must be a git object name',
    )
  })
})

describe('scope-check CLI', () => {
  test('exits 0 and reports the change count when every path is declared', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'scripts', 'scope-check.mjs'), '// changed\n')
    writeFileSync(join(directory, 'package-lock.json'), '{}\n')
    writeFileSync(join(directory, '.codex-flow', 'CONTEXT-T1.md'), 'slice\n')
    const { out, err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(0)
    expect(err).toEqual([])
    expect(out[0]).toContain('scope-check: T1: 3 changed path(s), all within Files:')
  })

  test('exits 1 and prints every tracked extra path', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'src.ts'), '// touched\n')
    writeFileSync(join(directory, 'scripts', 'scope-check.mjs'), '// changed\n')
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(err[0]).toContain('scope-check: T1: 1 path(s) outside the declared Files:')
    expect(err).toContain('  extra: src.ts')
  })

  test('exits 1 for an untracked extra path', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'sneaky.md'), 'undeclared\n')
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(err).toContain('  extra: sneaky.md')
  })

  test('prints an extra path with its original case, not the canonical form', async () => {
    // Arrange — on darwin the comparison folds case; the printed line must not.
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'Sneaky.MD'), 'undeclared\n')
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(err).toContain('  extra: Sneaky.MD')
  })

  test('exits 1 naming the task when Files is a placeholder', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    writeFileSync(join(directory, 'anything.txt'), 'x\n')
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T2', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(err[0]).toContain('T2 has a placeholder Files: field')
  })

  test('exits 0 with an untracked node_modules symlink in the worktree', async () => {
    // Arrange — a parallel worktree links node_modules instead of installing it.
    const { directory, base } = makeRepo()
    const dependencies = makeTempDirectory('scope-check-deps-')
    symlinkSync(dependencies, join(directory, 'node_modules'), 'dir')
    writeFileSync(join(directory, 'scripts', 'scope-check.mjs'), '// changed\n')
    const { out, err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base], { cwd: directory })

    // Assert
    expect(exitCode).toBe(0)
    expect(err).toEqual([])
    expect(out[0]).toContain('all within Files:')
  })

  test('exits 2 on a repeated flag instead of letting the last one win', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base, '--base', 'deadbeef'], {
      cwd: directory,
    })

    // Assert
    expect(exitCode).toBe(2)
    expect(err[0]).toContain('duplicate argument --base')
    expect(err[1]).toContain('usage: node scripts/scope-check.mjs --task T<n> --base <sha>')
  })

  test('exits 2 on a usage error and prints the usage line', async () => {
    // Arrange
    const { directory } = makeRepo()
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1'], { cwd: directory })

    // Assert
    expect(exitCode).toBe(2)
    expect(err[0]).toContain('--base requires a git object name')
    expect(err[1]).toContain('usage: node scripts/scope-check.mjs --task T<n> --base <sha>')
  })

  test('exits 2 when the tasks file is missing', async () => {
    // Arrange
    const { directory, base } = makeRepo()
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', base, '--tasks', 'absent/TASKS.md'], {
      cwd: directory,
    })

    // Assert
    expect(exitCode).toBe(2)
    expect(err[0]).toContain('cannot read tasks file')
  })

  test('exits 2 when git cannot resolve the base', async () => {
    // Arrange
    const { directory } = makeRepo()
    const { err } = captureConsole()

    // Act
    const exitCode = await main(['--task', 'T1', '--base', 'deadbeef'], { cwd: directory })

    // Assert
    expect(exitCode).toBe(2)
    expect(err[0]).toContain('scope-check: git failed for base deadbeef')
  })

  test('rejects an empty cwd instead of silently using the process directory', async () => {
    await expect(main(['--task', 'T1', '--base', 'abc1234'], { cwd: '  ' })).rejects.toThrow(
      'cwd must be a non-empty string',
    )
  })
})
