import type { Dirent } from 'node:fs'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelSource } from './modelSource.js'
import type { CodexUsage } from './types.js'
import { defaultLocksDir } from './workspaceLease.js'

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

/**
 * What the roll-up could NOT account for (R6.3). A report renders this so an operator never
 * mistakes a partial cost for the real one. Every counter is over the FILTERED entries.
 */
export interface Completeness {
  /** True only when every counter is 0 and no history was excluded. */
  complete: boolean
  /** Entries that recorded usage but whose model has no rates (or no model at all). */
  unpricedRuns: number
  /** Entries written with `usage: null` (the run reported no token counts). */
  missingUsage: number
  /** Files that existed but could not be read (`MetricsDiagnostics.readErrors.length`). */
  readErrors: number
  /** True when archived history files exist and were not included in the read. */
  historyExcluded: boolean
}

/** Read-side facts `aggregate` cannot derive from the entries alone. Absent fields mean "none". */
export interface AggregateDiagnostics {
  /** Number of unreadable files, i.e. `MetricsDiagnostics.readErrors?.length ?? 0`. */
  readErrors?: number
  /** `MetricsDiagnostics.historyExcluded`. */
  historyExcluded?: boolean
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
  /** What this roll-up could not account for (R6.3). Always present. */
  completeness: Completeness
}

/** Rename used by rotation; injectable so a crash between the two steps can be tested. */
export type RenameFn = (from: string, to: string) => void

export interface FileLockOptions {
  /** Age at which a lock file counts as abandoned and may be broken. Default 5 s. */
  staleMs?: number
  /** Poll interval while a live holder keeps the lock. Default 25 ms. */
  retryMs?: number
}

export interface RotateOptions {
  /** Only rotate when the log is at least this many bytes. Default 0 (rotate whenever it exists). */
  maxBytes?: number
  /** Override the locks dir holding `metrics.lock` (mostly for tests). */
  locksDir?: string
  /** Injected rename; defaults to fs.renameSync. Used by tests to fail one of the two steps. */
  rename?: RenameFn
  /** Lock tuning; see `withFileLock`. */
  lock?: FileLockOptions
}

export interface MetricsLogOptions extends RotateOptions {
  /** Override the default ~/.codex-mcp/metrics.jsonl (mostly for tests). */
  logPath?: string
  /** Cap on log file size; on next append past this, rotate to `<file>.1` and truncate. Default 10MB. */
  maxBytes?: number
  /** Read side only: also read the archived `history/*.jsonl` files (R6.2). Default false. */
  includeHistory?: boolean
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

/** Directory (next to the log) holding every archived back-file. Nothing is ever deleted (R6.1). */
export const HISTORY_DIR_NAME = 'history'
/** Lock file serializing rotation across processes, inside the server's existing locks dir. */
export const METRICS_LOCK_FILE_NAME = 'metrics.lock'
/** A lock file older than this is treated as abandoned (holder crashed) and may be broken. */
export const LOCK_STALE_MS = 5_000
const LOCK_RETRY_MS = 25
const LOCK_FILE_MODE = 0o600
const LOCKS_DIR_MODE = 0o700
const HISTORY_DIR_MODE = 0o700
const LOG_FILE_MODE = 0o600
/** Guard against an unbounded collision-suffix scan on a corrupted history dir. */
const MAX_ARCHIVE_COLLISIONS = 1_000

/** Archive dir for a log: `<log dir>/history`. */
export const historyDirFor = (logPath: string): string => join(dirname(logPath), HISTORY_DIR_NAME)

const isErrnoCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code

/** Best-effort unlink; an already-removed file is not an error. */
const removeFileIfPresent = (path: string): void => {
  try {
    unlinkSync(path)
  } catch (error: unknown) {
    if (!isErrnoCode(error, 'ENOENT')) throw error
  }
}

/**
 * Synchronous wait. `appendMetric` is synchronous by contract (callers log inline at the end of a
 * run), so there is no event-loop turn to await on while another process holds the lock.
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** O_EXCL create; false only on EEXIST (someone else holds the lock). */
const tryCreateLock = (lockPath: string): boolean => {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: LOCK_FILE_MODE })
    return true
  } catch (error: unknown) {
    if (isErrnoCode(error, 'EEXIST')) return false
    throw error
  }
}

/**
 * True when the process that wrote the lock is still running. `process.kill(pid, 0)` sends no
 * signal: it throws ESRCH when the pid is gone and EPERM when the process exists but belongs to
 * another user — EPERM therefore counts as alive.
 */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return isErrnoCode(error, 'EPERM')
  }
}

