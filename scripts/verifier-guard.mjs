import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TASK_ID = /^T\d+$/
const ASSERTION_PATTERN = /\bexpect\s*\(|\bassert\s*\(|\bassert\.[A-Za-z_]\w*\s*\(|\.should\b/g

const posixRelative = (root, file) => path.relative(root, file).split(path.sep).join('/')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const statePath = (root, task) => path.join(root, '.codex-flow', 'notes', `verifier-guard-${task}.json`)
const isInside = (root, file) => {
  const relative = path.relative(root, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const validateTask = (task) => {
  if (typeof task !== 'string' || !TASK_ID.test(task)) throw new Error('task must match T<n>')
  return task
}
const validateRoot = (root) => {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('root must be a non-empty path')
  return path.resolve(root)
}

export function assertionCount(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  return [...text.matchAll(ASSERTION_PATTERN)].length
}

export function digestFlowDir(root) {
  const resolvedRoot = validateRoot(root)
  const flowRoot = path.join(resolvedRoot, '.codex-flow')
  const files = {}
  const visit = (directory) => {
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name)
      if (directory === flowRoot && entry.name === 'notes') continue
      const stat = lstatSync(fullPath)
      if (stat.isDirectory()) visit(fullPath)
      else if (stat.isFile()) files[posixRelative(resolvedRoot, fullPath)] = digest(readFileSync(fullPath))
    }
  }
  visit(flowRoot)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

export function testPathsFromVerify(command, root) {
  if (typeof command !== 'string') throw new TypeError('verify must be a string')
  const resolvedRoot = validateRoot(root)
  const tokens = []
  let token = ''
  let quote = null
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    const nextCharacter = command[index + 1]
    if (escaped) {
      token += character
      escaped = false
    } else if (character === '\\' && quote === '"' && (nextCharacter === '"' || nextCharacter === '\\')) escaped = true
    else if (character === '\\' && !quote && (nextCharacter === undefined || /\s|["'\\]/.test(nextCharacter))) escaped = true
    else if (quote) {
      if (character === quote) quote = null
      else token += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) {
      if (token) tokens.push(token)
      token = ''
    } else token += character
  }
  if (escaped || quote) throw new Error('unterminated quote or escape in verify command')
  if (token) tokens.push(token)
  return [...new Set(tokens.map((entry) => path.resolve(resolvedRoot, entry)))]
    .filter((file) => isInside(resolvedRoot, file) && existsSync(file) && lstatSync(file).isFile())
    .map((file) => posixRelative(resolvedRoot, file))
}

const normalizeTestPaths = (paths, root) => paths.map((entry) => {
  if (typeof entry !== 'string' || entry.trim() === '') throw new Error('test paths must be non-empty strings')
  const file = path.resolve(root, entry)
  if (!isInside(root, file)) throw new Error(`test path is outside root: ${entry}`)
  return file
})
const readTests = (paths, root) => {
  const files = {}
  for (const file of paths) {
    if (!existsSync(file) || !lstatSync(file).isFile()) return null
    files[posixRelative(root, file)] = { sha256: digest(readFileSync(file)), assertions: assertionCount(readFileSync(file, 'utf8')) }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}
const readState = (root, task) => JSON.parse(readFileSync(statePath(root, task), 'utf8'))
const writeState = (root, task, state) => {
  const notesDirectory = path.join(root, '.codex-flow', 'notes')
  const target = statePath(root, task)
  const isSymbolicLink = (file) => {
    try {
      return lstatSync(file).isSymbolicLink()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
  if (isSymbolicLink(notesDirectory)) throw new Error('notes directory must not be a symbolic link')
  if (isSymbolicLink(target)) throw new Error('state file must not be a symbolic link')
  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  const temporary = path.join(directory, `.verifier-guard-${task}-${process.pid}-${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temporary, target)
}

export function arm({ task, root = process.cwd(), tests = [], verify } = {}) {
  const resolvedRoot = validateRoot(root)
  const id = validateTask(task)
  const filePaths = tests.length > 0 ? normalizeTestPaths(tests, resolvedRoot) : (verify ? testPathsFromVerify(verify, resolvedRoot).map((file) => path.join(resolvedRoot, file)) : [])
  const target = statePath(resolvedRoot, id)
  let existing = null
  if (existsSync(target)) existing = readState(resolvedRoot, id)
  const captured = existing?.tests ?? (filePaths.length > 0 ? readTests(filePaths, resolvedRoot) : null)
  const state = { schemaVersion: 1, task: id, armedAt: new Date().toISOString(), flow: digestFlowDir(resolvedRoot), tests: captured }
  writeState(resolvedRoot, id, state)
  return state
}

export function check({ task, root = process.cwd() } = {}) {
  const resolvedRoot = validateRoot(root)
  const id = validateTask(task)
  if (!existsSync(statePath(resolvedRoot, id))) throw new Error(`state not found for ${id}`)
  const baseline = readState(resolvedRoot, id)
  const currentFlow = digestFlowDir(resolvedRoot)
  const flowChanges = []
  for (const file of [...new Set([...Object.keys(baseline.flow), ...Object.keys(currentFlow)])].sort()) {
    const change = !(file in baseline.flow) ? 'added' : !(file in currentFlow) ? 'deleted' : 'modified'
    if (change !== 'modified' || baseline.flow[file] !== currentFlow[file]) flowChanges.push({ path: file, change })
  }
  const testChanges = []
  for (const [file, previous] of Object.entries(baseline.tests ?? {})) {
    const fullPath = path.join(resolvedRoot, file)
    if (!existsSync(fullPath) || !lstatSync(fullPath).isFile()) testChanges.push({ path: file, before: previous.assertions, after: 0, dropped: false, deleted: true })
    else {
      const after = assertionCount(readFileSync(fullPath, 'utf8'))
      if (digest(readFileSync(fullPath)) !== previous.sha256) testChanges.push({ path: file, before: previous.assertions, after, dropped: after < previous.assertions, deleted: false })
    }
  }
  return { flowChanges, testChanges }
}

const usage = 'usage: verifier-guard.mjs arm|check --task T<n> [options]'
const parseArgs = (args) => {
  const options = { tests: [] }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--task' || flag === '--root' || flag === '--verify') options[flag.slice(2)] = args[++index]
    else if (flag === '--tests') while (args[index + 1] && !args[index + 1].startsWith('--')) options.tests.push(args[++index])
    else throw new Error(usage)
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (!['arm', 'check'].includes(command)) throw new Error(usage)
    const options = parseArgs(args)
    const result = command === 'arm' ? arm(options) : check(options)
    if (command === 'check') {
      for (const change of result.flowChanges) console.log(`flow-changed: ${change.path} (${change.change})`)
      for (const change of result.testChanges) console.log(change.deleted ? `test-deleted: ${change.path}` : `test-changed: ${change.path} assertions ${change.before} -> ${change.after}${change.dropped ? ' assertions-dropped' : ''}`)
      if (result.flowChanges.length === 0 && result.testChanges.length === 0) console.log('verifier-guard: clean')
      process.exitCode = result.flowChanges.length || result.testChanges.length ? 1 : 0
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
