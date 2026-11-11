import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/** Gate keys recorded in every state snapshot. */
export const GATE_KEYS = Object.freeze([
  'phase', 'requirementsApproved', 'planApproved', 'backlogApproved',
])
const STATUSES = new Set(['begin', 'commit', 'abort'])

/** Error raised when a journal blocks a typed operation. */
export class JournalRejectedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JournalRejectedError'
  }
}

/** Return the four gate values from STATE.md text. */
export function gateSnapshot(stateText) {
  if (typeof stateText !== 'string') throw new TypeError('stateText must be a string')
  const snapshot = {}
  for (const key of GATE_KEYS) {
    const match = stateText.match(new RegExp(`^- ${key}:[ \\t]*([^\\r\\n]*)`, 'm'))
    snapshot[key] = match ? match[1] : null
  }
  return snapshot
}

/** Return the default journal path beside a state file. */
export function eventsPathFor(statePath) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath must be a non-empty string')
  return path.join(path.dirname(statePath), 'EVENTS.jsonl')
}

/**
 * Classify the default journal: absent, an ordinary journal, or a redirect to an absolute path.
 * A redirect must be the file's only line; anything else mentioning one is corrupt.
 */
async function readDefaultJournal(defaultPath) {
  let text
  try {
    text = await fs.readFile(defaultPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  const lines = text.split('\n')
  let record = null
  try {
    record = lines.length === 2 && lines[1] === '' ? JSON.parse(lines[0]) : null
  } catch {
    record = null // readEvents reports ordinary corrupt JSON
  }
  if (record && typeof record === 'object' && 'redirect' in record) {
    if (typeof record.redirect !== 'string' || !path.isAbsolute(record.redirect)) {
      throw new JournalRejectedError(`corrupt journal: redirect in ${defaultPath} must be an absolute path`)
    }
    return { kind: 'redirect', target: path.resolve(record.redirect) }
  }
  if (text.includes('"redirect"')) {
    throw new JournalRejectedError(`corrupt journal: redirect must be the sole line of ${defaultPath}`)
  }
  return { kind: 'ordinary' }
}

/** Return the existing default journal and, for redirects, its existing target. */
export async function journalFilesFor({ statePath }) {
  const defaultPath = path.resolve(eventsPathFor(path.resolve(statePath)))
  const journal = await readDefaultJournal(defaultPath)
  if (journal.kind === 'absent') return []
  if (journal.kind !== 'redirect') return [defaultPath]
  if (await pathExists(journal.target) && !(await isRegularFile(journal.target))) {
    throw new JournalRejectedError(`corrupt journal: redirect target is not a regular file: ${journal.target}`)
  }
  if (!(await pathExists(journal.target))) return [defaultPath]
  // Never hand an archiver a file outside the project that owns the control directory.
  const projectRoot = path.dirname(path.dirname(defaultPath))
  const relative = path.relative(projectRoot, journal.target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new JournalRejectedError(
      `redirect target ${journal.target} is outside ${projectRoot}; archive it by hand`,
    )
  }
  return [defaultPath, journal.target]
}

/** True when the path itself is a regular file (a symlink, even to a file, or a directory is not). */
async function isRegularFile(file) {
  try {
    return (await fs.lstat(file)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Resolve the journal path, following one default-journal redirect when present. */
export async function resolveJournalPath({ statePath, eventsOption }) {
  const defaultPath = path.resolve(eventsPathFor(path.resolve(statePath)))
  const explicit = eventsOption === undefined ? null : path.resolve(eventsOption)
  const journal = await readDefaultJournal(defaultPath)
  if (journal.kind === 'absent') return explicit ?? defaultPath
  const recorded = journal.kind === 'redirect' ? journal.target : defaultPath
  if (explicit && explicit !== recorded) {
    throw new JournalRejectedError(
      `--events ${explicit} does not match the journal recorded for this run (${recorded})`,
    )
  }
  if (journal.kind === 'redirect' && !(await isRegularFile(recorded))) {
    throw new JournalRejectedError(`corrupt journal: redirect target missing: ${recorded}`)
  }
  return recorded
}

/** Resolve the journal for a CLI call: a relative --events value is taken against cwd. */
export function journalPathFor({ statePath, cwd, eventsOption }) {
  return resolveJournalPath({
    statePath,
    eventsOption: eventsOption === undefined ? undefined : path.resolve(cwd, eventsOption),
  })
}

/** Parse one journal line into a validated record, or say why it is not one. */
function parseRecord(line) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return { error: 'invalid JSON' }
  }
  try {
    validateRecord(record)
  } catch (error) {
    return { error: `invalid record (${error instanceof Error ? error.message : String(error)})` }
  }
  if (record.status === 'begin' && (!record.after || typeof record.after !== 'object')) {
    return { error: 'invalid record (begin event has no after snapshot)' }
  }
  return { record }
}

/** Read JSONL events without throwing for corrupt content. */
export async function readEvents(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    if (text === '') return { events: [], corrupt: null }
    const lines = text.split('\n')
    const hasTrailingNewline = text.endsWith('\n')
    const events = []
    for (let index = 0; index < lines.length; index += 1) {
      if (index === lines.length - 1 && hasTrailingNewline) break
      const line = lines[index]
      if (!line) return { events, corrupt: `corrupt journal line ${index + 1}: empty line` }
      const parsed = parseRecord(line)
      if (parsed.error) return { events, corrupt: `corrupt journal line ${index + 1}: ${parsed.error}` }
      events.push(parsed.record)
    }
    if (!hasTrailingNewline && lines.length > 0) {
      return { events, corrupt: `corrupt journal line ${lines.length}: missing trailing newline` }
    }
    return { events, corrupt: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [], corrupt: null, missing: true }
    throw error
  }
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('event record must be an object')
  }
  for (const key of ['id', 'ts', 'command', 'status']) {
    if (typeof record[key] !== 'string' || !record[key]) {
      throw new TypeError(`event ${key} must be a non-empty string`)
    }
  }
  if (!STATUSES.has(record.status)) throw new TypeError(`invalid event status ${record.status}`)
  if (record.before !== undefined && record.before !== null && typeof record.before !== 'object') {
    throw new TypeError('event before must be an object or null')
  }
  if (record.after !== undefined && record.after !== null && typeof record.after !== 'object') {
    throw new TypeError('event after must be an object or null')
  }
  if (record.gate !== undefined && typeof record.gate !== 'string') {
    throw new TypeError('event gate must be a string')
  }
  if (record.artifact !== undefined && typeof record.artifact !== 'string') {
    throw new TypeError('event artifact must be a string')
  }
  if (record.sha256 !== undefined && typeof record.sha256 !== 'string') {
    throw new TypeError('event sha256 must be a string')
  }
}

/** True when the path itself exists (a dangling symbolic link counts as existing). */
async function pathExists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function isSymlink(file) {
  try {
    return (await fs.lstat(file)).isSymbolicLink()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Validate and append exactly one JSONL event. */
export async function appendEvent(file, record) {
  validateRecord(record)
  if (await isSymlink(file)) throw new JournalRejectedError(`journal ${file} must not be a symbolic link`)
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/** Return the last begin event without a matching close event. */
export function openTransaction(events) {
  const open = new Map()
  for (const event of events) {
    if (event.status === 'begin') open.set(event.id, event)
    if (event.status === 'commit' || event.status === 'abort') open.delete(event.id)
  }
  return [...open.values()].at(-1) ?? null
}

/** Return journal integrity violations for a state and event sequence. */
export function journalViolations(stateText, events, corrupt = null) {
  const violations = corrupt ? [{ key: 'journal', kind: 'corrupt', reason: corrupt }] : []
  const open = openTransaction(events)
  if (open) {
    violations.push({
      key: 'journal', kind: 'open',
      reason: `${open.command} began at ${open.ts} and never committed — rerun a typed command to recover`,
    })
  }
  const committed = events.filter((event) => event.status === 'commit').at(-1)
  const committedBegin = committed && events.find((event) => event.id === committed.id && event.status === 'begin')
  if (committed && !committedBegin) {
    violations.push({
      key: 'journal', kind: 'orphan-commit',
      reason: `corrupt journal: commit ${committed.id} has no matching begin`,
    })
  } else if (committedBegin?.after) {
    const current = gateSnapshot(stateText)
    for (const key of GATE_KEYS) {
      if (current[key] !== committedBegin.after[key]) {
        violations.push({
          key: 'journal', kind: 'mismatch',
          reason: `STATE.md ${key} is "${current[key]}" but the last committed event `
            + `recorded "${committedBegin.after[key]}"`,
        })
      }
    }
  }
  return violations
}

/** Prepare a journaled command, rejecting corruption and hand-edited gate values. */
export async function prepareJournal({ eventsPath, stateText }) {
  const journal = await readEvents(eventsPath)
  if (journal.corrupt) throw new JournalRejectedError(journal.corrupt)
  if (journal.missing) return { journaled: false, events: [] }
  await recoverOpenTransaction({ eventsPath, events: journal.events, stateText })
  const current = await readEvents(eventsPath)
  const blocking = journalViolations(stateText, current.events)
    .find((violation) => violation.kind === 'mismatch' || violation.kind === 'orphan-commit')
  if (blocking) throw new JournalRejectedError(blocking.reason)
  return { journaled: true, events: current.events }
}

/** Initialize STATE.md and its journal after checking both exclusive preconditions. */
export async function journalInit({
  eventsPath, defaultEventsPath, statePath, stateText, createState,
  append = appendEvent, remove = (file) => fs.rm(file, { force: true }),
}) {
  const exists = pathExists
  if (await exists(eventsPath)) throw new JournalRejectedError(`init refuses existing journal ${eventsPath}`)
  if (defaultEventsPath !== eventsPath && await exists(defaultEventsPath)) {
    throw new JournalRejectedError(`init refuses existing journal ${defaultEventsPath}`)
  }
  if (await exists(statePath)) {
    throw new JournalRejectedError(`init refuses to overwrite existing state file ${statePath}`)
  }
  // The redirect goes first: a run journaled elsewhere must never exist without its pointer.
  const redirected = defaultEventsPath !== undefined && defaultEventsPath !== eventsPath
  if (redirected) {
    const pointer = `${JSON.stringify({ redirect: path.resolve(eventsPath) })}\n`
    await fs.writeFile(defaultEventsPath, pointer, { encoding: 'utf8', flag: 'wx' })
  }
  const id = randomUUID()
  try {
    await append(eventsPath, {
      id, ts: new Date().toISOString(), command: 'init', status: 'begin',
      before: null, after: gateSnapshot(stateText),
    })
    await createState()
  } catch (error) {
    await abandonInit({ eventsPath, id, pointerPath: redirected ? defaultEventsPath : null, append, remove })
    throw error
  }
  await append(eventsPath, { id, ts: new Date().toISOString(), command: 'init', status: 'commit' })
}

/** Best-effort cleanup of a failed init: record the abort and remove the pointer this init wrote. */
async function abandonInit({ eventsPath, id, pointerPath, append = appendEvent, remove }) {
  try {
    if (await pathExists(eventsPath)) {
      await append(eventsPath, { id, ts: new Date().toISOString(), command: 'init', status: 'abort' })
    }
  } catch {
    // Deliberately dropped: the original init error is the one to report.
  }
  if (!pointerPath) return
  try {
    await (remove ?? ((file) => fs.rm(file, { force: true })))(pointerPath)
  } catch {
    // Deliberately dropped: check reports the dangling redirect as a corrupt journal.
  }
}

/** Recover an unfinished transaction from the current state snapshot. */
export async function recoverOpenTransaction({ eventsPath, events, stateText }) {
  const open = openTransaction(events)
  if (!open) return null
  const current = gateSnapshot(stateText)
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
  const status = same(current, open.after) ? 'commit' : same(current, open.before) ? 'abort' : null
  if (!status) {
    throw new JournalRejectedError(
      `open transaction ${open.command} (${open.id}) matches neither before nor after state`,
    )
  }
  await appendEvent(eventsPath, {
    id: open.id, ts: new Date().toISOString(), command: open.command, status, recovered: true,
  })
  return status
}

/** Run one journaled state transition around an injected state writer. */
export async function runJournaled({ eventsPath, command, beforeText, afterText, extra = {}, writeState }) {
  const id = randomUUID()
  const begin = {
    id, ts: new Date().toISOString(), command, status: 'begin',
    before: gateSnapshot(beforeText), after: gateSnapshot(afterText), ...extra,
  }
  if (begin.artifact) {
    begin.sha256 = createHash('sha256').update(await fs.readFile(begin.artifactPath)).digest('hex')
    begin.artifact = path.basename(begin.artifact)
    delete begin.artifactPath
  }
  await appendEvent(eventsPath, begin)
  try {
    await writeState(afterText)
  } catch (error) {
    try {
      await appendEvent(eventsPath, { id, ts: new Date().toISOString(), command, status: 'abort' })
    } catch {
      // Deliberately drop a best-effort abort failure so the open begin remains recoverable.
    }
    throw error
  }
  await appendEvent(eventsPath, { id, ts: new Date().toISOString(), command, status: 'commit' })
}

/** Write a transition through the journal when one exists, otherwise use the legacy writer. */
export async function journalTransition({ journaled, eventsPath, command, beforeText, afterText, extra, writeState }) {
  if (!journaled) return writeState(afterText)
  return runJournaled({ eventsPath, command, beforeText, afterText, extra, writeState })
}

/** Run the pure state check plus journal violations; a journal that cannot be resolved is one. */
export async function journalCheck({ statePath, cwd, eventsOption, stateText, tasksText, checkState }) {
  let eventsPath
  try {
    eventsPath = await journalPathFor({ statePath, cwd, eventsOption })
  } catch (error) {
    if (!(error instanceof JournalRejectedError)) throw error
    return [...checkState(stateText, { tasksText }), { key: 'journal', kind: 'corrupt', reason: error.message }]
  }
  const journal = await readEvents(eventsPath)
  return checkState(stateText, {
    tasksText, events: journal.events, journal: journal.missing ? null : journal,
  })
}

/** Read the task file required by execution and review phase advances. */
export async function readTasksForAdvance({ stateText, tasksPath, readState, reject }) {
  const phase = stateText.match(/^- phase:[ \t]*([^\r\n]*)/m)?.[1]
  if (phase !== 'execution' && phase !== 'review') return null
  try {
    return await readState(tasksPath)
  } catch (error) {
    if (error?.code === 'ENOENT') reject(`advance ${phase} requires TASKS.md`)
    throw error
  }
}
