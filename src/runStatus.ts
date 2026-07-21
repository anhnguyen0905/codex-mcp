/**
 * Run status model shared by codex_execute / codex_continue / codex_review and each
 * codex_batch task result. Bump RESULT_SCHEMA_VERSION on any breaking payload change.
 */
export const RESULT_SCHEMA_VERSION = 1

export type RunStatus = 'success' | 'partial' | 'failed' | 'aborted'

/** Outcome-level signals that classify a run (subset of RunOutcome, aborted already defaulted). */
export interface StatusOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

/** Parser-level signals that classify a run (subset of ParsedEvents). */
export interface StatusParse {
  errors: readonly string[]
  parseErrors: number
  sawCompletion: boolean
}

/**
 * Classify a run, by precedence:
 * - `aborted`  — the run was cancelled (AbortSignal), regardless of other signals.
 * - `failed`   — timed out, exited non-zero (or was killed: null exit), or Codex emitted
 *                turn-level errors.
 * - `partial`  — the process "succeeded" but the event stream is not trustworthy: no terminal
 *                turn.completed/turn.failed marker, or unparseable JSONL lines. An empty stdout
 *                with exit code 0 lands here, never in `success`.
 * - `success`  — completion marker seen and the stream parsed cleanly.
 *
 * Deliberately NOT inputs: `unknownEvents` (new CLI versions add benign event types — surfaced
 * in the payload but never downgrades status), raw-tail truncation (the runner's parser is
 * lossless, so a rotated raw stdout tail loses no parser-level data), and `warnings` (warning-ish
 * messages ride in ParsedEvents/payload for visibility but never affect classification — a
 * warnings-only run still classifies by its completion marker).
 */
export const deriveRunStatus = (outcome: StatusOutcome, parsed: StatusParse): RunStatus => {
  if (outcome.aborted) return 'aborted'
  if (outcome.timedOut || outcome.exitCode !== 0 || parsed.errors.length > 0) return 'failed'
  if (!parsed.sawCompletion || parsed.parseErrors > 0) return 'partial'
  return 'success'
}

/** isError is true exactly for failed | aborted — `partial` is the reviewer's call, not an error. */
export const isErrorStatus = (status: RunStatus): boolean =>
  status === 'failed' || status === 'aborted'
