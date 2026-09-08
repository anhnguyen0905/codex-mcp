import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelSource } from './modelSource.js'
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
  /**
   * Head of the first Codex-emitted error message (capped at MAX_ERROR_MESSAGE_CHARS) so failures can
   * be classified offline (quota vs sandbox vs model). Absent on successes / legacy lines.
   */
  errorMessage?: string
  /** Server-generated UUID for this run, matching the tool result payload. Absent on legacy lines. */
  runId?: string
  /** Model requested for the run (via --model). Absent when the CLI default was used / legacy lines. */
  model?: string
  /**
   * Provenance of `model` (T6): 'event' as reported by the run, 'override' as requested by this
   * server, 'config' as read from ~/.codex/config.toml. Absent whenever `model` is absent.
   */
  modelSource?: ModelSource
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

/**
 * How many of a model bucket's runs attributed the model to each provenance (T6 `modelSource`).
 * Makes a config-inferred attribution visible instead of indistinguishable from a reported one.
 */
export interface ModelSourceCounts {
  event: number
  override: number
  config: number
}

/** Per-model roll-up inside an Aggregate. */
export interface ModelAggregate {
  runs: number
  failed: number
  totalDurationMs: number
  tokens: TokenTotals
  /** Sum of per-run COST_TABLE estimates. Absent when the model has no rates. */
  estimatedCostUsd?: number
  /**
   * Provenance breakdown of this bucket's runs. Absent when no entry in the bucket recorded a
   * `modelSource` (legacy logs), so an existing payload is unchanged until provenance exists.
   */
  sources?: ModelSourceCounts
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
/** Cap on the recorded error-message head — enough to classify, not enough to leak a whole log. */
export const MAX_ERROR_MESSAGE_CHARS = 200

/** Truncate an error message to the recorded head; undefined when there is none. */
export const errorMessageHead = (messages: readonly string[]): string | undefined => {
  const first = messages.find((message) => message.trim().length > 0)
  if (first === undefined) return undefined
  return first.length > MAX_ERROR_MESSAGE_CHARS ? first.slice(0, MAX_ERROR_MESSAGE_CHARS) : first
}

/**
 * Under a test runner (VITEST set) with no explicit destination, refuse to write: a fake run must
 * never land in the operator's real ~/.codex-mcp/metrics.jsonl. An env override or an explicit
 * logPath is an opt-in and always honored. In this repo's own suite `tests/setup.ts` already
 * redirects the env var per worker, so this guard is the second line of defence for a test file
 * that clears the env, and for downstream projects that import the server in their tests.
 */
export const isMetricsWriteSuppressed = (
  env: NodeJS.ProcessEnv,
  explicitLogPath: string | undefined,
): boolean =>
  explicitLogPath === undefined && env.CODEX_MCP_METRICS_LOG === undefined && env.VITEST !== undefined

/** Location of the metrics log, honoring CODEX_MCP_METRICS_LOG env, else ~/.codex-mcp/metrics.jsonl. */
export const defaultLogPath = (): string =>
  process.env.CODEX_MCP_METRICS_LOG ?? join(homedir(), '.codex-mcp', 'metrics.jsonl')

/**
 * Shape rules for one JSONL metric line, mirroring `isMetricEntry` in `scripts/session-cost.mjs`.
 * The script is stdlib-only and cannot import from `dist/`, so the two predicate lists are kept
 * literally parallel: any rule added here must be added there in the same order.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isParseableDate = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const MODEL_SOURCES: readonly ModelSource[] = ['event', 'override', 'config']

// A model name from the log becomes an aggregation key. These three would target
// Object.prototype in any plain-object bucket store, so reject the line outright rather
// than rely on every consumer using a Map. Mirrored in scripts/session-cost.mjs.
const UNSAFE_KEY_NAMES: readonly string[] = ['__proto__', 'constructor', 'prototype']

const isSafeModelName = (value: unknown): value is string =>
  isNonEmptyString(value) && !UNSAFE_KEY_NAMES.includes(value)

const hasValidUsage = (usage: unknown): boolean =>
  usage === null ||
  (isRecord(usage) &&
    isFiniteNonNegative(usage.inputTokens) &&
    isFiniteNonNegative(usage.cachedInputTokens) &&
    isFiniteNonNegative(usage.outputTokens) &&
    isFiniteNonNegative(usage.reasoningOutputTokens))

/** True when an untrusted parsed JSONL value is a usable metric entry. Same rules as session-cost. */
export const isValidMetricEntry = (entry: unknown): entry is MetricEntry =>
  isRecord(entry) &&
  isParseableDate(entry.ts) &&
  isNonEmptyString(entry.tool) &&
  typeof entry.cwd === 'string' &&
  (entry.exitCode === null || Number.isInteger(entry.exitCode)) &&
  isFiniteNonNegative(entry.durationMs) &&
  hasValidUsage(entry.usage) &&
  (entry.model === undefined || isSafeModelName(entry.model)) &&
  (entry.modelSource === undefined || MODEL_SOURCES.includes(entry.modelSource as ModelSource)) &&
  (entry.errorKind === undefined || typeof entry.errorKind === 'string') &&
  (entry.errorCount === undefined || isFiniteNonNegative(entry.errorCount)) &&
  (entry.timedOut === undefined || typeof entry.timedOut === 'boolean') &&
  (entry.aborted === undefined || typeof entry.aborted === 'boolean')

const PRICING_KEYS: readonly (keyof PricingTable)[] = [
  'inputPer1M',
  'cachedInputPer1M',
  'outputPer1M',
  'reasoningOutputPer1M',
]

/**
 * Parse the opt-in pricing table from CODEX_MCP_PRICING (JSON). Malformed → undefined, no throw.
 * A rate must be a finite non-negative number: negative, NaN and infinite rates are rejected
 * rather than silently producing a nonsense cost (R7.2).
 */
export const parsePricing = (raw: string | undefined): PricingTable | undefined => {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    if (!PRICING_KEYS.every((key) => isFiniteNonNegative(parsed[key]))) return undefined
    return {
      inputPer1M: parsed.inputPer1M as number,
      cachedInputPer1M: parsed.cachedInputPer1M as number,
      outputPer1M: parsed.outputPer1M as number,
      reasoningOutputPer1M: parsed.reasoningOutputPer1M as number,
    }
  } catch {
    return undefined
  }
}

