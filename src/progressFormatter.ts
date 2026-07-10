interface RawItem {
  type?: string
  text?: string
  message?: string
  command?: string
  exit_code?: number | null
  changes?: Array<{ path?: string; kind?: string }>
}

interface RawEvent {
  type?: string
  thread_id?: string
  item?: RawItem
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

const time = (): string => new Date().toLocaleTimeString()

const formatItem = (item: RawItem): string | null => {
  switch (item.type) {
    case 'agent_message':
      return `💬 ${item.text ?? ''}`.trimEnd()
    case 'command_execution':
      return `▸ $ ${item.command ?? ''}  (exit ${item.exit_code ?? '…'})`
    case 'file_change': {
      const paths = (item.changes ?? []).map((change) => change.path ?? '?').join(', ')
      return `✎ ${(item.changes ?? []).length} file(s): ${paths}`
    }
    case 'error':
      return `✗ ${item.message ?? 'unknown error'}`
    default:
      return null
  }
}

const formatByType = (event: RawEvent): string | null => {
  switch (event.type) {
    case 'thread.started':
      return `● session started: ${event.thread_id ?? '?'}`
    case 'item.completed':
      return event.item ? formatItem(event.item) : null
    case 'turn.completed':
      return `✓ turn complete (in:${event.usage?.input_tokens ?? 0} out:${event.usage?.output_tokens ?? 0})`
    case 'turn.failed':
      return `✗ turn failed: ${event.error?.message ?? 'unknown'}`
    default:
      return null
  }
}

/** Turn one JSONL Codex event line into a human-readable progress line, or null to skip it. */
export const formatEvent = (jsonLine: string): string | null => {
  const trimmed = jsonLine.trim()
  if (trimmed.length === 0) return null

  let event: RawEvent
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    event = parsed as RawEvent
  } catch {
    return null
  }

  const body = formatByType(event)
  return body === null ? null : `[${time()}] ${body}`
}
