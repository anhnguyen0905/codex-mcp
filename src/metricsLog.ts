import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodexUsage } from './types.js'

/**
 * Per-run metric appended to ~/.codex-mcp/metrics.jsonl (one JSONL line per completed run).
 * Passive: writing is best-effort — never throws into the caller.
 */
export interface MetricEntry {
  ts: string // ISO 8601
  tool: 'codex_execute' | 'codex_continue' | 'codex_review' | 'codex_batch'
  cwd: string
  sessionId: string | null
  exitCode: number | null
  durationMs: number
  usage: CodexUsage | null
  timedOut?: boolean
  aborted?: boolean
  truncated?: boolean
  /** Number of errors Codex emitted in the event stream (e.g. turn.failed). Absent on legacy lines. */
  errorCount?: number
  /** Primary failure kind: 'exit' | 'timeout' | 'abort' | 'turn-failed'. Absent on legacy lines / successes. */
  errorKind?: string
  /** Server-generated UUID for this run, matching the tool result payload. Absent on legacy lines. */
  runId?: string
  /** Model requested for the run (via --model). Absent when the CLI default was used / legacy lines. */
  model?: string
  /** Batch task identity ("task-<index>"), codex_batch runs only. */
  taskId?: string
  /** Time spent waiting on the concurrency gate + cwd lock before the run started. */
  queueMs?: number
  /** Time from process spawn to the first stdout chunk. Absent when no stdout arrived. */
  timeToFirstProgressMs?: number
}

/** Per-model per-1M-token USD rates used for estimatedCostUsd. */
export interface ModelCostRates {
  inputPer1M: number
  cachedInputPer1M: number
  outputPer1M: number
  reasoningOutputPer1M: number
}

/**
 * Model → USD rates for the model-aware cost estimate. Deliberately ships EMPTY: an unknown
 * model yields NO cost (undefined) — never a fake 0 pretending accuracy. Edit here to enable,
 * e.g.:
 *   'gpt-5.1-codex': { inputPer1M: 1.25, cachedInputPer1M: 0.125, outputPer1M: 10, reasoningOutputPer1M: 10 },
 */
export const COST_TABLE: Readonly<Record<string, ModelCostRates>> = {}

const TOKENS_PER_MILLION = 1_000_000
const COST_DECIMALS = 6

// Cached input and reasoning output are subsets of their respective token totals.
const subsetAwareCostUsd = (
  input: number,
  cachedInput: number,
  output: number,
  reasoningOutput: number,
  rates: ModelCostRates,
): number =>
  (Math.max(input - cachedInput, 0) * rates.inputPer1M +
    cachedInput * rates.cachedInputPer1M +
    Math.max(output - reasoningOutput, 0) * rates.outputPer1M +
    reasoningOutput * rates.reasoningOutputPer1M) /
  TOKENS_PER_MILLION

/** USD cost of one run. Undefined when the model is unknown/unpriced or usage was not recorded. */
export const estimateCostUsd = (
  model: string | undefined,
  usage: CodexUsage | null | undefined,
  costTable: Readonly<Record<string, ModelCostRates>> = COST_TABLE,
): number | undefined => {
  if (!model || !usage) return undefined
  const rates = costTable[model]
  if (!rates) return undefined
  return subsetAwareCostUsd(
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    rates,
  )
}

/** Per-1M-token USD pricing, JSON-encoded in CODEX_MCP_PRICING env (opt-in). */
export interface PricingTable {
  inputPer1M: number
  cachedInputPer1M: number
  outputPer1M: number
  reasoningOutputPer1M: number
}

export interface AggregateFilters {
  since?: string // ISO
  until?: string // ISO
  tool?: MetricEntry['tool']
  cwd?: string
  sessionId?: string
}

export interface TokenTotals {
  input: number
  cachedInput: number
  output: number
  reasoningOutput: number
}

/** Per-model roll-up inside an Aggregate. */
export interface ModelAggregate {
  runs: number
  failed: number
  totalDurationMs: number
  tokens: TokenTotals
  /** Sum of per-run COST_TABLE estimates. Absent when the model has no rates. */
  estimatedCostUsd?: number
}