/**
 * Append one entry. Rotates the file first if it's past `maxBytes`. Errors are swallowed.
 * Returns true when a line was written, false when suppressed or the write failed.
 */
export const appendMetric = (entry: MetricEntry, options: MetricsLogOptions = {}): boolean => {
  if (isMetricsWriteSuppressed(process.env, options.logPath)) return false
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
    return true
  } catch {
    // best-effort — metrics logging must never fail a real run.
    return false
  }
}

/**
 * One-line notice emitted when a rotated back-file exists: rotation keeps exactly one, so anything
 * older than it has already been discarded and no report can account for it (R7.3).
 */
export const ROTATION_NOTICE = 'metrics: history older than one rotation is not retained'

/** Entries plus the read diagnostics a report needs to disclose what it could not account for. */
export interface MetricsDiagnostics {
  entries: MetricEntry[]
  /** Lines skipped for invalid JSON or an invalid metric shape, across both files. */
  invalidLines: number
  /** Present only when the `<file>.1` rotation file exists. */
  rotationNotice?: typeof ROTATION_NOTICE
  /**
   * One message per file that exists but could not be read (EACCES, EISDIR, …), rotated file
   * first. A missing file is normal and never listed. Absent when every read succeeded, so a
   * healthy payload is unchanged.
   */
  readErrors?: string[]
}

interface FileReadResult {
  entries: MetricEntry[]
  invalidLines: number
  /** Set when the file exists but could not be read; the entries are then unknown, not empty. */
  readError?: string
}

/**
 * Message for a failed metrics-log read, or undefined for a missing file (normal). Must stay
 * byte-identical to `readFailureMessage` in scripts/session-cost.mjs.
 */
const readFailureMessage = (path: string, error: unknown): string | undefined => {
  if (isRecord(error) && error.code === 'ENOENT') return undefined
  const detail = error instanceof Error ? error.message : 'unknown filesystem error'
  return `unable to read metrics log ${path}: ${detail}`
}

/**
 * Parse one file's JSONL content, skipping lines with invalid JSON or an invalid metric shape and
 * counting them. A missing file yields no entries; a file that exists but cannot be read yields a
 * `readError` so the caller can disclose the gap rather than report an empty log (R7.2).
 */
const readMetricsFile = (path: string): FileReadResult => {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    const readError = readFailureMessage(path, error)
    return readError === undefined
      ? { entries: [], invalidLines: 0 }
      : { entries: [], invalidLines: 0, readError }
  }
  const entries: MetricEntry[] = []
  let invalidLines = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      invalidLines += 1
      continue
    }
    if (!isValidMetricEntry(parsed)) {
      invalidLines += 1
      continue
    }
    entries.push(parsed)
  }
  return { entries, invalidLines }
}

/**
 * Read metric entries plus diagnostics from the log and its rotated back-file (`<file>.1`),
 * oldest first. Rotation keeps exactly one back-file (see appendMetric), so its presence means
 * older history is already gone — reported as `rotationNotice`.
 */
export const readMetricsDetailed = (options: MetricsLogOptions = {}): MetricsDiagnostics => {
  const logPath = options.logPath ?? defaultLogPath()
  const rotatedPath = `${logPath}.1`
  const rotated = readMetricsFile(rotatedPath)
  const live = readMetricsFile(logPath)
  const readErrors = [rotated.readError, live.readError].filter(
    (message): message is string => message !== undefined,
  )
  const base: MetricsDiagnostics = {
    entries: [...rotated.entries, ...live.entries],
    invalidLines: rotated.invalidLines + live.invalidLines,
  }
  const diagnostics = readErrors.length > 0 ? { ...base, readErrors } : base
  return existsSync(rotatedPath) ? { ...diagnostics, rotationNotice: ROTATION_NOTICE } : diagnostics
}