/** Holder pid recorded by `tryCreateLock`, or null when the content is absent or malformed. */
const readLockHolderPid = (lockPath: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * True when the lock may be broken: the file vanished between our two syscalls, or its mtime is
 * older than `staleMs` AND its recorded holder is no longer alive. Age alone is not evidence of a
 * crash — nothing refreshes the lock mtime, so a slow but live rotation would otherwise be
 * unlinked and two processes would archive concurrently. Lock content with no parseable pid has no
 * holder to check, so for it the age test decides alone (it can only come from a crashed or
 * foreign writer).
 */
const isStaleLock = (lockPath: string, staleMs: number): boolean => {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < staleMs) return false
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return true
    throw error
  }
  const pid = readLockHolderPid(lockPath)
  if (pid === null) return true
  return !isPidAlive(pid)
}

/**
 * Run `fn` while holding an exclusive lock file (O_EXCL create, released in a `finally`). A lock
 * is broken once only when it is both older than `staleMs` and its holder pid is dead, so a
 * crashed holder cannot wedge rotation forever while a live one keeps its exclusivity however
 * slow it is. A live holder is waited on, then given up on with a throw after twice the stale
 * window rather than overlapping its rotation.
 */
export const withFileLock = <T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T => {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  mkdirSync(dirname(lockPath), { recursive: true, mode: LOCKS_DIR_MODE })
  const deadline = Date.now() + staleMs * 2
  for (;;) {
    if (tryCreateLock(lockPath)) break
    if (isStaleLock(lockPath, staleMs)) {
      removeFileIfPresent(lockPath)
      if (tryCreateLock(lockPath)) break
    }
    if (Date.now() >= deadline) {
      throw new Error(`lock ${lockPath} is held by another process; gave up after ${staleMs * 2} ms`)
    }
    sleepSync(retryMs)
  }
  try {
    return fn()
  } finally {
    removeFileIfPresent(lockPath)
  }
}

