import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isCause } from './harness-taxonomy.mjs'

const DEFAULT_FILE = path.join('.codex-flow', 'playbook.jsonl')
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/
const isDate = (value) => typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))

export function normalizeLesson(text) {
  if (typeof text !== 'string') throw new Error('lesson must be a string')
  return text.toLowerCase().replace(/\p{P}/gu, '').replace(/\s+/gu, ' ').trim()
}

export function parseLessonLines(input) {
  if (typeof input !== 'string') throw new Error('lesson input must be text')
  return input.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const match = line.match(/^\s*([^|]+?)\s*\|\s*(.*?)\s*$/u)
    if (!match || !isCause(match[1].trim()) || match[2].trim() === '') {
      throw new Error(`invalid lesson line: ${line}`)
    }
    const text = match[2].trim()
    return { cause: match[1].trim(), text, key: normalizeLesson(text) }
  })
}

function validateRecord(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid playbook record')
  const record = item
  if (record.schemaVersion !== 1 || typeof record.id !== 'string' || !/^PB-\d+$/.test(record.id)) throw new Error('invalid playbook record')
  if (!isCause(record.cause) || typeof record.text !== 'string' || typeof record.key !== 'string') throw new Error(`invalid playbook record ${record.id}`)
  if (!Number.isInteger(record.count) || record.count < 1 || !isDate(record.firstSeen) || !isDate(record.lastSeen)) throw new Error(`invalid playbook record ${record.id}`)
  if (!Array.isArray(record.runs) || record.runs.some((run) => typeof run !== 'string' || run === '')) throw new Error(`invalid playbook record ${record.id}`)
  if (record.status !== 'active' && record.status !== 'retired') throw new Error(`invalid playbook record ${record.id}`)
  return record
}

function validateItems(items) {
  if (!Array.isArray(items)) throw new Error('playbook must be an array')
  const ids = new Set()
  return items.map((item) => {
    const record = validateRecord(item)
    if (ids.has(record.id)) throw new Error(`duplicate playbook id ${record.id}`)
    ids.add(record.id)
    return record
  })
}

export async function readPlaybook(file = DEFAULT_FILE) {
  try {
    const content = await fs.readFile(file, 'utf8')
    if (content.trim() === '') return []
    return validateItems(content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    if (error instanceof SyntaxError) throw new Error(`malformed playbook JSONL: ${error.message}`)
    throw error
  }
}

export async function writePlaybook(file, items) {
  const valid = validateItems(items)
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`)
  const content = valid.map((item) => JSON.stringify(item)).join('\n') + (valid.length ? '\n' : '')
  try {
    await fs.writeFile(temporary, content, 'utf8')
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function mergeLessons(items, lessons, { runId, at }) {
  const current = validateItems(items)
  if (typeof runId !== 'string' || runId === '') throw new Error('runId is required')
  if (typeof at !== 'string' || !ISO_DATE.test(at) || Number.isNaN(Date.parse(at))) throw new Error('at must be a valid ISO date-time')
  const merged = current.map((item) => ({ ...item, runs: [...item.runs] }))
  for (const lesson of lessons) {
    if (!lesson || !isCause(lesson.cause) || typeof lesson.text !== 'string') throw new Error('invalid lesson')
    const key = normalizeLesson(lesson.text)
    const existing = merged.find((item) => item.key === key)
    if (existing) {
      if (!existing.runs.includes(runId)) {
        existing.count += 1
        existing.lastSeen = at
        existing.runs = [...existing.runs, runId]
      }
      continue
    }
    const maxId = merged.reduce((max, item) => Math.max(max, Number(item.id.slice(3))), 0)
    merged.push({ schemaVersion: 1, id: `PB-${maxId + 1}`, cause: lesson.cause, text: lesson.text, key, count: 1, firstSeen: at, lastSeen: at, runs: [runId], status: 'active' })
  }
  return merged
}

function orderedActive(items) {
  return validateItems(items).filter((item) => item.status === 'active').sort((a, b) => b.count - a.count || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || Number(a.id.slice(3)) - Number(b.id.slice(3)))
}

export function renderPlaybook(items, maxTokens = Infinity) {
  if (maxTokens !== Infinity && (!Number.isInteger(maxTokens) || maxTokens < 0)) throw new Error('maxTokens must be a non-negative integer')
  let used = 0
  const lines = []
  for (const item of orderedActive(items)) {
    const line = `- [${item.id}] (${item.cause}, ×${item.count}) ${item.text}`
    const next = used + line.length + (lines.length ? 1 : 0)
    if (next / 4 > maxTokens) break
    lines.push(line)
    used = next
  }
  return lines.join('\n')
}

export function prunePlaybook(items, keep) {
  if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer')
  const active = orderedActive(items)
  const kept = new Set(active.slice(0, keep).map((item) => item.id))
  return validateItems(items).map((item) => item.status === 'active' && !kept.has(item.id) ? { ...item, status: 'retired', runs: [...item.runs] } : { ...item, runs: [...item.runs] })
}

function flagValue(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function validateCliArgs(args, command) {
  const commandFlags = {
    merge: new Set(['--file', '--run', '--from', '--at']),
    render: new Set(['--file', '--max-tokens']),
    prune: new Set(['--file', '--keep']),
  }
  const allowed = Object.hasOwn(commandFlags, command) ? commandFlags[command] : undefined
  if (!allowed) throw new Error('usage: merge, render, or prune')
  const seen = new Set()
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag.startsWith('--') || !allowed.has(flag)) throw new Error(`unknown or positional argument: ${flag}`)
    if (seen.has(flag)) throw new Error(`duplicate flag: ${flag}`)
    seen.add(flag)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    index += 1
  }
}

async function main(args) {
  const command = args[0]
  validateCliArgs(args, command)
  const file = path.resolve(flagValue(args, '--file') ?? DEFAULT_FILE)
  if (command === 'merge') {
    const runId = flagValue(args, '--run')
    const source = flagValue(args, '--from')
    if (runId === undefined || source === undefined) throw new Error('merge requires --run and --from')
    const at = flagValue(args, '--at') ?? new Date().toISOString()
    const lessons = parseLessonLines(await fs.readFile(source, 'utf8'))
    await writePlaybook(file, mergeLessons(await readPlaybook(file), lessons, { runId, at }))
    return
  }
  if (command === 'render') {
    const raw = flagValue(args, '--max-tokens')
    const max = raw === undefined ? Infinity : Number(raw)
    if (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(max))) throw new Error('--max-tokens must be a non-negative integer')
    process.stdout.write(renderPlaybook(await readPlaybook(file), max))
    return
  }
  const rawKeep = flagValue(args, '--keep')
  if (!/^\d+$/.test(rawKeep) || !Number.isSafeInteger(Number(rawKeep))) throw new Error('--keep must be a non-negative integer')
  await writePlaybook(file, prunePlaybook(await readPlaybook(file), Number(rawKeep)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`playbook: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
