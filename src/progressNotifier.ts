import { StringDecoder } from 'node:string_decoder'
import { formatEvent } from './progressFormatter.js'

export type ProgressSink = (chunk: Buffer) => void
export type ProgressSender = (message: string, progress: number) => void

/** Coalescing window: at most one progress notification per run per this interval. */
export const PROGRESS_INTERVAL_MS = 250

// A single unterminated JSONL line must not grow the pending buffer without bound (progress is
// forwarded even after the runner's byte cap). 1MB is far above any real event line.
const MAX_PENDING_BYTES = 1024 * 1024

/**
 * Throttled progress notifier. `sink` consumes raw stdout chunks; `settle()` must be called when
 * the run finishes so the final message is flushed immediately and the coalescing timer is stopped.
 */
export interface ProgressNotifier {
  sink: ProgressSink
  settle: () => void
}

interface PendingMessage {
  message: string
  progress: number
}

/**
 * Turn Codex's raw JSONL stdout stream into human-readable progress callbacks, throttled to at
 * most one `send` per `intervalMs`: a chatty run must not spam the MCP client with one
 * notification per event. Intermediate updates collapse to the LATEST message only (no
 * buffering); the monotonic `progress` counter still counts every event, so batch attribution
 * semantics are preserved. Buffers partial lines across chunks; unparseable or uninteresting
 * lines are skipped.
 */
export const createProgressNotifier = (
  send: ProgressSender,
  intervalMs: number = PROGRESS_INTERVAL_MS,
): ProgressNotifier => {
  // Decode across chunks so a multi-byte UTF-8 char split at a chunk boundary isn't mangled.
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let progress = 0
  let latest: PendingMessage | null = null
  let timer: NodeJS.Timeout | null = null
  let lastSentAt = Number.NEGATIVE_INFINITY

  const emitLatest = (): void => {
    if (latest === null) return
    const { message, progress: eventCount } = latest
    latest = null
    lastSentAt = Date.now()
    send(message, eventCount)
  }

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const scheduleEmit = (): void => {
    if (timer !== null) return // a flush is already scheduled; it will pick up `latest`
    const waitMs = intervalMs - (Date.now() - lastSentAt)
    if (waitMs <= 0) {
      emitLatest()
      return
    }
    timer = setTimeout(() => {
      timer = null
      emitLatest()
    }, waitMs)
    // Progress is cosmetic — its timer must never hold the process open.
    timer.unref?.()
  }

  const noteLine = (line: string): boolean => {
    const formatted = formatEvent(line)
    if (formatted === null) return false
    progress += 1
    latest = { message: formatted, progress }
    return true
  }

  const sink: ProgressSink = (chunk) => {
    const lines = (pending + decoder.write(chunk)).split('\n')
    pending = lines.pop() ?? ''
    // Runaway line with no newline: stop buffering it (progress is cosmetic; the parsed result
    // is built separately in eventParser from the full stdout).
    if (pending.length > MAX_PENDING_BYTES) pending = ''
    // Schedule per formatted line (not per chunk) so the first event of a multi-line chunk
    // flushes immediately and only the follow-ups coalesce.
    for (const line of lines) {
      if (noteLine(line)) scheduleEmit()
    }
  }

  /** Flush the final state immediately: the last message must never be dropped or delayed. */
  const settle = (): void => {
    clearTimer()
    // The final line may not be newline-terminated — format it before the last flush.
    noteLine(pending + decoder.end())
    pending = ''
    emitLatest()
  }

  return { sink, settle }
}

/**
 * Fan one stdout stream out to several sinks; undefined when no sink is active.
 * Each sink is isolated: progress reporting is best-effort, and a throwing sink must
 * neither starve its siblings nor leak an exception into the child's 'data' handler
 * (which would crash the whole server process).
 */
export const combineSinks = (
  ...sinks: Array<ProgressSink | undefined>
): ProgressSink | undefined => {
  const active = sinks.filter((sink): sink is ProgressSink => sink !== undefined)
  if (active.length === 0) return undefined
  return (chunk) => {
    for (const sink of active) {
      try {
        sink(chunk)
      } catch {
        // best-effort: a broken progress sink must never fail the run
      }
    }
  }
}