export interface Aggregate {
  totalRuns: number
  totalDurationMs: number
  totalTokens: TokenTotals
  byTool: Record<string, { runs: number; totalDurationMs: number }>
  /** Per-model breakdown over entries that recorded a model. Empty on legacy-only logs. */
  byModel: Record<string, ModelAggregate>
  failed: number
  estCostUsd?: number // populated only when a pricing table is supplied
  /** Sum of per-run COST_TABLE estimates across models with known rates. Absent when none. */
  estimatedCostUsd?: number
  /** Mean queueMs over entries that recorded it. Absent when none did. */
  avgQueueMs?: number
  /** Mean timeToFirstProgressMs over entries that recorded it. Absent when none did. */
  avgTimeToFirstProgressMs?: number
}

export interface MetricsLogOptions {
  /** Override the default ~/.codex-mcp/metrics.jsonl (mostly for tests). */
  logPath?: string
  /** Cap on log file size; on next append past this, rotate to `<file>.1` and truncate. Default 10MB. */
  maxBytes?: number
}

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024

/** Location of the metrics log, honoring CODEX_MCP_METRICS_LOG env, else ~/.codex-mcp/metrics.jsonl. */
export const defaultLogPath = (): string =>
  process.env.CODEX_MCP_METRICS_LOG ?? join(homedir(), '.codex-mcp', 'metrics.jsonl')

/** Parse the opt-in pricing table from CODEX_MCP_PRICING (JSON). Malformed → undefined, no throw. */
export const parsePricing = (raw: string | undefined): PricingTable | undefined => {
  if (!raw) return undefined
  try {
    const obj: unknown = JSON.parse(raw)
    if (typeof obj !== 'object' || obj === null) return undefined
    const p = obj as Partial<PricingTable>
    if (
      typeof p.inputPer1M !== 'number' ||
      typeof p.cachedInputPer1M !== 'number' ||
      typeof p.outputPer1M !== 'number' ||
      typeof p.reasoningOutputPer1M !== 'number'
    )
      return undefined
    return p as PricingTable
  } catch {
    return undefined
  }
}

/** Append one entry. Rotates the file first if it's past `maxBytes`. Errors are swallowed. */
export const appendMetric = (entry: MetricEntry, options: MetricsLogOptions = {}): void => {
  const logPath = options.logPath ?? defaultLogPath()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    // Rotate if the file exists and exceeds the cap. Only one back-file kept (`.jsonl.1`).
    try {
      const size = statSync(logPath).size
      if (size >= maxBytes) {
        renameSync(logPath, `${logPath}.1`)
      }
    } catch {
      // no file yet — first write.
    }
    appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch {
    // best-effort — metrics logging must never fail a real run.
  }
}

/** Parse one file's JSONL content into entries, tolerating malformed lines (skip). [] if unreadable. */
const readMetricsFile = (path: string): MetricEntry[] => {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: MetricEntry[] = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const parsed: unknown = JSON.parse(t)
      if (typeof parsed !== 'object' || parsed === null) continue
      out.push(parsed as MetricEntry)
    } catch {
      // skip malformed line
    }
  }
  return out
}

/**
 * Read metric entries from the log plus its rotated back-file (`<file>.1`), oldest first.
 * Rotation keeps exactly one back-file (see appendMetric), so reading both covers all history.
 */
export const readMetrics = (options: MetricsLogOptions = {}): MetricEntry[] => {
  const logPath = options.logPath ?? defaultLogPath()
  return [...readMetricsFile(`${logPath}.1`), ...readMetricsFile(logPath)]
}

const inRange = (entry: MetricEntry, filters: AggregateFilters): boolean => {
  if (filters.since && entry.ts < filters.since) return false
  if (filters.until && entry.ts > filters.until) return false
  if (filters.tool && entry.tool !== filters.tool) return false
  if (filters.cwd && entry.cwd !== filters.cwd) return false
  if (filters.sessionId && entry.sessionId !== filters.sessionId) return false
  return true
}

