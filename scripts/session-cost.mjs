import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TOKENS_PER_MILLION = 1_000_000
const COST_DECIMALS = 6
const DEFAULT_LOG_PATH = path.join(homedir(), '.codex-mcp', 'metrics.jsonl')
const VALUE_FLAGS = new Set(['--since', '--until', '--cwd', '--log'])
const PRICING_KEYS = ['inputPer1M', 'cachedInputPer1M', 'outputPer1M', 'reasoningOutputPer1M']
const ISO_FLAG_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isParseableDate = (value) =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))

const hasValidCalendarDate = (year, month, day) => {
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  )
}

const hasValidOffset = (offset) => {
  if (offset === undefined || offset === 'Z') return true
  const hours = Number(offset.slice(1, 3))
  const minutes = Number(offset.slice(4, 6))
  return hours < 14 ? minutes <= 59 : hours === 14 && minutes === 0
}

const isStrictIsoDate = (value) => {
  if (typeof value !== 'string') return false
  const match = value.match(ISO_FLAG_PATTERN)
  if (!match || !hasValidCalendarDate(match[1], match[2], match[3])) return false
  if (match[4] === undefined) return true
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return false
  return hasValidOffset(match[8]) && Number.isFinite(Date.parse(value))
}

const requireFlagValue = (argv, index, flag) => {
  const value = argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

/** Parse and validate session-cost CLI arguments. */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('argv must be an array of strings')
  }

  let parsed = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      parsed = { ...parsed, json: true }
      continue
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument: ${flag}`)
    const value = requireFlagValue(argv, index, flag)
    const key = flag.slice(2)
    if (Object.hasOwn(parsed, key)) throw new Error(`${flag} may only be specified once`)
    parsed = { ...parsed, [key]: value }
    index += 1
  }

  if (!parsed.since) throw new Error('--since <ISO> is required')
  if (!isStrictIsoDate(parsed.since)) throw new Error('--since must be a valid ISO date')
  if (parsed.until && !isStrictIsoDate(parsed.until)) throw new Error('--until must be a valid ISO date')
  if (parsed.until && Date.parse(parsed.until) < Date.parse(parsed.since)) {
    throw new Error('--until must not be earlier than --since')
  }
  return parsed
}

const hasValidUsage = (usage) =>
  usage === null ||
  (isRecord(usage) &&
    isFiniteNonNegative(usage.inputTokens) &&
    isFiniteNonNegative(usage.cachedInputTokens) &&
    isFiniteNonNegative(usage.outputTokens) &&
    isFiniteNonNegative(usage.reasoningOutputTokens))

const isMetricEntry = (entry) =>
  isRecord(entry) &&
  isParseableDate(entry.ts) &&
  typeof entry.tool === 'string' &&
  entry.tool.length > 0 &&
  typeof entry.cwd === 'string' &&
  (entry.exitCode === null || Number.isInteger(entry.exitCode)) &&
  isFiniteNonNegative(entry.durationMs) &&
  hasValidUsage(entry.usage) &&
  (entry.model === undefined || typeof entry.model === 'string') &&
  (entry.errorKind === undefined || typeof entry.errorKind === 'string') &&
  (entry.errorCount === undefined || isFiniteNonNegative(entry.errorCount)) &&
  (entry.timedOut === undefined || typeof entry.timedOut === 'boolean') &&
  (entry.aborted === undefined || typeof entry.aborted === 'boolean')

const readEntriesFile = (filePath) => {
  let content
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    const detail = error instanceof Error ? error.message : 'unknown filesystem error'
    throw new Error(`unable to read metrics log ${filePath}: ${detail}`)
  }

  return content.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const entry = JSON.parse(line)
      // A JSONL record with invalid JSON or an invalid metric shape is unusable by contract.
      return isMetricEntry(entry) ? [entry] : []
    } catch {
      return []
    }
  })
}

/** Read the rotated metrics log first, then the current log. */
export function readEntries(logPath) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new TypeError('logPath must be a non-empty string')
  }
  return [...readEntriesFile(`${logPath}.1`), ...readEntriesFile(logPath)]
}

/** Filter entries by inclusive timestamps and an optional exact cwd match. */
export function filterEntries(entries, { since, until, cwd } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  if (!isStrictIsoDate(since)) throw new Error('since must be a valid ISO date')
  if (until !== undefined && !isStrictIsoDate(until)) throw new Error('until must be a valid ISO date')
  if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('cwd must be a string')

  const sinceMs = Date.parse(since)
  const untilMs = until === undefined ? undefined : Date.parse(until)
  return entries.filter((entry) => {
    if (!isMetricEntry(entry)) throw new TypeError('entries must contain valid metric entries')
    const timestamp = Date.parse(entry.ts)
    if (timestamp < sinceMs || (untilMs !== undefined && timestamp > untilMs)) return false
    return cwd === undefined || entry.cwd === cwd
  })
}

const zeroTokens = () => ({ input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 })

const addUsage = (tokens, usage) => {
  if (!usage) return
  tokens.input += usage.inputTokens
  tokens.cachedInput += usage.cachedInputTokens
  tokens.output += usage.outputTokens
  tokens.reasoningOutput += usage.reasoningOutputTokens
}

const isFailedEntry = (entry) =>
  entry.exitCode !== 0 ||
  entry.timedOut === true ||
  entry.aborted === true ||
  (entry.errorCount ?? 0) > 0 ||
  (typeof entry.errorKind === 'string' && entry.errorKind.length > 0)

const isPricing = (pricing) =>
  isRecord(pricing) && PRICING_KEYS.every((key) => isFiniteNonNegative(pricing[key]))

const estimateCostUsd = (tokens, pricing) => {
  // Cached input and reasoning output are subsets of their respective token totals.
  const billableInput = Math.max(tokens.input - tokens.cachedInput, 0)
  const billableOutput = Math.max(tokens.output - tokens.reasoningOutput, 0)
  return Number(
    (
      (billableInput * pricing.inputPer1M +
        tokens.cachedInput * pricing.cachedInputPer1M +
        billableOutput * pricing.outputPer1M +
        tokens.reasoningOutput * pricing.reasoningOutputPer1M) /
      TOKENS_PER_MILLION
    ).toFixed(COST_DECIMALS),
  )
}

/** Aggregate already-filtered metric entries. */
export function aggregateEntries(entries, pricing) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  if (pricing !== undefined && !isPricing(pricing)) throw new TypeError('pricing must contain four non-negative rates')
  for (const entry of entries) {
    if (!isMetricEntry(entry)) throw new TypeError('entries must contain valid metric entries')
  }

  let totalRuns = 0
  let failed = 0
  let totalDurationMs = 0
  const totalTokens = zeroTokens()
  const byModel = new Map()
  const byTool = new Map()
  for (const entry of entries) {
    const isFailed = isFailedEntry(entry)
    totalRuns += 1
    failed += Number(isFailed)
    totalDurationMs += entry.durationMs
    addUsage(totalTokens, entry.usage)

    const tool = byTool.get(entry.tool) ?? { runs: 0 }
    tool.runs += 1
    byTool.set(entry.tool, tool)
    if (!entry.model) continue

    const model = byModel.get(entry.model) ?? { runs: 0, failed: 0, totalDurationMs: 0, tokens: zeroTokens() }
    model.runs += 1
    model.failed += Number(isFailed)
    model.totalDurationMs += entry.durationMs
    addUsage(model.tokens, entry.usage)
    byModel.set(entry.model, model)
  }
  const aggregate = {
    totalRuns,
    failed,
    totalDurationMs,
    totalTokens,
    byModel: Object.fromEntries(byModel),
    byTool: Object.fromEntries(byTool),
  }
  return pricing === undefined
    ? aggregate
    : { ...aggregate, estimatedCostUsd: estimateCostUsd(aggregate.totalTokens, pricing) }
}

const escapeCell = (value) =>
  String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('|', '\\|')

const renderModelRows = (byModel) => {
  const rows = Object.entries(byModel)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([model, value]) =>
        `| ${escapeCell(model)} | ${value.runs} | ${value.failed} | ${value.totalDurationMs} | ${value.tokens.input} | ${value.tokens.cachedInput} | ${value.tokens.output} | ${value.tokens.reasoningOutput} |`,
    )
  return rows.length > 0 ? rows : ['| _None_ | 0 | 0 | 0 | 0 | 0 | 0 | 0 |']
}

const renderToolRows = (byTool) => {
  const rows = Object.entries(byTool)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, value]) => `| ${escapeCell(tool)} | ${value.runs} |`)
  return rows.length > 0 ? rows : ['| _None_ | 0 |']
}

/** Render a session aggregate as Markdown. */
export function renderMarkdown(aggregate) {
  if (!isRecord(aggregate) || !isRecord(aggregate.totalTokens)) {
    throw new TypeError('aggregate must be a session-cost aggregate')
  }
  const costLine = Object.hasOwn(aggregate, 'estimatedCostUsd')
    ? `Estimated cost: $${aggregate.estimatedCostUsd.toFixed(COST_DECIMALS)} (via CODEX_MCP_PRICING)`
    : 'Estimated cost: n/a (set CODEX_MCP_PRICING)'
  return [
    '# Codex session cost',
    '',
    '## Totals',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Runs | ${aggregate.totalRuns} |`,
    `| Failed | ${aggregate.failed} |`,
    `| Duration (ms) | ${aggregate.totalDurationMs} |`,
    `| Input tokens | ${aggregate.totalTokens.input} |`,
    `| Cached input tokens | ${aggregate.totalTokens.cachedInput} |`,
    `| Output tokens | ${aggregate.totalTokens.output} |`,
    `| Reasoning output tokens | ${aggregate.totalTokens.reasoningOutput} |`,
    '',
    '## Per model',
    '',
    '| Model | Runs | Failed | Duration (ms) | Input | Cached input | Output | Reasoning output |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...renderModelRows(aggregate.byModel),
    '',
    '## Per tool',
    '',
    '| Tool | Runs |',
    '| --- | ---: |',
    ...renderToolRows(aggregate.byTool),
    '',
    costLine,
  ].join('\n')
}

/** Resolve the metrics log path from CLI args, environment, or the user default. */
export function resolveLogPath(args, env) {
  if (!isRecord(args)) throw new TypeError('args must be an object')
  if (!isRecord(env)) throw new TypeError('env must be an object')
  const logPath = args.log ?? env.CODEX_MCP_METRICS_LOG ?? DEFAULT_LOG_PATH
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new TypeError('resolved log path must be a non-empty string')
  }
  return logPath
}

/** Resolve and validate the optional pricing JSON from the environment. */
export function resolvePricing(env) {
  if (!isRecord(env)) throw new TypeError('env must be an object')
  const raw = env.CODEX_MCP_PRICING
  if (!raw) return undefined
  try {
    const pricing = JSON.parse(raw)
    return isPricing(pricing) ? pricing : undefined
  } catch {
    return undefined
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const logPath = resolveLogPath(args, process.env)
    const entries = filterEntries(readEntries(logPath), args)
    const aggregate = aggregateEntries(entries, resolvePricing(process.env))
    console.log(args.json ? JSON.stringify(aggregate, null, 2) : renderMarkdown(aggregate))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    console.error(`session-cost: ${message}`)
    process.exitCode = 1
  }
}
