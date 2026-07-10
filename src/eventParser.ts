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

const EMPTY_RESULT: CodexResult = {
  sessionId: null,
  agentMessage: null,
  fileChanges: [],
  commands: [],
  usage: null,
  errors: [],
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
  (item.changes ?? []).map((change) => ({
    path: change.path ?? '',
    kind: change.kind ?? 'unknown',
  }))

const applyItem = (result: CodexResult, item: RawItem): CodexResult => {
  switch (item.type) {
    case 'agent_message':
      return { ...result, agentMessage: item.text ?? null }
    case 'file_change':
      return { ...result, fileChanges: [...result.fileChanges, ...toFileChanges(item)] }
    case 'command_execution': {
      const command: CodexCommand = { command: item.command ?? '', exitCode: item.exit_code ?? null }
      return { ...result, commands: [...result.commands, command] }
    }
    case 'error':
      return { ...result, errors: [...result.errors, item.message ?? 'unknown error'] }
    default:
      return result
  }
}

const applyEvent = (result: CodexResult, event: RawEvent): CodexResult => {
  switch (event.type) {
    case 'thread.started':
      return { ...result, sessionId: event.thread_id ?? null }
    case 'item.completed':
      return event.item ? applyItem(result, event.item) : result
    case 'turn.completed':
      return event.usage ? { ...result, usage: toUsage(event.usage) } : result
    case 'turn.failed':
      return { ...result, errors: [...result.errors, event.error?.message ?? 'turn failed'] }
    default:
      return result
  }
}

export const parseEvents = (jsonl: string): CodexResult =>
  jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseLine)
    .filter((event): event is RawEvent => event !== null)
    .reduce(applyEvent, EMPTY_RESULT)
