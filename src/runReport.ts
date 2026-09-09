import type { RunOptions, RunOutcomeWithEvents } from './codexRunner.js'
import { parseEvents, type ParsedEvents } from './eventParser.js'
import type { LiveView } from './liveView.js'
import { appendMetric, errorMessageHead, type MetricEntry } from './metricsLog.js'
import { resolveModel, type ModelSource } from './modelSource.js'
import { writeNotes, type NotesRequest } from './notesWriter.js'
import { combineSinks, type ProgressNotifier, type ProgressSink } from './progressNotifier.js'
import { redactSecrets } from './redaction.js'
import { deriveRunStatus, isErrorStatus, RESULT_SCHEMA_VERSION } from './runStatus.js'
import { toToolResult, type RunPayload } from './toolPayloads.js'
import {
  attributeWorkspaceDiff,
  captureStatusPorcelainZ,
  captureWorkspaceDiff,
  type AttributeFn,
  type DiffFn,
  type RunAttribution,
  type SnapshotFn,
  type WorkspaceSnapshot,
} from './workspaceDiff.js'

/**
 * Shared "run one Codex invocation and build its result payload + metric entry" pipeline,
 * used by codex_execute / codex_continue / codex_review / codex_batch (extracted from server.ts).
 */

export type RunFn = (args: string[], options: Omit<RunOptions, 'spawnFn'>) => Promise<RunOutcomeWithEvents>

export interface RunAndReportDeps {
  runFn: RunFn
  view: LiveView
  diffFn: DiffFn
  snapshotFn: SnapshotFn
  attributeFn: AttributeFn
  /** Before-run snapshot shared by every attempt in one logical recovery run. */
  presetSnapshot?: WorkspaceSnapshot | null
  /** Server-generated UUID identifying this run in the payload, notes, and metric entry. */
  runId: string
  /** Throttled progress notifier; settled (final flush + timer teardown) when the run finishes. */
  progressNotifier?: ProgressNotifier
  /** Whether runOnce settles and closes its sinks. Defaults true; recovery owns them across attempts. */
  ownsSinks?: boolean
  /** When provided, writeNotes() runs after payload is built (best-effort; errors are logged, not thrown). */
  notes?: Omit<NotesRequest, 'sessionId' | 'parsed' | 'exitCode' | 'runId'>
  /** Which tool invoked runAndReport, so the metric log can attribute the run. */
  tool: MetricEntry['tool']
  /** Model requested for the run (via --model). Absent → resolved from the event stream or config. */
  model?: string
  /** Batch task identity ("task-<index>"), recorded for codex_batch runs. */
  taskId?: string
  /** Time this request spent waiting on the concurrency gate + cwd lock before starting. */
  queueMs?: number
}

export const safeDiff = async (diffFn: DiffFn, cwd: string) => {
  try {
    return await diffFn(cwd)
  } catch {
    return null
  }
}

export const safeSnapshot = async (
  snapshotFn: SnapshotFn,
  cwd: string,
): Promise<WorkspaceSnapshot | null> => {
  try {
    return await snapshotFn(cwd)
  } catch {
    return null
  }
}

const safeAttribute = async (
  attributeFn: AttributeFn,
  cwd: string,
  snapshot: WorkspaceSnapshot | null,
): Promise<RunAttribution | null> => {
  try {
    return await attributeFn(cwd, snapshot)
  } catch {
    return null
  }
}

const capturePostRunWorkspace = async (
  diffFn: DiffFn,
  attributeFn: AttributeFn,
  cwd: string,
  snapshot: WorkspaceSnapshot | null,
): Promise<{
  diff: Awaited<ReturnType<DiffFn>> | null
  attribution: RunAttribution | null
}> => {
  if (diffFn !== captureWorkspaceDiff || attributeFn !== attributeWorkspaceDiff) {
    const [diff, attribution] = await Promise.all([
      safeDiff(diffFn, cwd),
      safeAttribute(attributeFn, cwd, snapshot),
    ])
    return { diff, attribution }
  }

  const statusPorcelainZ = captureStatusPorcelainZ(cwd)
  const [diff, attribution] = await Promise.all([
    safeDiff((workspace) => captureWorkspaceDiff(workspace, { statusPorcelainZ }), cwd),
    safeAttribute(
      (workspace, beforeRun) =>
        attributeWorkspaceDiff(workspace, beforeRun, { statusPorcelainZ }),
      cwd,
      snapshot,
    ),
  ])
  return { diff, attribution }
}

