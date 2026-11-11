import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  JournalRejectedError, eventsPathFor, journalCheck, journalFilesFor, journalInit, journalPathFor,
  journalTransition, journalViolations,
  prepareJournal,
  readTasksForAdvance,
} from './flow-events.mjs'
import {
  APPROVAL_GATES,
  NON_LINEAR_COMMANDS,
  PHASES,
  parseCliArgs,
} from './flow-state-cli.mjs'

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
export { PHASES }
export const TASK_STAGES = Object.freeze([
  'idle',
  'launching',
  'executing',
  'reviewing',
  'handoff',
  'merge-conflict',
])
export const TASK_STATUSES = Object.freeze(['pending', 'in-progress', 'done', 'failed'])
export const TERMINAL_TASK_STATUSES = Object.freeze(['done', 'failed'])
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
const TERMINAL_TASK_STATUS_SET = new Set(TERMINAL_TASK_STATUSES)
const TASK_ID = /^T\d+$/
const NO_SELECTOR = '-'
const STATE_LINE = /^- ([A-Za-z][A-Za-z0-9]*):[ \t]*([^\r\n]*)(\r\n|\n|$)/gm
const TASK_HEADING = /^##[ \t]+(T\d+):[^\r\n]*(?:\r\n|\n|$)/gm
const STATUS_LINE = /^- Status:[ \t]*([^\r\n]*)(\r\n|\n|$)/gm
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const APPROVAL_KEYS = Object.freeze(APPROVAL_GATES.map((gate) => `${gate}Approved`))
const SELECTOR_RESET_CHANGES = Object.freeze([
  ['currentTask', NO_SELECTOR],
  ['taskStage', 'idle'],
  ['wave', NO_SELECTOR],
])
const TYPED_APPROVAL_COMMANDS = Object.freeze({
  phase: 'advance or a typed transition command',
  requirementsApproved: 'approve requirements or requirement-delta',
  planApproved: 'approve plan or requirement-delta',
  backlogApproved: 'approve backlog, plan-drift, or improvement-gate',
})
const ADVANCE_RULES = Object.freeze({
  interview: Object.freeze({ next: 'plan', guard: 'requirementsApproved' }),
  plan: Object.freeze({ next: 'backlog', guard: 'planApproved' }),
  backlog: Object.freeze({ next: 'execution', guard: 'backlogApproved' }),
  execution: Object.freeze({ next: 'review', guard: 'terminalTasks' }),
  review: Object.freeze({ next: 'complete', guard: 'allApprovalsAndTerminalTasks' }),
})
export const APPROVE_RULES = Object.freeze({
  requirements: Object.freeze({ phase: 'interview', key: 'requirementsApproved', artifact: 'REQUIREMENTS.md' }),
  plan: Object.freeze({ phase: 'plan', key: 'planApproved', artifact: 'PLAN.md' }),
  backlog: Object.freeze({ phase: 'backlog', key: 'backlogApproved', artifact: 'TASKS.md' }),
})
export const NON_LINEAR_RULES = Object.freeze({
  'requirement-delta': Object.freeze({ phases: Object.freeze(['plan', 'backlog', 'execution', 'review']) }),
  'plan-drift': Object.freeze({ phases: Object.freeze(['execution', 'review']) }),
  'improvement-gate': Object.freeze({ phases: Object.freeze(['execution', 'review']) }),
})
if (!APPROVAL_GATES.every((gate) => Object.hasOwn(APPROVE_RULES, gate))
  || Object.keys(APPROVE_RULES).length !== APPROVAL_GATES.length) {
  throw new Error('approval gate list does not match approval rules')
}
if (!NON_LINEAR_COMMANDS.every((command) => Object.hasOwn(NON_LINEAR_RULES, command))
  || Object.keys(NON_LINEAR_RULES).length !== NON_LINEAR_COMMANDS.length) {
  throw new Error('non-linear command list does not match transition rules')
}

