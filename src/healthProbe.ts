import { buildExecuteInvocation } from './argsBuilder.js'
import type { RunOutcomeWithEvents } from './codexRunner.js'
import { parseEvents } from './eventParser.js'
import type { RunFn } from './runReport.js'
import type { StatusParse } from './runStatus.js'

/**
 * Optional deep health probe for `codex_health` (R3.1, R3.2, Contract C1).
 *
 * `codex --version` and `codex login status` both succeed while the account is out of credits or
 * pinned to a model the installed CLI cannot run, so login status alone cannot detect an outage.
 * The deep probe dispatches exactly ONE bounded read-only `codex exec` turn and classifies its
 * output into an outage reason. It stays opt-in: without `deep` no probe process is spawned.
 */

export type ExecProbeStatus = 'ok' | 'quota' | 'model' | 'error' | 'skipped'

export interface ExecProbe {
  execProbe: ExecProbeStatus
  execProbeMessage: string
}

/** Fixed probe prompt (Contract C1) — cheap, deterministic, and explicitly file-free. */
export const HEALTH_PROBE_PROMPT = 'Respond with exactly OK. Do not read or modify files.'

/** Every probe message is bounded: probe stderr/JSONL can be arbitrarily large. */
export const MAX_PROBE_MESSAGE_CHARS = 400

const OK_MESSAGE = 'probe completed'

/** `skipped` is reserved for a requested probe that was never dispatched (Contract C1). */
const SKIPPED_MESSAGE = 'probe skipped: the request was aborted before the probe was dispatched'

/** Out-of-credits signature observed on 2026-09-08. */
const QUOTA_SIGNATURE = /out of credits/i

/** Unsupported/unknown-model signatures observed on 2026-09-08. */
const MODEL_SIGNATURES: readonly RegExp[] = [
  /requires a newer version of codex/i,
  /model metadata for .* not found/i,
]

const truncate = (text: string): string =>
  text.length <= MAX_PROBE_MESSAGE_CHARS ? text : `${text.slice(0, MAX_PROBE_MESSAGE_CHARS - 1)}…`

const probeError = (message: string): ExecProbe => ({
  execProbe: 'error',
  execProbeMessage: truncate(message),
})

/**
 * Every place an outage signature can surface, most specific first: the parsed `errors[]` events,
 * then stderr, then the raw JSONL stdout (a `--json` run reports turn failures as events only).
 */
const probeTexts = (outcome: RunOutcomeWithEvents): readonly string[] => [
  ...(outcome.parsed?.errors ?? []),
  outcome.stderr,
  outcome.stdout,
]

const firstMatchingLine = (texts: readonly string[], signature: RegExp): string | null => {
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (signature.test(line)) return line.trim()
    }
  }
  return null
}

const matchSignature = (texts: readonly string[], signatures: readonly RegExp[]): string | null => {
  for (const signature of signatures) {
    const line = firstMatchingLine(texts, signature)
    if (line !== null) return line
  }
  return null
}

const firstNonEmptyLine = (text: string): string | null =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null

/**
 * Parser-level signals for the probe. `parsed` is present whenever the runner parsed the stream;
 * callers that inject a raw runner (tests, alternative transports) supply stdout only, so the
 * JSONL is parsed here as a fallback rather than treated as "no evidence either way".
 */
const probeParse = (outcome: RunOutcomeWithEvents): StatusParse =>
  outcome.parsed ?? parseEvents(outcome.stdout)

/**
 * Classify one probe outcome. Quota is checked before the model signatures: a workspace that ran
 * out of credits is the actionable cause even when the same output also mentions the model.
 *
 * Exit code 0 alone is NOT evidence of a healthy Codex: a probe can exit 0 with empty stdout or a
 * stream that ended mid-turn. `ok` therefore requires the same trustworthy-turn signals
 * `deriveRunStatus` uses to separate `success` from `partial` (completion marker seen, no
 * unparseable lines). `unknownEvents` is deliberately not a signal, exactly as in `deriveRunStatus`.
 */
export const classifyExecProbe = (outcome: RunOutcomeWithEvents): ExecProbe => {
  const texts = probeTexts(outcome)

  const quotaLine = firstMatchingLine(texts, QUOTA_SIGNATURE)
  if (quotaLine !== null) return { execProbe: 'quota', execProbeMessage: truncate(quotaLine) }

  const modelLine = matchSignature(texts, MODEL_SIGNATURES)
  if (modelLine !== null) return { execProbe: 'model', execProbeMessage: truncate(modelLine) }

  if (outcome.timedOut) return probeError('probe timed out before Codex answered')
  if (outcome.aborted ?? false) return probeError('probe was aborted before Codex answered')

  const parsed = probeParse(outcome)
  const reportedError = parsed.errors.find((error) => error.trim().length > 0)
  if (reportedError !== undefined) return probeError(reportedError.trim())

  if (outcome.exitCode !== 0) {
    const detail = firstNonEmptyLine(outcome.stderr)
    return probeError(detail ?? `probe exited with code ${String(outcome.exitCode)}`)
  }

  if (!parsed.sawCompletion) return probeError('probe exited 0 without a completed turn')
  if (parsed.parseErrors > 0) return probeError('probe exited 0 with unparseable events')

  return { execProbe: 'ok', execProbeMessage: OK_MESSAGE }
}

export interface ExecProbeOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Dispatch the single deep probe through the shared runner abstraction (so callers and tests
 * inject their own runner) and classify it. Never throws: a runner rejection is an `error`
 * probe, because health must still report the version/login fields it already gathered.
 */
export const runExecProbe = async (runFn: RunFn, options: ExecProbeOptions): Promise<ExecProbe> => {
  if (options.signal?.aborted ?? false) {
    return { execProbe: 'skipped', execProbeMessage: SKIPPED_MESSAGE }
  }
  const invocation = buildExecuteInvocation({
    prompt: HEALTH_PROBE_PROMPT,
    cwd: options.cwd,
    sandbox: 'read-only',
  })
  try {
    const outcome = await runFn(invocation.args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stdinInput: invocation.stdinInput,
    })
    return classifyExecProbe(outcome)
  } catch (error: unknown) {
    return probeError(error instanceof Error ? error.message : String(error))
  }
}
