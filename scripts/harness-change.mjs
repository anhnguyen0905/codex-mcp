import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { CAUSES, isCause } from './harness-taxonomy.mjs'
import { ledgerPath, matchesFilters, median, parseFilter, readLedger } from './run-ledger.mjs'

const DEFAULT_CHANGES = path.join(os.homedir(), '.codex-mcp', 'harness-changes.jsonl')
const RESULTS = new Set(['confirmed', 'refuted', 'inconclusive'])

const valueAfter = (argv, index) => argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined

export function parseAddArgs(argv) {
  const values = { filters: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, index)
    if (flag === '--filter') values.filters.push(value)
    else if (['--title', '--evidence', '--cause', '--fix', '--expect', '--at-risk', '--after-runs', '--commit'].includes(flag)) values[flag.slice(2).replaceAll('-', '_')] = value
    else throw new Error(`unknown add flag: ${flag}`)
    index += 1
  }
  const required = ['title', 'evidence', 'cause', 'fix', 'expect', 'at_risk', 'after_runs']
  if (required.some((key) => typeof values[key] !== 'string' || values[key].length === 0)) throw new Error('missing required add field')
  const afterRuns = Number(values.after_runs)
  if (!Number.isInteger(afterRuns) || afterRuns < 1) throw new Error('after-runs must be an integer >= 1')
  if (!isCause(values.cause)) throw new Error(`invalid cause: ${values.cause}`)
  if (!values.filters.length || values.filters.some((filter) => typeof filter !== 'string')) throw new Error('at least one filter is required')
  const filters = values.filters.map(parseFilter)
  if (values.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(values.commit)) throw new Error('invalid commit')
  return { title: values.title, evidence: values.evidence, cause: values.cause, fix: values.fix, expect: values.expect, atRisk: values.at_risk, filters, afterRuns, ...(values.commit === undefined ? {} : { commit: values.commit }) }
}

const parseStore = (filePath) => {
  let content
  try { content = readFileSync(filePath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return content.split(/\r?\n/).filter(Boolean).map((line) => {
    let record
    try { record = JSON.parse(line) } catch { throw new Error('malformed harness changes store') }
    if (!validStoreRecord(record)) throw new Error('malformed harness changes store')
    return record
  })
}

const validStoreRecord = (record) => {
  if (!record || record.schemaVersion !== 1 || !/^HC-[0-9]+$/.test(record.id) || typeof record.ts !== 'string') return false
  if (record.kind === 'verdict') return RESULTS.has(record.result) && typeof record.note === 'string' && record.note.length > 0
  return record.kind === 'change' && typeof record.title === 'string' && typeof record.evidence === 'string'
    && isCause(record.cause) && typeof record.fix === 'string' && typeof record.expect === 'string'
    && typeof record.atRisk === 'string' && Number.isInteger(record.afterRuns) && record.afterRuns >= 1
    && Array.isArray(record.filters) && record.filters.every((filter) => {
      try { parseFilter(`${filter.key}=${filter.value}`); return true } catch { return false }
    })
}

export function readChanges(filePath = DEFAULT_CHANGES) {
  return parseStore(filePath)
}

const causesFor = (records) => Object.fromEntries(CAUSES.map((cause) => [cause, records.filter((record) => record.causes?.includes(cause)).length]))
const cohort = (records) => ({ runs: records.length, medianFixRounds: median(records.map((record) => record.fixRounds)), causes: causesFor(records) })

export function dueChanges(changes, ledgerRecords) {
  const verdictIds = new Set(changes.filter((item) => item.kind === 'verdict').map((item) => item.id))
  const items = changes.filter((item) => item.kind === 'change' && !verdictIds.has(item.id))
  return items.map((change) => {
    const matching = ledgerRecords.filter((record) => matchesFilters(record, change.filters)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    const before = matching.filter((record) => Date.parse(record.ts) <= Date.parse(change.ts)).slice(-change.afterRuns)
    const after = matching.filter((record) => Date.parse(record.ts) > Date.parse(change.ts))
    return after.length >= change.afterRuns ? { id: change.id, title: change.title, before: cohort(before), after: cohort(after) } : null
  }).filter(Boolean).sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)))
}

export function buildVerdict(id, result, note, now = new Date()) {
  if (!/^HC-[0-9]+$/.test(id) || !RESULTS.has(result) || typeof note !== 'string' || !note) throw new Error('invalid verdict')
  return { schemaVersion: 1, kind: 'verdict', id, ts: now.toISOString(), result, note }
}

const append = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  appendFileSync(filePath, `${JSON.stringify(value)}\n`, { flag: 'a', mode: 0o600 })
}
const nextId = (changes) => Math.max(0, ...changes.filter((item) => /^HC-[0-9]+$/.test(item.id)).map((item) => Number(item.id.slice(3)))) + 1
const outputDue = (items, json, malformed = 0) => {
  if (json) return JSON.stringify(items) + '\n'
  if (!items.length) return `due: none\n${malformed ? `skipped malformed ledger lines: ${malformed}\n` : ''}`
  return `${items.map((item) => `${item.id}: ${item.title}\nbefore: ${JSON.stringify(item.before)}\nafter: ${JSON.stringify(item.after)}`).join('\n')}\n${malformed ? `skipped malformed ledger lines: ${malformed}\n` : ''}`
}

export function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const store = env.CODEX_MCP_HARNESS_CHANGES ?? DEFAULT_CHANGES
    const command = argv[0]
    if (command === 'add') {
      const data = parseAddArgs(argv.slice(1))
      const changes = readChanges(store)
      append(store, { schemaVersion: 1, kind: 'change', id: `HC-${nextId(changes)}`, ts: new Date().toISOString(), ...data })
      return 0
    }
    if (command === 'due') {
      const json = argv.includes('--json')
      const changes = readChanges(store)
      const ledger = readLedger(ledgerPath(env))
      process.stdout.write(outputDue(dueChanges(changes, ledger.records), json, ledger.malformed))
      return 0
    }
    if (command === 'verdict') {
      const id = valueAfter(argv, argv.indexOf('--id'))
      const result = valueAfter(argv, argv.indexOf('--result'))
      const note = valueAfter(argv, argv.indexOf('--note'))
      const changes = readChanges(store)
      if (!changes.some((item) => item.kind === 'change' && item.id === id) || changes.some((item) => item.kind === 'verdict' && item.id === id)) throw new Error('unknown or closed change')
      append(store, buildVerdict(id, result, note))
      return 0
    }
    throw new Error('usage: add, due, or verdict')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'operation failed'}\n`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
