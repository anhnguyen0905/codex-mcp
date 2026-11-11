import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { constants as FS_CONSTANTS } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const TASK_ID = /^T\d+$/
const REQUIRED_FILES = Object.freeze(['PLAN.md', 'TASKS.md'])
const USAGE = 'usage: node scripts/worktree-setup.mjs --worktree <path> --task T<n> [--source <dir>]'
const GIT_TIMEOUT_MS = 10_000
const runExecFile = promisify(execFile)

const errorMessage = (error) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()

async function defaultGit(args) {
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const normalizedName = process.platform === 'win32' ? name.toUpperCase() : name
      return !normalizedName.startsWith('GIT_')
    }),
  )
  const result = await runExecFile('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...gitEnvironment, LC_ALL: 'C' },
  })
  return result.stdout
}

/** Parse and validate the worktree setup CLI arguments. */
export function parseCliArgs(args) {
  const values = {}
  const flags = new Map([['--worktree', 'worktree'], ['--task', 'task'], ['--source', 'source']])
  for (let index = 0; index < args.length; index += 1) {
    const key = flags.get(args[index])
    if (!key || values[key] !== undefined) {
      throw new Error(`invalid or repeated flag: ${args[index] ?? ''}`)
    }
    const value = args[index + 1]
    if (typeof value !== 'string' || value.startsWith('--') || value === '') {
      throw new Error(`missing value for ${args[index]}`)
    }
    values[key] = value
    index += 1
  }
  if (typeof values.worktree !== 'string' || typeof values.task !== 'string') throw new Error(USAGE)
  if (!TASK_ID.test(values.task)) throw new TypeError('task must match ^T\\d+$')
  return { worktree: values.worktree, task: values.task, sourceDir: values.source ?? '.codex-flow' }
}

async function assertNotSymlink(targetPath, label, fsImpl) {
  try {
    const stat = await fsImpl.lstat(targetPath)
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${targetPath}`)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
}

async function assertRegularSource(sourcePath, required, fsImpl) {
  try {
    const stat = await fsImpl.lstat(sourcePath)
    if (!stat.isFile()) {
      const kind = required ? 'required source' : 'optional source'
      throw new Error(`${kind} must be a regular file: ${sourcePath}`)
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return false
    throw error
  }
}

async function copyAndVerify(sourcePath, destinationPath, fsImpl) {
  await assertNotSymlink(destinationPath, 'destination file', fsImpl)
  try {
    await fsImpl.unlink(destinationPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fsImpl.copyFile(sourcePath, destinationPath, FS_CONSTANTS.COPYFILE_EXCL)
  await assertNotSymlink(destinationPath, 'destination file', fsImpl)
  const [sourceBytes, destinationBytes] = await Promise.all([
    fsImpl.readFile(sourcePath),
    fsImpl.readFile(destinationPath),
  ])
  if (!sourceBytes.equals(destinationBytes)) throw new Error(`copy verification mismatch: ${destinationPath}`)
}

/** Copy and verify the control files needed by one parallel worktree. */
export async function setupWorktreeControlFiles({
  worktree,
  task,
  sourceDir = '.codex-flow',
  cwd = process.cwd(),
  fsImpl = fs,
  git = defaultGit,
}) {
  if (typeof worktree !== 'string' || worktree.trim() === '') {
    throw new TypeError('worktree must be a non-empty string')
  }
  if (typeof task !== 'string' || !TASK_ID.test(task)) throw new TypeError('task must match ^T\\d+$')
  if (typeof sourceDir !== 'string' || sourceDir.trim() === '') {
    throw new TypeError('sourceDir must be a non-empty string')
  }
  const resolvedWorktree = path.resolve(cwd, worktree)
  let realWorktree
  try {
    realWorktree = await fsImpl.realpath(resolvedWorktree)
  } catch (error) {
    throw new Error(`worktree path cannot be resolved: ${resolvedWorktree}: ${errorMessage(error)}`)
  }
  const worktreeStat = await fsImpl.lstat(realWorktree)
  if (!worktreeStat.isDirectory()) throw new Error(`worktree path is not a directory: ${realWorktree}`)
  let gitTopLevel
  try {
    gitTopLevel = (await git(['-C', realWorktree, 'rev-parse', '--show-toplevel'])).trim()
    gitTopLevel = await fsImpl.realpath(gitTopLevel)
  } catch (error) {
    throw new Error(`worktree path is not a git work-tree top level: ${realWorktree}: ${errorMessage(error)}`)
  }
  const relativeTopLevel = path.relative(realWorktree, gitTopLevel)
  if (relativeTopLevel !== '') throw new Error(`worktree path is not a git work-tree top level: ${realWorktree}`)
  const resolvedSourceDir = path.resolve(cwd, sourceDir)
  const destinationDir = path.join(realWorktree, '.codex-flow')
  await assertNotSymlink(destinationDir, 'destination directory', fsImpl)

  const fileNames = [...REQUIRED_FILES, `CONTEXT-${task}.md`, `SKILLS-${task}.md`]
  const sourcePaths = []
  for (const fileName of fileNames) {
    const sourcePath = path.join(resolvedSourceDir, fileName)
    const required = !fileName.startsWith('SKILLS-')
    if (await assertRegularSource(sourcePath, required, fsImpl)) sourcePaths.push({ fileName, sourcePath })
  }
  await fsImpl.mkdir(destinationDir, { recursive: true })
  await assertNotSymlink(destinationDir, 'destination directory', fsImpl)
  const copied = []
  const attemptedDestinations = []
  try {
    for (const { fileName, sourcePath } of sourcePaths) {
      const destinationPath = path.join(destinationDir, fileName)
      attemptedDestinations.push(destinationPath)
      await copyAndVerify(sourcePath, destinationPath, fsImpl)
      copied.push(fileName)
    }
  } catch (error) {
    await Promise.all(attemptedDestinations.map(async (destinationPath) => {
      try { await fsImpl.unlink(destinationPath) } catch { /* best effort cleanup */ }
    }))
    throw error
  }
  return { copied }
}

async function main(argv = process.argv.slice(2)) {
  const config = parseCliArgs(argv)
  const result = await setupWorktreeControlFiles(config)
  process.stdout.write(`worktree-setup: copied ${result.copied.join(', ')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`worktree-setup: ${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