/** Error raised when a typed flow transition guard rejects a command. */
export class TransitionRejectedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransitionRejectedError'
  }
}
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
  if (key === 'currentTask' && value !== NO_SELECTOR && !TASK_ID.test(value)) {
    return 'must be T<n> or -'
  }
  if (key === 'wave' && value !== NO_SELECTOR && !/^[1-9]\d*$/.test(value)) {
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
function stateValueOf(state, key) {
  const value = parseState(state)[key]
  if (value === undefined) throw new Error(`missing state key ${key}`)
  return value
}
function rejectTransition(message) {
  throw new TransitionRejectedError(message)
}
function approvalIsYes(value) {
  return value.startsWith('yes')
}
function requirePhase(state, expected, command) {
  const phase = stateValueOf(state, 'phase')
  if (phase !== expected) rejectTransition(`${command} requires phase ${expected} (was ${phase})`)
}
function requireApprovals(state, keys, command) {
  for (const key of keys) {
    if (!approvalIsYes(stateValueOf(state, key))) {
      rejectTransition(`${command} requires ${key} to start with yes`)
    }
  }
}
function applyStateChanges(text, changes) {
  return changes.reduce((state, [key, value]) => setStateKey(state, key, value), text)
}
function timestampValue(at) {
  const timestamp = at ?? new Date().toISOString()
  validateTimestamp(timestamp)
  return timestamp
}
function dateValue(at) {
  const date = at ?? new Date().toISOString().slice(0, 10)
  if (ISO_DATE.test(date)) {
    const [, year, month, day] = date.match(ISO_DATE)
    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (parsed.getUTCFullYear() === Number(year)
      && parsed.getUTCMonth() + 1 === Number(month)
      && parsed.getUTCDate() === Number(day)) return date
  } else {
    validateTimestamp(date)
    return date.slice(0, 10)
  }
  throw new Error(`invalid ISO 8601 timestamp ${JSON.stringify(date)}`)
}
function phaseApprovalKeys(phase) {
  const phaseIndex = PHASES.indexOf(phase)
  if (phaseIndex < 0) throw new Error(`invalid phase ${JSON.stringify(phase)}`)
  return APPROVAL_KEYS.slice(0, Math.max(0, phaseIndex))
}
function ensureTargetPhase(currentPhase, targetPhase) {
  if (!PHASE_SET.has(targetPhase)) {
    throw new Error(`invalid phase ${JSON.stringify(targetPhase)}`)
  }
  if (PHASES.indexOf(targetPhase) > PHASES.indexOf(currentPhase)) {
    rejectTransition(`resume cannot move phase forward from ${currentPhase} to ${targetPhase}`)
  }
}
/** Return a new state text with one typed approval recorded. */
export function approveState(text, gate, {
  at,
  delta = false,
  checkpointCommits,
  executionMode,
} = {}) {
  assertString(text, 'text')
  assertString(gate, 'gate')
  const rule = APPROVE_RULES[gate]
  if (!rule) throw new Error(`unknown approval ${gate}`)
  if (gate !== 'backlog' && (checkpointCommits !== undefined || executionMode !== undefined)) {
    throw new Error('--checkpoint-commits and --execution-mode are only valid for approve backlog')
  }
  const phase = stateValueOf(text, 'phase')
  if (gate === 'requirements' && delta) {
    if (phase !== 'plan') rejectTransition(`approve requirements --delta requires phase plan (was ${phase})`)
  } else {
    requirePhase(text, rule.phase, `approve ${gate}`)
  }
  const earlier = gate === 'plan'
    ? ['requirementsApproved']
    : gate === 'backlog' ? ['requirementsApproved', 'planApproved'] : []
  requireApprovals(text, earlier, `approve ${gate}`)
  if (delta && gate !== 'requirements') rejectTransition(`--delta is only valid for approve requirements`)
  const timestamp = delta ? dateValue(at) : timestampValue(at)
  const value = delta ? `yes (delta ${timestamp})` : `yes (${timestamp})`
  const changes = [[rule.key, value]]
  if (gate === 'backlog' && checkpointCommits !== undefined) {
    changes.push(['checkpointCommits', checkpointCommits])
  }
  if (gate === 'backlog' && executionMode !== undefined) {
    changes.push(['executionMode', executionMode])
  }
  return applyStateChanges(text, changes)
}
function ensureTerminalTasks(tasksText, command) {
  if (tasksText === null) rejectTransition(`${command} requires TASKS.md`)
  const violations = terminalStatusViolations(tasksText)
  if (violations.length > 0) rejectTransition(`${command} requires every task status to be done or failed`)
}
/** Return a new state text after exactly one forward phase transition. */
export function advanceState(text, { tasksText = null } = {}) {
  assertString(text, 'text')
  const phase = stateValueOf(text, 'phase')
  const rule = ADVANCE_RULES[phase]
  if (!rule) rejectTransition(`advance is not allowed from phase ${phase}`)
  if (rule.guard === 'terminalTasks') {
    requireStateSelectors(text, 'advance execution -> review')
    ensureTerminalTasks(tasksText, 'advance execution -> review')
  } else if (rule.guard === 'allApprovalsAndTerminalTasks') {
    requireApprovals(text, APPROVAL_KEYS, 'advance review -> complete')
    ensureTerminalTasks(tasksText, 'advance review -> complete')
  } else {
    requireApprovals(text, [rule.guard], `advance ${phase} -> ${rule.next}`)
  }
  return setStateKey(text, 'phase', rule.next)
}
function requireStateSelectors(text, command) {
  if (stateValueOf(text, 'taskStage') !== 'idle') {
    rejectTransition(`${command} requires taskStage idle`)
  }
  if (stateValueOf(text, 'currentTask') !== NO_SELECTOR) {
    rejectTransition(`${command} requires currentTask -`)
  }
}
function requireNonLinearPhase(text, command) {
  const phase = stateValueOf(text, 'phase')
  const rule = NON_LINEAR_RULES[command]
  if (!rule.phases.includes(phase)) {
    rejectTransition(`${command} requires phase ${rule.phases.join(' or ')} (was ${phase})`)
  }
}
/** Return a new state text after recording a requirements delta. */
export function requirementDeltaState(text, { at } = {}) {
  assertString(text, 'text')
  requireNonLinearPhase(text, 'requirement-delta')
  const timestamp = dateValue(at)
  return applyStateChanges(text, [
    ['phase', 'plan'],
    ['requirementsApproved', `yes (delta ${timestamp})`],
    ['planApproved', `no (delta ${timestamp})`],
    ['backlogApproved', `no (delta ${timestamp})`],
    ...SELECTOR_RESET_CHANGES,
  ])
}
function applyBacklogGate(text, command, marker, at) {
  assertString(text, 'text')
  requireNonLinearPhase(text, command)
  const timestamp = dateValue(at)
  return applyStateChanges(text, [
    ['phase', 'backlog'],
    ['backlogApproved', `no (${marker} ${timestamp})`],
    ...SELECTOR_RESET_CHANGES,
  ])
}
/** Return a new state text after recording plan drift. */
export function planDriftState(text, { at } = {}) {
  return applyBacklogGate(text, 'plan-drift', 'plan drift', at)
}
/** Return a new state text after recording an improvement gate. */
export function improvementGateState(text, { at } = {}) {
  return applyBacklogGate(text, 'improvement-gate', 'improvement tasks', at)
}
/** Return a new state text after recording a resume head and optional earlier phase. */
export function resumeState(text, head, { phase } = {}) {
  assertString(text, 'text')
  assertString(head, 'head')
  if (!head || /[\r\n]/.test(head)) throw new Error('resume head must be a non-empty single-line value')
  const currentPhase = stateValueOf(text, 'phase')
  const targetPhase = phase ?? currentPhase
  ensureTargetPhase(currentPhase, targetPhase)
  requireApprovals(text, phaseApprovalKeys(targetPhase), `resume to ${targetPhase}`)
  const changes = [['resumeHead', head]]
  if (phase !== undefined) changes.push(['phase', targetPhase])
  if (targetPhase !== 'execution') changes.push(...SELECTOR_RESET_CHANGES)
  return applyStateChanges(text, changes)
}
function singleValueOf(lines, key) {
  const matches = lines.filter((line) => line.key === key)
  return matches.length === 1 ? matches[0].value : null
}
function selectorViolations(lines) {
  const currentTask = singleValueOf(lines, 'currentTask')
  const taskStage = singleValueOf(lines, 'taskStage')
  const wave = singleValueOf(lines, 'wave')
  if (taskStage === null || !TASK_STAGE_SET.has(taskStage)) return []
  if (currentTask === null || stateValueError('currentTask', currentTask)) return []
  if (taskStage === 'idle') {
    return TASK_ID.test(currentTask)
      ? [{ key: 'taskStage', reason: `currentTask ${currentTask} cannot be idle` }]
      : []
  }
  if (currentTask === NO_SELECTOR && wave === NO_SELECTOR) {
    return [{ key: 'taskStage', reason: 'non-idle taskStage requires currentTask or wave' }]
  }
  return []
}
function phaseSelectorViolations(lines) {
  const phase = singleValueOf(lines, 'phase')
  const taskStage = singleValueOf(lines, 'taskStage')
  if (!PHASE_SET.has(phase)
    || taskStage === null
    || !TASK_STAGE_SET.has(taskStage)
    || taskStage === 'idle') {
    return []
  }
  if (phase !== 'execution') {
    return [{ key: 'taskStage', reason: 'non-idle taskStage requires phase execution' }]
  }
  return []
}
function terminalStatusViolations(tasksText) {
  return taskSectionsOf(tasksText).flatMap((section) => {
    const matches = statusMatchesOf(tasksText, section)
    if (matches.length === 0) {
      return [{ key: 'tasks', reason: `${section.id} has no Status line` }]
    }
    if (matches.length > 1) {
      return [{ key: 'tasks', reason: `${section.id} has ${matches.length} Status lines` }]
    }
    const status = matches[0].value
    if (TERMINAL_TASK_STATUS_SET.has(status)) return []
    return [{
      key: 'tasks',
      reason: `phase complete requires ${section.id} status done or failed (was ${status})`,
    }]
  })
}
function approvalViolations(lines) {
  const phase = singleValueOf(lines, 'phase')
  if (!PHASE_SET.has(phase)) return []
  const approvals = Object.fromEntries(APPROVAL_KEYS.map((key) => [key, singleValueOf(lines, key)]))
  return phaseApprovalKeys(phase).flatMap((key) => (
    approvals[key] !== null && approvalIsYes(approvals[key])
      ? []
      : [{ key, reason: `phase ${phase} requires ${key} to start with yes` }]
  ))
}
export function checkState(text, { tasksText = null, events, journal = null } = {}) {
  assertString(text, 'text')
  if (tasksText !== null && typeof tasksText !== 'string') {
    throw new TypeError('tasksText must be a string or null')
  }
  const lines = stateLinesOf(text)
  const keyViolations = STATE_KEYS.flatMap((key) => {
    const matches = lines.filter((line) => line.key === key)
    if (matches.length === 0) return [{ key, reason: 'missing' }]
    if (matches.length > 1) return [{ key, reason: `appears ${matches.length} times` }]
    const reason = stateValueError(key, matches[0].value)
    return reason ? [{ key, reason }] : []
  })
  const isComplete = singleValueOf(lines, 'phase') === 'complete'
  const taskViolations = isComplete && tasksText !== null
    ? terminalStatusViolations(tasksText)
    : []
  const base = [
    ...keyViolations,
    ...approvalViolations(lines),
    ...selectorViolations(lines),
    ...phaseSelectorViolations(lines),
    ...taskViolations,
  ]
  return journal ? [...base, ...journalViolations(text, events ?? [], journal.corrupt ?? null)] : base
}
function taskSectionsOf(text) {
  const headings = [...text.matchAll(TASK_HEADING)]
  return headings.map((heading, index) => ({
    id: heading[1],
    start: heading.index,
    end: headings[index + 1]?.index ?? text.length,
  }))
}

/** Every `- Status:` line inside one task section, with absolute offsets. */
function statusMatchesOf(tasksText, section) {
  const block = tasksText.slice(section.start, section.end)
  return [...block.matchAll(STATUS_LINE)].map((match) => ({
    value: match[1],
    start: section.start + match.index,
    contentEnd: section.start + match.index + match[0].length - match[2].length,
    end: section.start + match.index + match[0].length,
    ending: match[2],
  }))
}
function statusLineOf(tasksText, section) {
  const matches = statusMatchesOf(tasksText, section)
  if (matches.length === 0) throw new Error(`task ${section.id} has no Status line`)
  if (matches.length > 1) throw new Error(`task ${section.id} has duplicate Status lines`)
  return matches[0]
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
  if (!TASK_ID.test(id)) throw new Error(`invalid task id ${JSON.stringify(id)}`)
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
async function createFileExclusively(targetPath, contents, label) {
  const directory = path.dirname(targetPath)
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' })
    await assertNotSymlink(targetPath, label)
    try {
      await fs.link(temporaryPath, targetPath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        rejectTransition(`init refuses to overwrite existing state file ${targetPath}`)
      }
      throw error
    }
  } finally {
    try {
      await fs.rm(temporaryPath, { force: true })
    } catch {
      // Preserve the primary create error when best-effort cleanup also fails.
    }
  }
}
function createInitialState({ baseline, knownRed, dirtyBaseline = 'none', executor = 'codex' }) {
  const values = {
    phase: 'interview',
    requirementsApproved: 'no',
    planApproved: 'no',
    backlogApproved: 'no',
    runBaselineRef: baseline,
    resumeHead: '',
    knownRed,
    checkpointCommits: '',
    executionMode: 'undecided',
    dirtyBaseline,
    executor,
    currentTask: '-',
    taskStage: 'idle',
    wave: '-',
  }
  for (const key of STATE_KEYS) validateStateKeyValue(key, values[key])
  return [
    '# codex-flow run state',
    '',
    '## Run state',
    ...STATE_KEYS.map((key) => `- ${key}:${values[key] === '' ? '' : ` ${values[key]}`}`),
    '',
  ].join('\n')
}
async function assertArtifactExists(directory, filename) {
  const artifact = path.join(directory, filename)
  try {
    const stats = await fs.lstat(artifact)
    if (!stats.isFile()) rejectTransition(`approval requires regular file ${filename} in ${directory}`)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      rejectTransition(`approval requires ${filename} in ${directory}`)
    }
    throw error
  }
}
function setStateWithGuards(text, key, value) {
  if (Object.hasOwn(TYPED_APPROVAL_COMMANDS, key)) {
    rejectTransition(`${key} is controlled by ${TYPED_APPROVAL_COMMANDS[key]}`)
  }
  if (key === 'taskStage' && value !== 'idle' && stateValueOf(text, 'phase') !== 'execution') {
    rejectTransition('non-idle taskStage is only allowed in phase execution')
  }
  return setStateKey(text, key, value)
}
async function updateFile(filePath, update, label) {
  const text = await fs.readFile(filePath, 'utf8')
  const updated = update(text)
  await writeFileAtomically(filePath, updated, label)
}
async function runCheck(config, cwd) {
  const tasksText = config.tasks ? await fs.readFile(path.resolve(cwd, config.tasks), 'utf8') : null
  const statePath = path.resolve(cwd, config.state)
  const stateText = await fs.readFile(statePath, 'utf8')
  const violations = await journalCheck({
    statePath, cwd, eventsOption: config.events, stateText, tasksText, checkState,
  })
  for (const violation of violations) console.error(`flow-state: violation: ${violation.key}: ${violation.reason}`)
  return violations.length ? 1 : 0
}
async function runTypedCommand(
  config, cwd, statePath,
  writeState = (text) => writeFileAtomically(statePath, text, 'state file'),
) {
  const beforeText = await fs.readFile(statePath, 'utf8')
  let eventPath
  let journal
  try {
    eventPath = await journalPathFor({ statePath, cwd, eventsOption: config.events })
    journal = await prepareJournal({ eventsPath: eventPath, stateText: beforeText })
  } catch (error) {
    if (error instanceof JournalRejectedError) rejectTransition(error.message)
    throw error
  }
  const journaled = journal.journaled
  const transact = (updated, artifact = null) => journalTransition({
    journaled, eventsPath: eventPath, command: config.command, beforeText, afterText: updated,
    extra: artifact ? { gate: config.gate, artifact: path.basename(artifact), artifactPath: artifact } : {},
    writeState,
  })
  if (config.command === 'approve') {
    const directory = path.resolve(cwd, config.dir)
    if (config.gate !== 'backlog'
      && (config.checkpointCommits !== undefined || config.executionMode !== undefined)) {
      throw new Error('--checkpoint-commits and --execution-mode are only valid for approve backlog')
    }
    await assertArtifactExists(directory, APPROVE_RULES[config.gate].artifact)
    if (config.checkpointCommits !== undefined
      && !['yes', 'no'].includes(config.checkpointCommits)) {
      throw new Error('--checkpoint-commits must be yes or no')
    }
    if (config.executionMode !== undefined && /[\r\n]/.test(config.executionMode)) {
      throw new Error('--execution-mode must be a single line')
    }
    const updated = approveState(beforeText, config.gate, config)
    await transact(updated, path.join(directory, APPROVE_RULES[config.gate].artifact))
    return 0
  }
  if (config.command === 'advance') {
    const stateText = beforeText
    const tasksText = await readTasksForAdvance({
      stateText, tasksPath: path.resolve(cwd, config.tasks),
      readState: (file) => fs.readFile(file, 'utf8'),
      reject: (message) => rejectTransition(message),
    })
    await transact(advanceState(stateText, { tasksText }))
    return 0
  }
  const transitions = {
    'requirement-delta': requirementDeltaState,
    'plan-drift': planDriftState,
    'improvement-gate': improvementGateState,
  }
  if (transitions[config.command]) {
    await transact(transitions[config.command](beforeText, config))
    return 0
  }
  if (config.command === 'resume') {
    await transact(resumeState(beforeText, config.head, config))
    return 0
  }
  throw new Error(`unknown command ${config.command}`)
}
/** Execute the flow-state CLI and return its exit code. */
export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), writeState } = {}) {
  assertString(cwd, 'cwd')
  if (!cwd.trim()) throw new Error('cwd must be a non-empty string')
  const config = parseCliArgs(argv)
  try {
    if (config.command === 'init') {
      const target = path.resolve(cwd, config.state)
      const stateText = createInitialState(config)
      try {
        await journalInit({
          eventsPath: await journalPathFor({ statePath: target, cwd, eventsOption: config.events }),
          defaultEventsPath: path.resolve(eventsPathFor(target)),
          statePath: target,
          stateText,
          createState: () => createFileExclusively(target, stateText, 'state file'),
        })
      } catch (error) {
        if (error instanceof JournalRejectedError) {
          throw new TransitionRejectedError(error.message)
        }
        throw error
      }
      return 0
    }
    if (config.command === 'set') {
      await updateFile(
        path.resolve(cwd, config.state),
        (text) => setStateWithGuards(text, config.key, config.value),
        'state file',
      )
      return 0
    }
    if (config.command === 'task') {
      await updateFile(
        path.resolve(cwd, config.tasks),
        (text) => setTaskStatus(text, config.id, config.status, { at: config.at }),
        'tasks file',
      )
      return 0
    }
    if (config.command === 'check') return runCheck(config, cwd)
    if (config.command === 'archive-paths') {
      const files = await journalFilesFor({ statePath: path.resolve(cwd, config.state) })
      for (const file of files) console.log(file)
      return 0
    }
    const statePath = path.resolve(cwd, config.state)
    const writer = writeState ?? ((text) => writeFileAtomically(statePath, text, 'state file'))
    return await runTypedCommand(config, cwd, statePath, writer)
  } catch (error) {
    if (error instanceof TransitionRejectedError || error instanceof JournalRejectedError) {
      console.error(`flow-state: rejected: ${error.message}`)
      return 1
    }
    throw error
  }
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
