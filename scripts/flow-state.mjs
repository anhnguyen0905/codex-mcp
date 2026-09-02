import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const STATE_KEYS = Object.freeze([
  'phase',
  'requirementsApproved',
  'planApproved',
  'backlogApproved',
  'runBaselineRef',
  'resumeHead',
  'knownRed',
  'checkpointCommits',
  'executionMode',
  'dirtyBaseline',
  'executor',
  'currentTask',
  'taskStage',
  'wave',
])

export const PHASES = Object.freeze([
  'interview',
  'plan',
  'backlog',
  'execution',
  'review',
  'complete',
])

export const TASK_STAGES = Object.freeze([
  'idle',
  'launching',
  'executing',
  'reviewing',
  'handoff',
  'merge-conflict',
])

export const TASK_STATUSES = Object.freeze(['pending', 'in-progress', 'done', 'failed'])

export const TASK_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['in-progress']),
  'in-progress': Object.freeze(['done', 'failed', 'pending']),
  done: Object.freeze([]),
  failed: Object.freeze(['pending']),
})

const STATE_KEY_SET = new Set(STATE_KEYS)
const PHASE_SET = new Set(PHASES)
const TASK_STAGE_SET = new Set(TASK_STAGES)
const TASK_STATUS_SET = new Set(TASK_STATUSES)
const STATE_LINE = /^- ([A-Za-z][A-Za-z0-9]*):[ \t]*([^\r\n]*)(\r\n|\n|$)/gm
const TASK_HEADING = /^##[ \t]+(T\d+):[^\r\n]*(?:\r\n|\n|$)/gm
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))$/

function assertString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
}

function lineEndingOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function stateLinesOf(text) {
  return [...text.matchAll(STATE_LINE)].map((match) => ({
    key: match[1],
    value: match[2],
    start: match.index,
    contentEnd: match.index + match[0].length - match[3].length,
    end: match.index + match[0].length,
    ending: match[3],
  }))
}

/** Parse canonical state lines into a key/value object. Duplicate keys are rejected. */
export function parseState(text) {
  assertString(text, 'text')
  const entries = []
  const seen = new Set()
  for (const line of stateLinesOf(text)) {
    if (seen.has(line.key)) throw new Error(`duplicate state key ${line.key}`)
    seen.add(line.key)
    entries.push([line.key, line.value])
  }
  return Object.fromEntries(entries)
}

function stateValueError(key, value) {
  if (key === 'phase' && !PHASE_SET.has(value)) return `must be one of ${PHASES.join('|')}`
  if (key === 'taskStage' && !TASK_STAGE_SET.has(value)) {
    return `must be one of ${TASK_STAGES.join('|')}`
  }
  if (key === 'currentTask' && value !== '-' && !/^T\d+$/.test(value)) {
    return 'must be T<n> or -'
  }
  if (key === 'wave' && value !== '-' && !/^[1-9]\d*$/.test(value)) {
    return 'must be a positive integer or -'
  }
  return null
}

function validateStateKeyValue(key, value) {
  assertString(key, 'key')
  assertString(value, 'value')
  if (!STATE_KEY_SET.has(key)) throw new Error(`unknown state key ${key}`)
  if (/[\r\n]/.test(value)) {
    throw new Error(`invalid ${key} value ${JSON.stringify(value)}: must be a single line`)
  }
  const reason = stateValueError(key, value)
  if (reason) throw new Error(`invalid ${key} value ${JSON.stringify(value)}: ${reason}`)
}

function insertionForMissingKey(text, lines, key, value) {
  const lineEnding = lineEndingOf(text)
  const stateLine = `- ${key}: ${value}`
  const keyIndex = STATE_KEYS.indexOf(key)
  const previous = [...lines]
    .reverse()
    .find((line) => STATE_KEYS.indexOf(line.key) < keyIndex && STATE_KEY_SET.has(line.key))
  if (previous) {
    const insertion = previous.ending
      ? `${stateLine}${lineEnding}`
      : `${lineEnding}${stateLine}`
    return { at: previous.end, text: insertion }
  }
  const next = lines.find((line) => STATE_KEYS.indexOf(line.key) > keyIndex)
  if (next) return { at: next.start, text: `${stateLine}${lineEnding}` }
  const prefix = text && !text.endsWith('\n') ? lineEnding : ''
  const suffix = text.endsWith('\n') ? lineEnding : ''
  return { at: text.length, text: `${prefix}${stateLine}${suffix}` }
}