/**
 * Read metric entries from the log plus its rotated back-file (`<file>.1`), oldest first.
 * Kept as an entries array for existing callers; use `readMetricsDetailed` for diagnostics.
 */
export const readMetrics = (options: MetricsLogOptions = {}): MetricEntry[] =>
  readMetricsDetailed(options).entries

const inRange = (entry: MetricEntry, filters: AggregateFilters): boolean => {
  if (filters.since && entry.ts < filters.since) return false
  if (filters.until && entry.ts > filters.until) return false
  if (filters.tool && entry.tool !== filters.tool) return false
  if (filters.cwd && entry.cwd !== filters.cwd) return false
  if (filters.sessionId && entry.sessionId !== filters.sessionId) return false
  return true
}

/**
 * Failure = process-level failure OR Codex-emitted errors (turn.failed etc.) despite exit 0.
 * `errorCount` and `errorKind` are absent on legacy lines — treated as "no error" so old logs
 * aggregate unchanged. A recorded `errorKind` alone counts as a failure: a run classified as
 * 'timeout'/'abort'/'turn-failed' is a failure even if the counter never made it to the line.
 * Must stay equivalent to `isFailedEntry` in scripts/session-cost.mjs (parity-tested).
 */
export const isFailedEntry = (e: MetricEntry): boolean =>
  e.exitCode !== 0 ||
  e.timedOut === true ||
  e.aborted === true ||
  (e.errorCount ?? 0) > 0 ||
  (typeof e.errorKind === 'string' && e.errorKind.length > 0)

const zeroTokens = (): TokenTotals => ({ input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 })

/** Starting point for a bucket's provenance counts; never mutated (spread into a new object). */
const ZERO_MODEL_SOURCES: Readonly<ModelSourceCounts> = { event: 0, override: 0, config: 0 }

const addUsage = (tokens: TokenTotals, usage: CodexUsage): void => {
  tokens.input += usage.inputTokens
  tokens.cachedInput += usage.cachedInputTokens
  tokens.output += usage.outputTokens
  tokens.reasoningOutput += usage.reasoningOutputTokens
}

const roundUsd = (n: number): number => Number(n.toFixed(COST_DECIMALS))

/**
 * Fold one entry into the per-model breakdown; returns the entry's cost estimate (if priceable).
 * The bucket store is a Map, never a plain object: model names come from the log file, so an
 * attacker-supplied `__proto__` would otherwise resolve to Object.prototype and pollute it.
 */
const applyModelEntry = (
  byModel: Map<string, ModelAggregate>,
  e: MetricEntry,
  costTable: Readonly<Record<string, ModelCostRates>>,
): number | undefined => {
  if (!e.model) return undefined
  const bucket = byModel.get(e.model) ?? {
    runs: 0,
    failed: 0,
    totalDurationMs: 0,
    tokens: zeroTokens(),
  }
  bucket.runs++
  bucket.totalDurationMs += e.durationMs
  if (isFailedEntry(e)) bucket.failed++
  if (e.usage) addUsage(bucket.tokens, e.usage)
  if (e.modelSource !== undefined) {
    const sources = bucket.sources ?? ZERO_MODEL_SOURCES
    bucket.sources = { ...sources, [e.modelSource]: sources[e.modelSource] + 1 }
  }
  const cost = estimateCostUsd(e.model, e.usage, costTable)
  if (cost !== undefined) bucket.estimatedCostUsd = roundUsd((bucket.estimatedCostUsd ?? 0) + cost)
  byModel.set(e.model, bucket)
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
  // Tool and model names are untrusted log content: accumulate in Maps so a `__proto__`
  // key cannot resolve to Object.prototype, then materialize the records via
  // Object.fromEntries, which defines own properties instead of assigning through setters.
  const byTool = new Map<string, { runs: number; totalDurationMs: number }>()
  const byModel = new Map<string, ModelAggregate>()
  const queueMean = createMeanTracker()
  const firstProgressMean = createMeanTracker()
  let costSum: number | undefined
  for (const e of entries) {
    if (!inRange(e, filters)) continue
    agg.totalRuns++
    agg.totalDurationMs += e.durationMs
    if (isFailedEntry(e)) agg.failed++
    if (e.usage) addUsage(agg.totalTokens, e.usage)
    const bucket = byTool.get(e.tool) ?? { runs: 0, totalDurationMs: 0 }
    bucket.runs++
    bucket.totalDurationMs += e.durationMs
    byTool.set(e.tool, bucket)
    queueMean.add(e.queueMs)
    firstProgressMean.add(e.timeToFirstProgressMs)
    const cost = applyModelEntry(byModel, e, costTable)
    if (cost !== undefined) costSum = (costSum ?? 0) + cost
  }
  agg.byTool = Object.fromEntries(byTool)
  agg.byModel = Object.fromEntries(byModel)
  agg.avgQueueMs = queueMean.value()
  agg.avgTimeToFirstProgressMs = firstProgressMean.value()
  if (costSum !== undefined) agg.estimatedCostUsd = roundUsd(costSum)
  if (pricing) agg.estCostUsd = flatCostUsd(agg.totalTokens, pricing)
  return agg
}