/** Keep the last `n` chars without leaving a dangling low surrogate that would corrupt on encode. */
const tailString = (value: string, n: number): string => {
  if (value.length <= n) return value
  const sliced = value.slice(-n)
  const first = sliced.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced
}

const STDERR_TAIL_CHARS = 2000

/** Free-text run fields after redaction, plus how many secrets were replaced across all of them. */
interface RedactedRunFields {
  parsed: ParsedEvents
  stderr: string
  redactions: number
}

/**
 * Single choke point for the report-side sinks (R5.2): `agentMessage`, `errors[]`,
 * `commands[].command` and `stderr` are redacted here, BEFORE `writeNotesSafe` persists them,
 * before the metric line quotes an error head, and before the payload leaves the server (so
 * `parseReviewFindings` in the codex_review handler only ever sees redacted text). `stderr` is
 * redacted before its tail is taken, so truncation can never expose the unredacted half of a
 * secret. Command strings come straight from `command_execution` events and routinely carry
 * credentials in flags or headers, so they pass the same choke point.
 */
const redactRunFields = (parsed: ParsedEvents, rawStderr: string): RedactedRunFields => {
  const message = parsed.agentMessage === null ? null : redactSecrets(parsed.agentMessage)
  const errors = parsed.errors.map((error) => redactSecrets(error))
  const commands = parsed.commands.map((entry) => ({ entry, redacted: redactSecrets(entry.command) }))
  const stderr = redactSecrets(rawStderr)
  return {
    parsed: {
      ...parsed,
      agentMessage: message === null ? null : message.text,
      errors: errors.map((error) => error.text),
      commands: commands.map(({ entry, redacted }) => ({ ...entry, command: redacted.text })),
    },
    stderr: tailString(stderr.text, STDERR_TAIL_CHARS),
    redactions:
      (message?.redactions ?? 0) +
      errors.reduce((sum, error) => sum + error.redactions, 0) +
      commands.reduce((sum, { redacted }) => sum + redacted.redactions, 0) +
      stderr.redactions,
  }
}

/**
 * Classify a run's primary failure kind for the metric log, by precedence:
 * abort > timeout > non-zero exit > Codex-emitted errors (turn.failed). Undefined on success.
 */
const deriveErrorKind = (
  outcome: { exitCode: number | null; timedOut: boolean },
  aborted: boolean,
  errorCount: number,
): MetricEntry['errorKind'] => {
  if (aborted) return 'abort'
  if (outcome.timedOut) return 'timeout'
  if (outcome.exitCode !== 0) return 'exit'
  if (errorCount > 0) return 'turn-failed'
  return undefined
}

