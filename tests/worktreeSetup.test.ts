import { lstat, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
// @ts-expect-error — plain .mjs script
import { setupWorktreeControlFiles } from '../scripts/worktree-setup.mjs'

const run = promisify(execFile)
const files = ['PLAN.md', 'TASKS.md', 'CONTEXT-T3.md']

async function fixture(withSkills = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-setup-'))
  const source = path.join(root, 'source')
  const worktree = path.join(root, 'worktree')
  await mkdir(source)
  await mkdir(worktree)
  for (const file of files) await writeFile(path.join(source, file), file)
  if (withSkills) await writeFile(path.join(source, 'SKILLS-T3.md'), 'skills')
  return { root, source, worktree }
}

describe('worktree setup', () => {
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
      const failingMkdir = { lstat, mkdir: async () => { throw new Error('mkdir failed') } }
      const failingCopy = {
        mkdir, lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true }), unlink,
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
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('CLI succeeds and fails with one-line stderr', async () => {
    const item = await fixture(false)
    try {
      const script = path.resolve('scripts/worktree-setup.mjs')
      const success = await run(process.execPath, [
        script, '--worktree', item.worktree, '--task', 'T3', '--source', item.source,
      ])
      expect(success.stdout).toContain('PLAN.md, TASKS.md, CONTEXT-T3.md')
      const failure = await run(process.execPath, [script, '--worktree', item.worktree, '--task', 'T'])
        .catch((error: unknown) => error as { code: number; stderr: string })
      expect(failure.code).not.toBe(0)
      expect(failure.stderr.trim().split('\n')).toHaveLength(1)
      await rm(path.join(item.source, 'TASKS.md'))
      const missing = await run(process.execPath, [
        script, '--worktree', item.worktree, '--task', 'T3', '--source', item.source,
      ])
        .catch((error: unknown) => error as { code: number; stderr: string })
      expect(missing.code).not.toBe(0)
      expect(missing.stderr.trim()).toMatch(/^worktree-setup: .+TASKS\.md/)
    } finally {
      await rm(item.root, { recursive: true, force: true })
    }
  })

  test('package files lists the helper', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[] }
    expect(packageJson.files).toContain('scripts/worktree-setup.mjs')
  })
})