/** Return STATE.md text with exactly the selected key line updated or inserted. */
export function setStateKey(text, key, value) {
  assertString(text, 'text')
  validateStateKeyValue(key, value)
  const lines = stateLinesOf(text)
  const matches = lines.filter((line) => line.key === key)
  if (matches.length > 1) throw new Error(`duplicate state key ${key}`)
  if (matches.length === 1) {
    const [line] = matches
    return `${text.slice(0, line.start)}- ${key}: ${value}${text.slice(line.contentEnd)}`
  }
  const insertion = insertionForMissingKey(text, lines, key, value)
  return `${text.slice(0, insertion.at)}${insertion.text}${text.slice(insertion.at)}`
}

/** Return all schema violations in canonical key order. */
export function checkState(text) {
  assertString(text, 'text')
  const lines = stateLinesOf(text)
  return STATE_KEYS.flatMap((key) => {
    const matches = lines.filter((line) => line.key === key)
    if (matches.length === 0) return [{ key, reason: 'missing' }]
    if (matches.length > 1) return [{ key, reason: `appears ${matches.length} times` }]
    const reason = stateValueError(key, matches[0].value)
    return reason ? [{ key, reason }] : []
  })
}

function taskSectionsOf(text) {
  const headings = [...text.matchAll(TASK_HEADING)]
  return headings.map((heading, index) => ({
    id: heading[1],
    start: heading.index,
    end: headings[index + 1]?.index ?? text.length,
  }))
}

function statusLineOf(tasksText, section) {
  const block = tasksText.slice(section.start, section.end)
  const pattern = /^- Status:[ \t]*([^\r\n]*)(\r\n|\n|$)/gm
  const matches = [...block.matchAll(pattern)]
  if (matches.length === 0) throw new Error(`task ${section.id} has no Status line`)
  if (matches.length > 1) throw new Error(`task ${section.id} has duplicate Status lines`)
  const [match] = matches
  return {
    value: match[1],
    start: section.start + match.index,
    contentEnd: section.start + match.index + match[0].length - match[2].length,
    end: section.start + match.index + match[0].length,
    ending: match[2],
  }
}

function validateTimestamp(at) {
  assertString(at, 'at')
  const match = at.match(ISO_8601)
  if (!match) throw new Error(`invalid ISO 8601 timestamp ${JSON.stringify(at)}`)
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
  const isLeapYear = Number(year) % 4 === 0
    && (Number(year) % 100 !== 0 || Number(year) % 400 === 0)
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const isInvalid = Number(month) < 1
    || Number(month) > 12
    || Number(day) < 1
    || Number(day) > (daysInMonth[Number(month) - 1] ?? 0)
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 59
    || Number(offsetHour ?? 0) > 23
    || Number(offsetMinute ?? 0) > 59
  if (isInvalid || Number.isNaN(Date.parse(at))) {
    throw new Error(`invalid ISO 8601 timestamp ${JSON.stringify(at)}`)
  }
}

function transitionInsertionOf(text, statusLine) {
  let at = statusLine.end
  let ending = statusLine.ending
  const transition = /^  - \S+ (?:pending|in-progress|done|failed) -> (?:pending|in-progress|done|failed)(\r\n|\n|$)/
  while (at < text.length) {
    const match = text.slice(at).match(transition)
    if (!match) break
    at += match[0].length
    ending = match[1]
    if (!ending) break
  }
  return { at, hasEnding: Boolean(ending) }
}

