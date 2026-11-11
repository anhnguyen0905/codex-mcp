import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
// @ts-expect-error — plain .mjs script
import { setupWorktreeControlFiles } from '../scripts/worktree-setup.mjs'

const run = promisify(execFile)
const files = ['PLAN.md', 'TASKS.md', 'CONTEXT-T3.md']

const runExpectingFailure = async (
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stderr: string }> => {
  try {
    await run(process.execPath, args, options)
    throw new Error('expected the CLI to fail')
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'expected the CLI to fail') throw error
    if (
      typeof error === 'object' && error !== null &&
      'code' in error && typeof error.code === 'number' &&
      'stderr' in error && typeof error.stderr === 'string'
    ) {
      return { code: error.code, stderr: error.stderr }
    }
    throw error
  }
}

async function fixture(withSkills = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-setup-'))
  const source = path.join(root, 'source')
  const worktree = path.join(root, 'worktree')
  await mkdir(source)
  await mkdir(worktree)
  await run('git', ['init', '-q', worktree])
  for (const file of files) await writeFile(path.join(source, file), file)
  if (withSkills) await writeFile(path.join(source, 'SKILLS-T3.md'), 'skills')
  return { root, source, worktree }
}

describe('worktree setup', () => {
  test('accepts a symlink to a worktree and writes to its real directory', async () => {
    const item = await fixture(false)
    const link = path.join(item.root, 'worktree-link')
    try {
      await symlink(item.worktree, link, process.platform === 'win32' ? 'junction' : undefined)
      await setupWorktreeControlFiles({ worktree: link, task: 'T3', sourceDir: item.source })
      await expect(readFile(path.join(item.worktree, '.codex-flow', 'PLAN.md'), 'utf8')).resolves.toBe('PLAN.md')
      await expect(realpath(path.join(link, '.codex-flow'))).resolves.toBe(
        await realpath(path.join(item.worktree, '.codex-flow')),
      )
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('accepts a worktree addressed through a symlinked parent', async () => {
    const item = await fixture(false)
    const parentLink = path.join(item.root, 'parent-link')
    try {
      await symlink(item.root, parentLink, process.platform === 'win32' ? 'junction' : undefined)
      await setupWorktreeControlFiles({
        worktree: path.join(parentLink, 'worktree'), task: 'T3', sourceDir: item.source,
      })
      await expect(readFile(path.join(item.worktree, '.codex-flow', 'PLAN.md'), 'utf8')).resolves.toBe('PLAN.md')
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('rejects a plain non-git directory without creating files', async () => {
    const item = await fixture(false)
    const plain = path.join(item.root, 'plain')
    await mkdir(plain)
    try {
      await expect(
        setupWorktreeControlFiles({ worktree: plain, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(plain)
      await expect(lstat(path.join(plain, '.codex-flow'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('ignores inherited Git environment for API and CLI checks', async () => {
    const item = await fixture(false)
    const plain = path.join(item.root, 'plain')
    await mkdir(plain)
    const originalGitDir = process.env.GIT_DIR
    const originalGitWorkTree = process.env.GIT_WORK_TREE
    try {
      process.env.GIT_DIR = path.join(item.worktree, '.git')
      process.env.GIT_WORK_TREE = item.worktree
      await expect(
        setupWorktreeControlFiles({ worktree: plain, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(plain)
      await expect(lstat(path.join(plain, '.codex-flow'))).rejects.toMatchObject({ code: 'ENOENT' })

      const script = path.resolve('scripts/worktree-setup.mjs')
      const failure = await runExpectingFailure(
        [script, '--worktree', plain, '--task', 'T3', '--source', item.source],
        { env: { ...process.env, GIT_DIR: path.join(item.worktree, '.git') } },
      )
      expect(failure.code).toBeGreaterThan(0)
      expect(failure.stderr).toContain(plain)
      await expect(lstat(path.join(plain, '.codex-flow'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = originalGitDir
      if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = originalGitWorkTree
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('rejects a subdirectory of a worktree', async () => {
    const item = await fixture(false)
    const subdirectory = path.join(item.worktree, 'subdirectory')
    await mkdir(subdirectory)
    try {
      await expect(
        setupWorktreeControlFiles({ worktree: subdirectory, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(subdirectory)
      await expect(lstat(path.join(subdirectory, '.codex-flow'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('rejects a missing worktree path without creating files', async () => {
    const item = await fixture(false)
    const missing = path.join(item.root, 'missing')
    try {
      await expect(
        setupWorktreeControlFiles({ worktree: missing, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(missing)
      await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('injected git failure rejects before copying', async () => {
    const item = await fixture(false)
    try {
      await expect(setupWorktreeControlFiles({
        worktree: item.worktree, task: 'T3', sourceDir: item.source, git: async () => { throw new Error('git failed') },
      })).rejects.toThrow(item.worktree)
      await expect(lstat(path.join(item.worktree, '.codex-flow'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test.each([true, false])('copies required files and optional skills: %s', async (withSkills) => {
    const item = await fixture(withSkills)
    try {
      const result = await setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source })
      expect(result.copied).toEqual(withSkills ? [...files, 'SKILLS-T3.md'] : files)
      for (const file of result.copied) {
        const content = await readFile(path.join(item.worktree, '.codex-flow', file), 'utf8')
        expect(content).toBe(file === 'SKILLS-T3.md' ? 'skills' : file)
      }
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test.each(files)('missing required source %s rejects', async (missing) => {
    const item = await fixture()
    try {
      await rm(path.join(item.source, missing))
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(missing)
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('injected mkdir and copy failures reject', async () => {
    const item = await fixture()
    try {
      const failingMkdir = { lstat, realpath, mkdir: async () => { throw new Error('mkdir failed') } }
      const failingCopy = {
        mkdir, lstat: async () => ({
          isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true,
        }), realpath, unlink,
        copyFile: async () => { throw new Error('copy failed') }, readFile,
      }
      await expect(
        setupWorktreeControlFiles({
          worktree: item.worktree, task: 'T3', sourceDir: item.source, fsImpl: failingMkdir,
        }),
      ).rejects.toThrow('mkdir failed')
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source, fsImpl: failingCopy }),
      ).rejects.toThrow('copy failed')
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('removes files copied before a later copy failure', async () => {
    const item = await fixture(false)
    try {
      const injected = {
        ...await import('node:fs/promises'),
        copyFile: async (sourcePath: string, destinationPath: string, mode: number) => {
          if (sourcePath.endsWith('TASKS.md')) throw new Error('second copy failed')
          return (await import('node:fs/promises')).copyFile(sourcePath, destinationPath, mode)
        },
      }
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source, fsImpl: injected }),
      ).rejects.toThrow('second copy failed')
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'TASKS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('invalid optional source is rejected before required files are copied', async () => {
    const item = await fixture()
    try {
      await rm(path.join(item.source, 'SKILLS-T3.md'))
      await mkdir(path.join(item.source, 'SKILLS-T3.md'))
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(path.join(item.source, 'SKILLS-T3.md'))
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('verification mismatch rejects', async () => {
    const item = await fixture()
    try {
      const injected = {
        ...await import('node:fs/promises'),
        readFile: async (file: string) => file.endsWith('PLAN.md') && file.includes('.codex-flow')
          ? Buffer.from('bad') : readFile(file),
      }
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source, fsImpl: injected }),
      ).rejects.toThrow('verification mismatch')
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test.each([
    ['required symlink', 'PLAN.md', 'symlink'],
    ['required directory', 'PLAN.md', 'directory'],
    ['optional symlink', 'SKILLS-T3.md', 'symlink'],
    ['optional directory', 'SKILLS-T3.md', 'directory'],
  ])('%s source rejects', async (_label, fileName, kind) => {
    const item = await fixture()
    try {
      await rm(path.join(item.source, fileName))
      if (kind === 'symlink') await symlink(files[0], path.join(item.source, fileName))
      else await mkdir(path.join(item.source, fileName))
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow(path.join(item.source, fileName))
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('stale destination is replaced and verified', async () => {
    const item = await fixture(false)
    try {
      const destination = path.join(item.worktree, '.codex-flow')
      await mkdir(destination)
      await writeFile(path.join(destination, 'PLAN.md'), 'stale')
      await setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source })
      expect(await readFile(path.join(destination, 'PLAN.md'), 'utf8')).toBe('PLAN.md')
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('copy EEXIST rejects', async () => {
    const item = await fixture(false)
    try {
      const injected = {
        ...await import('node:fs/promises'),
        copyFile: async () => {
          const error = new Error('exists') as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        },
      }
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source, fsImpl: injected }),
      ).rejects.toThrow('exists')
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test.each(['T', 't1', 'T1/../x', ''])('invalid task %s rejects with TypeError', async (task) => {
    await expect(setupWorktreeControlFiles({ worktree: 'worktree', task })).rejects.toBeInstanceOf(TypeError)
  })

  test('destination control directory symlink rejects', async () => {
    const item = await fixture()
    try {
      const target = path.join(item.root, 'target')
      await mkdir(target)
      await symlink(target, path.join(item.worktree, '.codex-flow'))
      await expect(
        setupWorktreeControlFiles({ worktree: item.worktree, task: 'T3', sourceDir: item.source }),
      ).rejects.toThrow('symlink')
      await expect(lstat(path.join(target, 'PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(path.join(target, 'TASKS.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI happy path copies the control files into the worktree', async () => {
    const item = await fixture(false)
    try {
      const script = path.resolve('scripts/worktree-setup.mjs')
      const success = await run(process.execPath, [
        script, '--worktree', item.worktree, '--task', 'T3', '--source', item.source,
      ])
      expect(success.stdout).toContain('PLAN.md, TASKS.md, CONTEXT-T3.md')
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'PLAN.md'))).resolves.toBeDefined()
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'TASKS.md'))).resolves.toBeDefined()
      await expect(lstat(path.join(item.worktree, '.codex-flow', 'CONTEXT-T3.md'))).resolves.toBeDefined()
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI reports a missing required source file', async () => {
    const item = await fixture(false)
    const missingPath = path.join(item.source, 'TASKS.md')
    try {
      const script = path.resolve('scripts/worktree-setup.mjs')
      await rm(missingPath)
      const missing = await runExpectingFailure([
        script, '--worktree', item.worktree, '--task', 'T3', '--source', item.source,
      ])
      expect(missing.code).toBeGreaterThan(0)
      expect(missing.stderr.trim().split('\n')).toHaveLength(1)
      expect(missing.stderr.trim()).toMatch(/^worktree-setup: /)
      expect(missing.stderr).toMatch(/^worktree-setup: .+TASKS\.md/)
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI rejects an invalid task id with one-line stderr', async () => {
    const item = await fixture(false)
    try {
      const script = path.resolve('scripts/worktree-setup.mjs')
      const failure = await runExpectingFailure([
        script, '--worktree', item.worktree, '--task', 'T', '--source', item.source,
      ])
      expect(failure.code).toBeGreaterThan(0)
      expect(failure.stderr.trim().split('\n')).toHaveLength(1)
      expect(failure.stderr.trim()).toMatch(/^worktree-setup: /)
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI reports a destination filesystem error', async () => {
    const item = await fixture(false)
    const destinationPath = path.join(item.worktree, '.codex-flow')
    try {
      const script = path.resolve('scripts/worktree-setup.mjs')
      await writeFile(destinationPath, 'not a directory')
      const failure = await runExpectingFailure([
        script, '--worktree', item.worktree, '--task', 'T3', '--source', item.source,
      ])
      expect(failure.code).toBeGreaterThan(0)
      expect(failure.stderr.trim().split('\n')).toHaveLength(1)
      expect(failure.stderr.trim()).toMatch(/^worktree-setup: /)
      expect(failure.stderr).toContain(destinationPath)
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI reports usage when required arguments are missing', async () => {
    const script = path.resolve('scripts/worktree-setup.mjs')
    const failure = await runExpectingFailure([script])
    expect(failure.code).toBeGreaterThan(0)
    expect(failure.stderr.trim().split('\n')).toHaveLength(1)
    expect(failure.stderr.trim()).toMatch(/^worktree-setup: /)
    expect(failure.stderr).toContain('usage: node scripts/worktree-setup.mjs')
  })

  test('package files lists the helper', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[] }
    expect(packageJson.files).toContain('scripts/worktree-setup.mjs')
  })
})
