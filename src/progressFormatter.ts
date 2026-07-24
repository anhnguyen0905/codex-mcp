import { isBenignCliNotice } from './eventParser.js'

/**
 * Synthetic end-of-run marker appended to the live log by liveView when a run settles. Not a
 * Codex CLI event — it never reaches the event parser (the live log is write-only output).
 * Keep the literal in sync with scripts/tail-progress.mjs, which detects it without importing
 * this module so the watcher works even when dist/ is not built.
 */
export const LIVE_RUN_FINISHED_TYPE = 'live.run_finished'

/** Stream-derived terminal state for the live log marker (liveView cannot see exit codes). */
export type LiveRunFinishedStatus = 'completed' | 'failed' | 'interrupted'

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
  /** live.run_finished marker fields (written by liveView, not the Codex CLI). */
  status?: string
  sessionId?: string | null
}

const time = (): string => new Date().toLocaleTimeString()

const formatItem = (item: RawItem): string | null => {
  switch (item.type) {
    case 'agent_message':
      return `💬 ${item.text ?? ''}`.trimEnd()
    case 'command_execution':
      return `▸ $ ${item.command ?? ''}  (exit ${item.exit_code ?? '…'})`
    case 'file_change': {
      // Count only valid entries, matching eventParser.toFileChanges (which drops null/non-object),
      // so the live view's file count never disagrees with the parsed result.
      const changes = (Array.isArray(item.changes) ? item.changes : []).filter(
        (change) => typeof change === 'object' && change !== null,
      )
      const paths = changes.map((change) => change.path ?? '?').join(', ')
      return `✎ ${changes.length} file(s): ${paths}`
    }
    case 'error': {
      const message = item.message ?? 'unknown error'
      return `${isBenignCliNotice(message) ? '⚠' : '✗'} ${message}`
    }
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
    case 'turn.failed': {
      const message = event.error?.message ?? 'unknown'
      return isBenignCliNotice(message)
        ? `⚠ ${message}`
        : `✗ turn failed: ${message}`
    }
    case LIVE_RUN_FINISHED_TYPE:
      return `=== run ${event.sessionId ?? '?'} finished: ${event.status ?? 'unknown'} ===`
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
