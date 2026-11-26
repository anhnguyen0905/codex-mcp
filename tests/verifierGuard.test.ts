import { mkdtempSync, readFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain .mjs script
import { arm, assertionCount, check, digestFlowDir, testPathsFromVerify } from '../scripts/verifier-guard.mjs'

const roots: string[] = []
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-guard-'))
  roots.push(root)
  return realpathSync(root)
}
const writeFixture = (root: string, relativePath: string, text: string) => {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, text)
}
const runCli = (root: string, ...args: string[]) => spawnSync(process.execPath, ['scripts/verifier-guard.mjs', ...args, '--root', root], { encoding: 'utf8' })

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('verifier guard', () => {
  it('counts supported assertion forms', () => {
    // Arrange
    const text = 'expect(true) assert(value) assert.equal(value, value) value.should.be.true'
    // Act
    const count = assertionCount(text)
    // Assert
    expect(count).toBe(4)
  })

  it('arms a clean baseline and ignores notes changes', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'invented plan')
    writeFixture(root, 'tests/sample.test.ts', 'expect(true)')
    arm({ task: 'T2', root, tests: ['tests/sample.test.ts'] })
    // Act
    writeFixture(root, '.codex-flow/notes/log.txt', 'ignored note')
    const result = check({ task: 'T2', root })
    // Assert
    expect(result).toEqual({ flowChanges: [], testChanges: [] })
    expect(digestFlowDir(root)).toHaveProperty('.codex-flow/PLAN.md')
  })

  it('reports added, modified, and deleted flow files', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/a.md', 'a')
    writeFixture(root, '.codex-flow/b.md', 'b')
    arm({ task: 'T2', root })
    // Act
    writeFixture(root, '.codex-flow/a.md', 'changed')
    rmSync(join(root, '.codex-flow/b.md'))
    writeFixture(root, '.codex-flow/c.md', 'c')
    const result = check({ task: 'T2', root })
    // Assert
    expect(result.flowChanges).toEqual([{ path: '.codex-flow/a.md', change: 'modified' }, { path: '.codex-flow/b.md', change: 'deleted' }, { path: '.codex-flow/c.md', change: 'added' }])
  })

  it('reports assertion drops and deleted tests', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    writeFixture(root, 'tests/x.ts', 'expect(true)\nexpect(true)')
    arm({ task: 'T2', root, tests: ['tests/x.ts'] })
    // Act
    writeFixture(root, 'tests/x.ts', 'expect(true)')
    const changed = check({ task: 'T2', root })
    rmSync(join(root, 'tests/x.ts'))
    const deleted = check({ task: 'T2', root })
    // Assert
    expect(changed.testChanges[0]).toMatchObject({ before: 2, after: 1, dropped: true })
    expect(deleted.testChanges[0]).toMatchObject({ deleted: true })
  })

  it('does not mark an unchanged assertion count as dropped', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    writeFixture(root, 'tests/x.ts', 'expect(true)')
    arm({ task: 'T2', root, tests: ['tests/x.ts'] })
    // Act
    writeFixture(root, 'tests/x.ts', 'expect(false)')
    const result = check({ task: 'T2', root })
    // Assert
    expect(result.testChanges[0]).toMatchObject({ before: 1, after: 1, dropped: false })
  })

  it('captures no test baseline when any requested path is missing', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    writeFixture(root, 'tests/existing.ts', 'expect(true)')
    // Act
    arm({ task: 'T2', root, tests: ['tests/existing.ts', 'tests/missing.ts'] })
    const firstState = JSON.parse(readFileSync(join(root, '.codex-flow/notes/verifier-guard-T2.json'), 'utf8'))
    writeFixture(root, 'tests/missing.ts', 'expect(false)')
    arm({ task: 'T2', root, tests: ['tests/existing.ts', 'tests/missing.ts'] })
    const secondState = JSON.parse(readFileSync(join(root, '.codex-flow/notes/verifier-guard-T2.json'), 'utf8'))
    // Assert
    expect(firstState.tests).toBeNull()
    expect(Object.keys(secondState.tests)).toEqual(['tests/existing.ts', 'tests/missing.ts'])
  })

  it('derives existing paths from a verify command', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, 'tests/a.test.ts', 'expect(true)')
    // Act
    const paths = testPathsFromVerify('npx vitest run tests/a.test.ts missing.ts', root)
    // Assert
    expect(paths).toEqual(['tests/a.test.ts'])
  })

  it('keeps an unquoted backslash in a verify path', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, 'tests\\a.test.ts', 'expect(true)')
    // Act
    const paths = testPathsFromVerify('npx vitest run tests\\a.test.ts', root)
    // Assert
    expect(paths).toEqual(process.platform === 'win32' ? ['tests/a.test.ts'] : ['tests\\a.test.ts'])
  })

  it('derives a single-quoted path containing spaces', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, 'tests/my file.test.ts', 'expect(true)')
    // Act
    const paths = testPathsFromVerify("npx vitest run 'tests/my file.test.ts'", root)
    // Assert
    expect(paths).toEqual(['tests/my file.test.ts'])
  })

  it('derives a path with a backslash-escaped space', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, 'tests/my file.test.ts', 'expect(true)')
    // Act
    const paths = testPathsFromVerify('npx vitest run tests/my\\ file.test.ts', root)
    // Assert
    expect(paths).toEqual(['tests/my file.test.ts'])
  })

  it('derives a quoted path containing spaces from a verify command', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, 'tests/my file.test.ts', 'expect(true)')
    // Act
    const paths = testPathsFromVerify('npx vitest run "tests/my file.test.ts"', root)
    // Assert
    expect(paths).toEqual(['tests/my file.test.ts'])
  })

  it('rejects an unterminated quote in a verify command', () => {
    // Arrange
    const root = makeRoot()
    // Act
    const action = () => testPathsFromVerify('npx vitest run "tests/my file.test.ts', root)
    // Assert
    expect(action).toThrow('unterminated quote')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked notes directory without touching its target', () => {
    // Arrange
    const root = makeRoot()
    const target = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    mkdirSync(join(target, '.codex-flow', 'notes'), { recursive: true })
    writeFixture(target, '.codex-flow/notes/marker.txt', 'untouched')
    rmSync(join(root, '.codex-flow', 'notes'), { recursive: true, force: true })
    symlinkSync(join(target, '.codex-flow', 'notes'), join(root, '.codex-flow', 'notes'))
    // Act
    const result = runCli(root, 'arm', '--task', 'T2')
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(target, '.codex-flow', 'notes', 'marker.txt'), 'utf8')).toBe('untouched')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked state file without touching its target', () => {
    // Arrange
    const root = makeRoot()
    const target = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    writeFixture(target, 'state.json', 'untouched')
    writeFixture(root, '.codex-flow/notes/.keep', '')
    symlinkSync(join(target, 'state.json'), join(root, '.codex-flow/notes/verifier-guard-T2.json'))
    // Act
    const result = runCli(root, 'arm', '--task', 'T2')
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(target, 'state.json'), 'utf8')).toBe('untouched')
  })

  it.skipIf(process.platform === 'win32')('refuses a dangling symlinked state file', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/PLAN.md', 'plan')
    writeFixture(root, '.codex-flow/notes/.keep', '')
    symlinkSync(join(root, 'missing-state.json'), join(root, '.codex-flow/notes/verifier-guard-T2.json'))
    // Act
    const result = runCli(root, 'arm', '--task', 'T2')
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })

  it('returns exit 2 when checking before arm', () => {
    // Arrange
    const root = makeRoot()
    // Act
    const result = runCli(root, 'check', '--task', 'T2')
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })

  it('arms from verify and reports a clean CLI check', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/a.md', 'a')
    writeFixture(root, 'tests/a.test.ts', 'expect(true)\nexpect(false)')
    // Act
    const armed = runCli(root, 'arm', '--task', 'T2', '--verify', 'npx vitest run tests/a.test.ts')
    const checked = runCli(root, 'check', '--task', 'T2')
    // Assert
    expect(armed.status).toBe(0)
    expect(checked.status).toBe(0)
    expect(checked.stdout.trim()).toBe('verifier-guard: clean')
  })

  it('reports all CLI flow and test changes with assertion drops', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/a', 'a')
    writeFixture(root, '.codex-flow/b', 'b')
    writeFixture(root, 'tests/a.test.ts', 'expect(true)\nexpect(false)')
    runCli(root, 'arm', '--task', 'T2', '--verify', 'npx vitest run tests/a.test.ts')
    // Act
    writeFixture(root, '.codex-flow/a', 'changed')
    writeFixture(root, '.codex-flow/c', 'c')
    rmSync(join(root, '.codex-flow/b'))
    writeFixture(root, 'tests/a.test.ts', 'expect(true)')
    const result = runCli(root, 'check', '--task', 'T2')
    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('flow-changed: .codex-flow/a (modified)')
    expect(result.stdout).toContain('flow-changed: .codex-flow/c (added)')
    expect(result.stdout).toContain('flow-changed: .codex-flow/b (deleted)')
    expect(result.stdout).toContain('test-changed: tests/a.test.ts assertions 2 -> 1 assertions-dropped')
  })

  it('reports a deleted test through the CLI', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/a', 'a')
    writeFixture(root, 'tests/a.test.ts', 'expect(true)')
    runCli(root, 'arm', '--task', 'T2', '--verify', 'npx vitest run tests/a.test.ts')
    rmSync(join(root, 'tests/a.test.ts'))
    // Act
    const result = runCli(root, 'check', '--task', 'T2')
    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('test-deleted: tests/a.test.ts')
  })

  it('reports a same-count test change without assertions-dropped', () => {
    // Arrange
    const root = makeRoot()
    writeFixture(root, '.codex-flow/a', 'a')
    writeFixture(root, 'tests/a.test.ts', 'expect(true)')
    runCli(root, 'arm', '--task', 'T2', '--verify', 'npx vitest run tests/a.test.ts')
    writeFixture(root, 'tests/a.test.ts', 'expect(false)')
    // Act
    const result = runCli(root, 'check', '--task', 'T2')
    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('test-changed: tests/a.test.ts assertions 1 -> 1')
    expect(result.stdout).not.toContain('assertions-dropped')
  })

  it('returns exit 2 for malformed CLI arguments', () => {
    // Arrange
    const root = makeRoot()
    // Act
    const unknownFlag = runCli(root, 'check', '--task', 'T2', '--unknown')
    const missingTask = runCli(root, 'check', '--task')
    // Assert
    expect(unknownFlag.status).toBe(2)
    expect(unknownFlag.stderr.trim().split('\n')).toHaveLength(1)
    expect(missingTask.status).toBe(2)
    expect(missingTask.stderr.trim().split('\n')).toHaveLength(1)
  })
})
