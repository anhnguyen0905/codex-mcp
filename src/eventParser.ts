import type { CodexCommand, CodexFileChange, CodexResult, CodexUsage } from './types.js'

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

interface MutableResult {
  sessionId: string | null
  agentMessage: string | null
  fileChanges: CodexFileChange[]
  commands: CodexCommand[]
  usage: CodexUsage | null
  errors: string[]
}

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

// Mutating appliers: earlier this used {...result, X:[...result.X, ...Y]} inside a reduce, which is
// O(n^2) in the number of events (every line re-copies all accumulated arrays). Push in place → O(n).
const applyItem = (result: MutableResult, item: RawItem): void => {
  switch (item.type) {
    case 'agent_message':
      result.agentMessage = item.text ?? null
      return
    case 'file_change':
      result.fileChanges.push(...toFileChanges(item))
      return
    case 'command_execution':
      result.commands.push({ command: item.command ?? '', exitCode: item.exit_code ?? null })
      return
    case 'error':
      result.errors.push(item.message ?? 'unknown error')
      return
  }
}

const applyEvent = (result: MutableResult, event: RawEvent): void => {
  switch (event.type) {
    case 'thread.started':
      result.sessionId = event.thread_id ?? null
      return
    case 'item.completed':
      if (event.item) applyItem(result, event.item)
      return
    case 'turn.completed':
      if (event.usage) result.usage = toUsage(event.usage)
      return
    case 'turn.failed':
      result.errors.push(event.error?.message ?? 'turn failed')
      return
  }
}

export const parseEvents = (jsonl: string): CodexResult => {
  const result: MutableResult = {
    sessionId: null,
    agentMessage: null,
    fileChanges: [],
    commands: [],
    usage: null,
    errors: [],
  }
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const event = parseLine(trimmed)
    if (event) applyEvent(result, event)
  }
  return result
}