// Failure = process-level failure OR Codex-emitted errors (turn.failed etc.) despite exit 0.
// `errorCount` is absent on legacy lines — treat as 0 so old logs aggregate unchanged.
const isFailedEntry = (e: MetricEntry): boolean =>
  e.exitCode !== 0 || e.timedOut === true || e.aborted === true || (e.errorCount ?? 0) > 0

const zeroTokens = (): TokenTotals => ({ input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 })

const addUsage = (tokens: TokenTotals, usage: CodexUsage): void => {
  tokens.input += usage.inputTokens
  tokens.cachedInput += usage.cachedInputTokens
  tokens.output += usage.outputTokens
  tokens.reasoningOutput += usage.reasoningOutputTokens
}

const roundUsd = (n: number): number => Number(n.toFixed(COST_DECIMALS))

/** Fold one entry into the per-model breakdown; returns the entry's cost estimate (if priceable). */
const applyModelEntry = (
  byModel: Record<string, ModelAggregate>,
  e: MetricEntry,
  costTable: Readonly<Record<string, ModelCostRates>>,
): number | undefined => {
  if (!e.model) return undefined
  const bucket = byModel[e.model] ?? { runs: 0, failed: 0, totalDurationMs: 0, tokens: zeroTokens() }
  bucket.runs++
  bucket.totalDurationMs += e.durationMs
  if (isFailedEntry(e)) bucket.failed++
  if (e.usage) addUsage(bucket.tokens, e.usage)
  const cost = estimateCostUsd(e.model, e.usage, costTable)
  if (cost !== undefined) bucket.estimatedCostUsd = roundUsd((bucket.estimatedCostUsd ?? 0) + cost)
  byModel[e.model] = bucket
  return cost
}

/** Running mean over optional per-entry samples; `value()` is undefined when no entry had one. */
const createMeanTracker = (): { add: (sample: number | undefined) => void; value: () => number | undefined } => {
  let sum = 0
  let count = 0
  return {
    add: (sample) => {
      if (typeof sample !== 'number') return
      sum += sample
      count += 1
    },
    value: () => (count > 0 ? Math.round(sum / count) : undefined),
  }
}

const flatCostUsd = (tokens: TokenTotals, pricing: PricingTable): number =>
  roundUsd(
    subsetAwareCostUsd(
      tokens.input,
      tokens.cachedInput,
      tokens.output,
      tokens.reasoningOutput,
      pricing,
    ),
  )

/** Roll up filtered entries. When `pricing` is set, includes an estCostUsd. */
export const aggregate = (
  entries: readonly MetricEntry[],
  filters: AggregateFilters = {},
  pricing?: PricingTable,
  costTable: Readonly<Record<string, ModelCostRates>> = COST_TABLE,
): Aggregate => {
  const agg: Aggregate = {
    totalRuns: 0,
    totalDurationMs: 0,
    totalTokens: zeroTokens(),
    byTool: {},
    byModel: {},
    failed: 0,
  }
  const queueMean = createMeanTracker()
  const firstProgressMean = createMeanTracker()
  let costSum: number | undefined
  for (const e of entries) {
    if (!inRange(e, filters)) continue
    agg.totalRuns++
    agg.totalDurationMs += e.durationMs
    if (isFailedEntry(e)) agg.failed++
    if (e.usage) addUsage(agg.totalTokens, e.usage)
    const bucket = agg.byTool[e.tool] ?? { runs: 0, totalDurationMs: 0 }
    bucket.runs++
    bucket.totalDurationMs += e.durationMs
    agg.byTool[e.tool] = bucket
    queueMean.add(e.queueMs)
    firstProgressMean.add(e.timeToFirstProgressMs)
    const cost = applyModelEntry(agg.byModel, e, costTable)
    if (cost !== undefined) costSum = (costSum ?? 0) + cost
  }
  agg.avgQueueMs = queueMean.value()
  agg.avgTimeToFirstProgressMs = firstProgressMean.value()
  if (costSum !== undefined) agg.estimatedCostUsd = roundUsd(costSum)
  if (pricing) agg.estCostUsd = flatCostUsd(agg.totalTokens, pricing)
  return agg
}