/** `YYYYMMDD-HHMMSS` in UTC, the archive-name stamp of a back-file's last entry (R6.1). */
export const formatArchiveStamp = (isoTs: string): string => {
  const parsed = Date.parse(isoTs)
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`unparseable timestamp for a metrics archive name: ${isoTs}`)
  }
  const iso = new Date(parsed).toISOString()
  const date = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
  return `${date}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

/**
 * Stamp for the back-file being archived: its last valid entry's `ts`. A file with no readable
 * entry still gets archived (nothing is ever deleted), stamped from its mtime so it keeps sorting
 * by age.
 */
const archiveStampFor = (backFilePath: string): string => {
  const last = readMetricsFile(backFilePath).entries.at(-1)
  if (last !== undefined) return formatArchiveStamp(last.ts)
  try {
    return formatArchiveStamp(statSync(backFilePath).mtime.toISOString())
  } catch {
    // Unstattable but present (raced away, EACCES): a current stamp still orders it last.
    return formatArchiveStamp(new Date().toISOString())
  }
}

/** `metrics-<stamp>.jsonl`, or `-2`, `-3`, … when that name is taken (R6.1). */
const archivePathFor = (historyDir: string, stamp: string): string => {
  const base = join(historyDir, `metrics-${stamp}.jsonl`)
  if (!existsSync(base)) return base
  for (let suffix = 2; suffix <= MAX_ARCHIVE_COLLISIONS; suffix += 1) {
    const candidate = join(historyDir, `metrics-${stamp}-${suffix}.jsonl`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`too many metrics archives stamped ${stamp} in ${historyDir}`)
}

/** True when the log exists and is at least `maxBytes`. A missing log is never rotated. */
const isPastCap = (logPath: string, maxBytes: number): boolean => {
  try {
    return statSync(logPath).size >= maxBytes
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return false
    throw error
  }
}

/**
 * Two renames, in this order: archive the previous back-file into `history/`, THEN move the
 * current log onto `<log>.1`. A crash in between leaves no `.1`, which the next call detects and
 * skips straight to the second rename — so no line is ever lost or overwritten.
 */
const rotateLocked = (logPath: string, maxBytes: number, rename: RenameFn): void => {
  // Re-checked under the lock: a process we queued behind may have rotated already.
  if (!isPastCap(logPath, maxBytes)) return
  const rotatedPath = `${logPath}.1`
  if (existsSync(rotatedPath)) {
    const historyDir = historyDirFor(logPath)
    mkdirSync(historyDir, { recursive: true, mode: HISTORY_DIR_MODE })
    rename(rotatedPath, archivePathFor(historyDir, archiveStampFor(rotatedPath)))
  }
  rename(logPath, rotatedPath)
}

/** Rotate the log under the cross-process metrics lock. Throws on a filesystem failure. */
export const rotateMetricsLog = (logPath: string, options: RotateOptions = {}): void => {
  const lockPath = join(options.locksDir ?? defaultLocksDir(), METRICS_LOCK_FILE_NAME)
  const maxBytes = options.maxBytes ?? 0
  const rename = options.rename ?? renameSync
  withFileLock(lockPath, () => rotateLocked(logPath, maxBytes, rename), options.lock)
}

/**
 * Rotate before appending when the log is past its cap. A rotation failure is contained here on
 * purpose: it must never cost the caller's line, so the entry is appended to the current
 * (oversized) log and the next append retries rotation from whatever state is on disk.
 */
const rotateBeforeAppend = (logPath: string, maxBytes: number, options: MetricsLogOptions): void => {
  if (!isPastCap(logPath, maxBytes)) return
  try {
    rotateMetricsLog(logPath, {
      maxBytes,
      locksDir: options.locksDir,
      rename: options.rename,
      lock: options.lock,
    })
  } catch {
    // Contained by design — see the doc comment above.
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
    rotateBeforeAppend(logPath, maxBytes, options)
    appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: LOG_FILE_MODE })
    return true
  } catch {
    // best-effort — metrics logging must never fail a real run.
    return false
  }
}

/**
 * Literal shape of the one-line notice emitted when archived history exists, kept quotable for
 * the `scripts/session-cost.mjs` mirror. `<dir>` is the absolute history dir, `<n>` its file
 * count; the word `files` never changes, singular included.
 */
export const ROTATION_NOTICE_TEMPLATE =
  'metrics: history older than one rotation is in <dir> (<n> files)'

/** The notice for a concrete history dir. Must stay byte-identical to the session-cost mirror. */
export const rotationNoticeFor = (historyDir: string, historyFiles: number): string =>
  `metrics: history older than one rotation is in ${historyDir} (${historyFiles} files)`

/** Entries plus the read diagnostics a report needs to disclose what it could not account for. */
export interface MetricsDiagnostics {
  entries: MetricEntry[]
  /** Lines skipped for invalid JSON or an invalid metric shape, across every file read. */
  invalidLines: number
  /** Present only when at least one archived history file exists; see `rotationNoticeFor`. */
  rotationNotice?: string
  /**
   * One message per file that exists but could not be read (EACCES, EISDIR, …), history files
   * first (oldest first), then the rotated file, then the live log. A missing file is normal and
   * never listed. Absent when every read succeeded, so a healthy payload is unchanged.
   */
  readErrors?: string[]
  /** Number of `history/*.jsonl` archives on disk; 0 when the dir is absent (R6.2). */
  historyFiles: number
  /** True when archives exist and were NOT read because `includeHistory` was not set. */
  historyExcluded: boolean
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

/** Archived history files, oldest first (names are timestamp-sorted), plus a listing failure. */
interface HistoryListing {
  files: string[]
  /** Set when the dir exists but could not be listed; the archives are then unknown, not absent. */
  readError?: string
}

/**
 * IMP-44: only regular files are archives. A `.jsonl` directory (or socket, fifo, …) would make
 * `readMetricsFile` report an EISDIR read error and inflate `historyFiles`, so it is skipped at
 * listing time. A symlink is skipped too, never followed: an archive must live in `history/`, so a
 * link is a way to pull foreign entries into the totals. Only an entry whose `d_type` the platform
 * could not report is resolved with `lstat` (which still rejects links); any stat failure skips it.
 */
const isRegularHistoryFile = (historyDir: string, entry: Dirent): boolean => {
  if (entry.isFile()) return true
  if (entry.isSymbolicLink() || entry.isDirectory()) return false
  try {
    return lstatSync(join(historyDir, entry.name)).isFile()
  } catch {
    return false
  }
}

/**
 * List `<log dir>/history/*.jsonl`, sorted by name (oldest first, since names are UTC stamps).
 * A missing dir is normal. Mirrored by `listHistoryFiles` in scripts/session-cost.mjs.
 */
