import { StringDecoder } from 'node:string_decoder'
import type { CodexCommand, CodexFileChange, CodexResult, CodexUsage } from './types.js'

export const BENIGN_CLI_NOTICE_PATTERNS: readonly RegExp[] = [
  /^(?:`--dangerously-bypass-hook-trust`|--dangerously-bypass-hook-trust) is enabled\. Enabled hooks may run without review for this invocation\.?$/,
]

export const isBenignCliNotice = (message: string): boolean =>
  BENIGN_CLI_NOTICE_PATTERNS.some((pattern) => pattern.test(message))

interface RawEvent {
  type?: string
  thread_id?: string
  item?: RawItem
  usage?: RawUsage
  error?: { message?: string }
}

interface RawItem {
  type?: string
  text?: string
  message?: string
  command?: string
  exit_code?: number | null
  changes?: Array<{ path?: string; kind?: string }>
}

interface RawUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

/** Parse result extended with stream-health counters (additive to CodexResult). */
export interface ParsedEvents extends CodexResult {
  /** Number of non-empty lines that were not valid JSON objects. */
  parseErrors: number
  /** Number of parsed events whose event type / item type this parser does not handle. */
  unknownEvents: number
  /** True when a terminal event (turn.completed / turn.failed) was seen — false means the stream ended mid-turn. */
  sawCompletion: boolean
  /**
   * Known-benign CLI notices that should not fail the run.
   *
   * Error items have no protocol-level severity, so unmatched messages remain fail-closed in
   * `errors[]`. Repeated production metrics showed the narrowly allowlisted notices flipping
   * completed runs to failed. Warnings never affect status, so a run containing only these notices
   * now classifies success when its other completion signals are clean.
   */
  warnings: string[]
  /** Number of turn.started events seen (a run can span multiple turns). */
  turnCount: number
}

interface MutableResult {
  sessionId: string | null
  agentMessage: string | null
  fileChanges: CodexFileChange[]
  commands: CodexCommand[]
  usage: CodexUsage | null
  errors: string[]
  parseErrors: number
  unknownEvents: number
  sawCompletion: boolean
  warnings: string[]
  turnCount: number
}

const freshResult = (): MutableResult => ({
  sessionId: null,
  agentMessage: null,
  fileChanges: [],
  commands: [],
  usage: null,
  errors: [],
  parseErrors: 0,
  unknownEvents: 0,
  sawCompletion: false,
  warnings: [],
  turnCount: 0,
})

/** Immutable snapshot of the accumulator, safe to hand to callers. */
const snapshot = (result: MutableResult): ParsedEvents => ({
  sessionId: result.sessionId,
  agentMessage: result.agentMessage,
  fileChanges: [...result.fileChanges],
  commands: [...result.commands],
  usage: result.usage,
  errors: [...result.errors],
  parseErrors: result.parseErrors,
  unknownEvents: result.unknownEvents,
  sawCompletion: result.sawCompletion,
  warnings: [...result.warnings],
  turnCount: result.turnCount,
})

const parseLine = (line: string): RawEvent | null => {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawEvent) : null
  } catch {
    return null
  }
}

const toUsage = (raw: RawUsage): CodexUsage => ({
  inputTokens: raw.input_tokens ?? 0,
  cachedInputTokens: raw.cached_input_tokens ?? 0,
  outputTokens: raw.output_tokens ?? 0,
  reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
})

const toFileChanges = (item: RawItem): readonly CodexFileChange[] =>
  // Defend against malformed input: `changes` may be a non-array, or an array with null/non-object
  // entries. An unguarded `.map(c => c.path)` would throw and abort the whole parse, discarding an
  // otherwise-complete run's result.
  (Array.isArray(item.changes) ? item.changes : [])
    .filter((change): change is { path?: string; kind?: string } => typeof change === 'object' && change !== null)
    .map((change) => ({
      path: change.path ?? '',
      kind: change.kind ?? 'unknown',
    }))

const recordErrorMessage = (result: MutableResult, message: string): void => {
  if (isBenignCliNotice(message)) {
    result.warnings.push(message)
    return
  }
  result.errors.push(message)
}

// Mutating appliers: earlier this used {...result, X:[...result.X, ...Y]} inside a reduce, which is
// O(n^2) in the number of events (every line re-copies all accumulated arrays). Push in place → O(n).
// Both return whether the type was handled, so unhandled ones can be counted as unknownEvents.
const applyItem = (result: MutableResult, item: RawItem): boolean => {
  switch (item.type) {
    case 'agent_message':
      result.agentMessage = item.text ?? null
      return true
    case 'file_change':
      result.fileChanges.push(...toFileChanges(item))
      return true
    case 'command_execution':
      result.commands.push({ command: item.command ?? '', exitCode: item.exit_code ?? null })
      return true
    case 'error':
      recordErrorMessage(result, item.message ?? 'unknown error')
      return true
    default:
      return false
  }
}

const applyEvent = (result: MutableResult, event: RawEvent): boolean => {
  switch (event.type) {
    case 'thread.started':
      result.sessionId = event.thread_id ?? null
      return true
    case 'turn.started':
      // Turn boundary marker (emitted since codex-cli 0.144.x). No state to extract beyond the
      // count — handling it keeps unknownEvents an honest canary for genuinely new event types.
      result.turnCount += 1
      return true
    case 'item.completed':
      return event.item ? applyItem(result, event.item) : false
    case 'turn.completed':
      if (event.usage) result.usage = toUsage(event.usage)
      result.sawCompletion = true
      return true
    case 'turn.failed':
      recordErrorMessage(result, event.error?.message ?? 'turn failed')
      result.sawCompletion = true
      return true
    default:
      return false
  }
}

/** Shared per-line step for the batch and incremental parsers. Blank lines are ignored. */
const processLine = (result: MutableResult, line: string): void => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  const event = parseLine(trimmed)
  if (!event) {
    result.parseErrors += 1
    return
  }
  if (!applyEvent(result, event)) result.unknownEvents += 1
}

export const parseEvents = (jsonl: string): ParsedEvents => {
  const result = freshResult()
  for (const line of jsonl.split('\n')) processLine(result, line)
  return snapshot(result)
}

export interface IncrementalParser {
  /** Feed the next stdout chunk. A partial trailing line is carried over to the next push. */
  push(chunk: string | Buffer): void
  /** Flush the final (possibly unterminated) line. Idempotent; pushes after end() are ignored. */
  end(): void
  /** Immutable snapshot of everything parsed so far. */
  result(): ParsedEvents
}

/**
 * Streaming JSONL parser: same semantics as `parseEvents`, but consumes chunks as they arrive so
 * a run's events are parsed without re-scanning the full buffered stdout. Buffer chunks go through
 * a StringDecoder so multi-byte UTF-8 characters split across chunk boundaries stay intact.
 */
export const createIncrementalParser = (): IncrementalParser => {
  const state = freshResult()
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let ended = false

  const push = (chunk: string | Buffer): void => {
    // After end() the result is final: late writes from lingering pipe holders (descendants that
    // outlive the codex process) must not corrupt an already-settled parse.
    if (ended) return
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
    const lines = (carry + text).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) processLine(state, line)
  }

  const end = (): void => {
    if (ended) return
    ended = true
    processLine(state, carry + decoder.end())
    carry = ''
  }

  return { push, end, result: () => snapshot(state) }
}