/** Best-effort notes write: a broken notes write must never fail the actual run. */
const writeNotesSafe = (
  notes: Omit<NotesRequest, 'sessionId' | 'parsed' | 'exitCode' | 'runId'>,
  sessionId: string,
  parsed: ParsedEvents,
  exitCode: number | null,
  runId: string,
): string | null => {
  try {
    return writeNotes({ ...notes, sessionId, parsed, exitCode, runId })
  } catch (err) {
    console.error(`codex-mcp: writeNotes failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

interface RunTimings {
  startedAt: number
  spawnAt: number
  /** Timestamp of the first stdout chunk; undefined when the run produced no stdout. */
  firstStdoutAt?: number
}

/**
 * Metric line plus the provenance of its `model` field. Additive: `modelSource` is absent whenever
 * `model` is, so consumers of the plain MetricEntry shape are unaffected.
 */
export type MetricEntryWithModelSource = MetricEntry & { modelSource?: ModelSource }

/** One passive JSONL metric line per completed run (T5 telemetry). */
const buildMetricEntry = (
  deps: RunAndReportDeps,
  cwd: string,
  outcome: RunOutcomeWithEvents,
  parsed: ParsedEvents,
  aborted: boolean,
  timings: RunTimings,
): MetricEntryWithModelSource => {
  // Authority order: what the run reported > what we asked for > what the CLI is configured to
  // default to. No source at all leaves both fields absent rather than guessing (R7.1).
  const resolved = resolveModel(parsed.model, deps.model)
  return {
    ts: new Date().toISOString(),
    tool: deps.tool,
    cwd,
    sessionId: parsed.sessionId,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - timings.startedAt,
    usage: parsed.usage,
    timedOut: outcome.timedOut,
    aborted,
    truncated: outcome.truncated ?? false,
    errorCount: parsed.errors.length,
    errorKind: deriveErrorKind(outcome, aborted, parsed.errors.length),
    errorMessage: errorMessageHead(parsed.errors),
    runId: deps.runId,
    model: resolved?.model,
    modelSource: resolved?.source,
    taskId: deps.taskId,
    queueMs: deps.queueMs,
    timeToFirstProgressMs:
      timings.firstStdoutAt === undefined ? undefined : timings.firstStdoutAt - timings.spawnAt,
  }
}

/** Run one Codex invocation and return the raw payload; shared by codex_execute/continue/review/batch. */
export const runOnce = async (
  deps: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
): Promise<{ payload: RunPayload; isError: boolean }> => {
  const { runFn, view, diffFn, snapshotFn, attributeFn, runId, progressNotifier, notes } = deps
  const startedAt = Date.now()
  try {
    // Before-run snapshot of already-dirty files so post-run changes can be attributed
    // (pre-existing dirt vs changes this run actually made). Best-effort — never fails the run.
    const snapshot =
      deps.presetSnapshot === undefined
        ? await safeSnapshot(snapshotFn, options.cwd)
        : deps.presetSnapshot
    // First-stdout probe measures spawn → first output for the metric log, on every run.
    let firstStdoutAt: number | undefined
    const firstStdoutProbe: ProgressSink = () => {
      firstStdoutAt ??= Date.now()
    }
    const onStdout = combineSinks(firstStdoutProbe, view.onStdout, progressNotifier?.sink)
    const spawnAt = Date.now()
    const outcome = await runFn(args, { ...options, onStdout })
    // Prefer the runner's lossless streamed parse (it saw bytes the raw stdout tail may have
    // rotated out). Fallback re-parse only covers injected fakes that return a bare RunOutcome.
    const rawParsed: ParsedEvents = outcome.parsed ?? parseEvents(outcome.stdout)
    // Redact before ANY sink sees the text: notes, the metric line, and the returned payload all
    // read from `parsed`/`stderr` below (R5.2).
    const { parsed, stderr, redactions } = redactRunFields(rawParsed, outcome.stderr)
    const aborted = outcome.aborted ?? false
    const status = deriveRunStatus(
      { exitCode: outcome.exitCode, timedOut: outcome.timedOut, aborted },
      parsed,
    )
    const notesPath =
      notes && parsed.sessionId
        ? writeNotesSafe(notes, parsed.sessionId, parsed, outcome.exitCode, runId)
        : null
    // Capture the diff even on timeout/abort: the workspace may be half-mutated and the caller
    // needs to see (and attribute) what changed before deciding to retry or roll back.
    const { diff, attribution } = await capturePostRunWorkspace(
      diffFn,
      attributeFn,
      options.cwd,
      snapshot,
    )
    const payload: RunPayload = {
      ...parsed,
      schemaVersion: RESULT_SCHEMA_VERSION,
      status,
      // Baseline verdict; the tool handler narrows it with verification / review-parse evidence.
      accepted: status === 'success',
      runId,
      diff,
      attribution,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      aborted,
      // Raw-tail rotation only (informational): the streamed parse saw the full stream, so a
      // rotated raw tail never downgrades `status` by itself.
      outputTruncated: outcome.truncated ?? false,
      stderr,
      liveLog: view.logPath,
      notesPath,
      // Additive and absent-not-zero: a clean run's payload is byte-identical to before (R5.2).
      ...(redactions > 0 ? { redactions } : {}),
    }
    // Passive metrics — one JSONL line per completed run, best-effort (never fails the run).
    appendMetric(buildMetricEntry(deps, options.cwd, outcome, parsed, aborted, { startedAt, spawnAt, firstStdoutAt }))
    return { payload, isError: isErrorStatus(status) }
  } finally {
    // Recovery keeps shared sinks alive across attempt boundaries; whichever layer owns them
    // performs the final progress flush and end marker once the logical run truly settles.
    if (deps.ownsSinks !== false) {
      progressNotifier?.settle()
      view.close()
    }
  }
}

export const runAndReport = async (
  deps: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
) => {
  const { payload, isError } = await runOnce(deps, args, options)
  return toToolResult(payload, isError)
}