const listHistoryFiles = (historyDir: string): HistoryListing => {
  try {
    const names = readdirSync(historyDir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.jsonl') && isRegularHistoryFile(historyDir, entry))
      .map((entry) => entry.name)
      .sort()
    return { files: names.map((name) => join(historyDir, name)) }
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return { files: [] }
    const detail = error instanceof Error ? error.message : 'unknown filesystem error'
    return { files: [], readError: `unable to read metrics history dir ${historyDir}: ${detail}` }
  }
}

/**
 * Read metric entries plus diagnostics, oldest first: archived `history/*.jsonl` (only with
 * `includeHistory`), then the rotated back-file (`<file>.1`), then the live log. Rotation archives
 * instead of discarding (R6.1), so archives that exist but were skipped are disclosed via
 * `historyExcluded` and `rotationNotice` rather than silently dropped from the totals.
 */
export const readMetricsDetailed = (options: MetricsLogOptions = {}): MetricsDiagnostics => {
  const logPath = options.logPath ?? defaultLogPath()
  const historyDir = historyDirFor(logPath)
  const history = listHistoryFiles(historyDir)
  const includeHistory = options.includeHistory === true
  const results: FileReadResult[] = [
    ...(includeHistory ? history.files.map(readMetricsFile) : []),
    readMetricsFile(`${logPath}.1`),
    readMetricsFile(logPath),
  ]
  const readErrors = [history.readError, ...results.map((result) => result.readError)].filter(
    (message): message is string => message !== undefined,
  )
  const base: MetricsDiagnostics = {
    entries: results.flatMap((result) => result.entries),
    invalidLines: results.reduce((sum, result) => sum + result.invalidLines, 0),
    historyFiles: history.files.length,
    historyExcluded: history.files.length > 0 && !includeHistory,
  }
  const diagnostics = readErrors.length > 0 ? { ...base, readErrors } : base
  return history.files.length > 0
    ? { ...diagnostics, rotationNotice: rotationNoticeFor(historyDir, history.files.length) }
    : diagnostics
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

/** Counters for what a roll-up could not account for; folded into `Aggregate.completeness`. */
interface CompletenessCounters {
  unpricedRuns: number
  missingUsage: number
}

const completenessOf = (
  counters: CompletenessCounters,
  diagnostics: AggregateDiagnostics,
): Completeness => {
  const readErrors = diagnostics.readErrors ?? 0
  const historyExcluded = diagnostics.historyExcluded === true
  return {
    complete:
      counters.unpricedRuns === 0 &&
      counters.missingUsage === 0 &&
      readErrors === 0 &&
      !historyExcluded,
    unpricedRuns: counters.unpricedRuns,
    missingUsage: counters.missingUsage,
    readErrors,
    historyExcluded,
  }
}

/**
 * Roll up filtered entries. When `pricing` is set, includes an estCostUsd. `diagnostics` carries
 * the read-side facts (`readErrors` count, `historyExcluded`) that only the reader knows, so the
 * returned `completeness` can say whether the numbers account for everything (R6.3).
 */
export const aggregate = (
  entries: readonly MetricEntry[],
  filters: AggregateFilters = {},
  pricing?: PricingTable,
  costTable: Readonly<Record<string, ModelCostRates>> = COST_TABLE,
  diagnostics: AggregateDiagnostics = {},
): Aggregate => {
  const agg: Aggregate = {
    totalRuns: 0,
    totalDurationMs: 0,
    totalTokens: zeroTokens(),
    byTool: {},
    byModel: {},
    failed: 0,
    completeness: completenessOf({ unpricedRuns: 0, missingUsage: 0 }, diagnostics),
  }
  // Tool and model names are untrusted log content: accumulate in Maps so a `__proto__`
  // key cannot resolve to Object.prototype, then materialize the records via
  // Object.fromEntries, which defines own properties instead of assigning through setters.
  const byTool = new Map<string, { runs: number; totalDurationMs: number }>()
  const byModel = new Map<string, ModelAggregate>()
  const queueMean = createMeanTracker()
  const firstProgressMean = createMeanTracker()
  let costSum: number | undefined
  const counters: CompletenessCounters = { unpricedRuns: 0, missingUsage: 0 }
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
    // A run either reported no usage at all, or reported usage no rate could price.
    if (!e.usage) counters.missingUsage += 1
    else if (cost === undefined) counters.unpricedRuns += 1
  }
  agg.completeness = completenessOf(counters, diagnostics)
  agg.byTool = Object.fromEntries(byTool)
  agg.byModel = Object.fromEntries(byModel)
  agg.avgQueueMs = queueMean.value()
  agg.avgTimeToFirstProgressMs = firstProgressMean.value()
  if (costSum !== undefined) agg.estimatedCostUsd = roundUsd(costSum)
  if (pricing) agg.estCostUsd = flatCostUsd(agg.totalTokens, pricing)
  return agg
}