/** Return TASKS.md text with one legal status transition recorded. */
export function setTaskStatus(tasksText, id, status, { at = new Date().toISOString() } = {}) {
  assertString(tasksText, 'tasksText')
  assertString(id, 'id')
  assertString(status, 'status')
  if (!/^T\d+$/.test(id)) throw new Error(`invalid task id ${JSON.stringify(id)}`)
  if (!TASK_STATUS_SET.has(status)) throw new Error(`unknown task status ${status}`)
  validateTimestamp(at)

  const sections = taskSectionsOf(tasksText).filter((section) => section.id === id)
  if (sections.length === 0) throw new Error(`task ${id} is missing`)
  if (sections.length > 1) throw new Error(`task ${id} appears more than once`)
  const statusLine = statusLineOf(tasksText, sections[0])
  if (!TASK_STATUS_SET.has(statusLine.value)) {
    throw new Error(`task ${id} has unknown status ${JSON.stringify(statusLine.value)}`)
  }
  if (!TASK_TRANSITIONS[statusLine.value].includes(status)) {
    throw new Error(`illegal task transition ${id}: ${statusLine.value} -> ${status}`)
  }

  const lineEnding = lineEndingOf(tasksText)
  const insertion = transitionInsertionOf(tasksText, statusLine)
  const transitionLine = [
    insertion.hasEnding ? '' : lineEnding,
    `  - ${at} ${statusLine.value} -> ${status}`,
    insertion.hasEnding ? lineEnding : '',
  ].join('')
  const withTransition = `${tasksText.slice(0, insertion.at)}${transitionLine}${tasksText.slice(insertion.at)}`
  return `${withTransition.slice(0, statusLine.start)}- Status: ${status}${withTransition.slice(statusLine.contentEnd)}`
}

async function assertNotSymlink(targetPath, label) {
  try {
    const stats = await fs.lstat(targetPath)
    if (stats.isSymbolicLink()) throw new Error(`${label} is a symlink — refusing to write through it`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing')) throw error
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

async function writeFileAtomically(targetPath, contents, label) {
  const directory = path.dirname(targetPath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' })
    await assertNotSymlink(targetPath, label)
    await fs.rename(temporaryPath, targetPath)
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true })
    } catch {
      // Preserve the primary write error when best-effort cleanup also fails.
    }
    throw error
  }
}

function parseOptions(args, positionalCount, allowedOptions) {
  const positionals = []
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    if (!allowedOptions.has(argument)) throw new Error(`unknown option ${argument}`)
    if (Object.hasOwn(options, argument)) throw new Error(`duplicate option ${argument}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    options[argument] = value
    index += 1
  }
  if (positionals.length !== positionalCount) throw new Error('invalid arguments')
  return { positionals, options }
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('CLI args must be an array of strings')
  }
  const [command, ...args] = argv
  if (command === 'set') {
    const parsed = parseOptions(args, 2, new Set(['--state']))
    return { command, key: parsed.positionals[0], value: parsed.positionals[1], state: parsed.options['--state'] ?? '.codex-flow/STATE.md' }
  }
  if (command === 'check') {
    const parsed = parseOptions(args, 0, new Set(['--state']))
    return { command, state: parsed.options['--state'] ?? '.codex-flow/STATE.md' }
  }
  if (command === 'task') {
    const parsed = parseOptions(args, 2, new Set(['--tasks', '--at']))
    return { command, id: parsed.positionals[0], status: parsed.positionals[1], tasks: parsed.options['--tasks'] ?? '.codex-flow/TASKS.md', at: parsed.options['--at'] }
  }
  throw new Error('usage: flow-state <set|check|task> ...')
}

async function updateFile(filePath, update, label) {
  const text = await fs.readFile(filePath, 'utf8')
  const updated = update(text)
  await writeFileAtomically(filePath, updated, label)
}

/** Execute the flow-state CLI and return its exit code. */
export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  assertString(cwd, 'cwd')
  if (!cwd.trim()) throw new Error('cwd must be a non-empty string')
  const config = parseCliArgs(argv)
  if (config.command === 'set') {
    const statePath = path.resolve(cwd, config.state)
    await updateFile(statePath, (text) => setStateKey(text, config.key, config.value), 'state file')
    return 0
  }
  if (config.command === 'task') {
    const tasksPath = path.resolve(cwd, config.tasks)
    await updateFile(
      tasksPath,
      (text) => setTaskStatus(text, config.id, config.status, { at: config.at }),
      'tasks file',
    )
    return 0
  }
  const statePath = path.resolve(cwd, config.state)
  const violations = checkState(await fs.readFile(statePath, 'utf8'))
  for (const violation of violations) {
    console.error(`flow-state: violation: ${violation.key}: ${violation.reason}`)
  }
  return violations.length ? 1 : 0
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  main()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`flow-state: ${message.replace(/\s+/g, ' ')}`)
      process.exitCode = 1
    })
}
