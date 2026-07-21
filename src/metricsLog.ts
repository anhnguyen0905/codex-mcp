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

export interface Aggregate {
  totalRuns: number
  totalDurationMs: number
  totalTokens: {
    input: number
    cachedInput: number
    output: number
    reasoningOutput: number
  }
  byTool: Record<string, { runs: number; totalDurationMs: number }>
  failed: number
  estCostUsd?: number // populated only when a pricing table is supplied
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

/** Roll up filtered entries. When `pricing` is set, includes an estCostUsd. */
export const aggregate = (
  entries: readonly MetricEntry[],
  filters: AggregateFilters = {},
  pricing?: PricingTable,
): Aggregate => {
  const agg: Aggregate = {
    totalRuns: 0,
    totalDurationMs: 0,
    totalTokens: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 },
    byTool: {},
    failed: 0,
  }
  for (const e of entries) {
    if (!inRange(e, filters)) continue
    agg.totalRuns++
    agg.totalDurationMs += e.durationMs
    // Failure = process-level failure OR Codex-emitted errors (turn.failed etc.) despite exit 0.
    // `errorCount` is absent on legacy lines — treat as 0 so old logs aggregate unchanged.
    if (e.exitCode !== 0 || e.timedOut || e.aborted || (e.errorCount ?? 0) > 0) agg.failed++
    if (e.usage) {
      agg.totalTokens.input += e.usage.inputTokens
      agg.totalTokens.cachedInput += e.usage.cachedInputTokens
      agg.totalTokens.output += e.usage.outputTokens
      agg.totalTokens.reasoningOutput += e.usage.reasoningOutputTokens
    }
    const bucket = agg.byTool[e.tool] ?? { runs: 0, totalDurationMs: 0 }
    bucket.runs++
    bucket.totalDurationMs += e.durationMs
    agg.byTool[e.tool] = bucket
  }
  if (pricing) {
    // cachedInput usually priced lower; kept separate from input for accuracy.
    const perMillion = 1_000_000
    agg.estCostUsd = Number(
      (
        (agg.totalTokens.input * pricing.inputPer1M) / perMillion +
        (agg.totalTokens.cachedInput * pricing.cachedInputPer1M) / perMillion +
        (agg.totalTokens.output * pricing.outputPer1M) / perMillion +
        (agg.totalTokens.reasoningOutput * pricing.reasoningOutputPer1M) / perMillion
      ).toFixed(6),
    )
  }
  return agg
}
