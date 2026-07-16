import { StringDecoder } from 'node:string_decoder'
import { formatEvent } from './progressFormatter.js'

export type ProgressSink = (chunk: Buffer) => void
export type ProgressSender = (message: string, progress: number) => void

/**
 * Turn Codex's raw JSONL stdout stream into human-readable progress callbacks.
 * Buffers partial lines across chunks; unparseable or uninteresting lines are skipped.
 */
// A single unterminated JSONL line must not grow the pending buffer without bound (progress is
// forwarded even after the runner's byte cap). 1MB is far above any real event line.
const MAX_PENDING_BYTES = 1024 * 1024

export const createProgressNotifier = (send: ProgressSender): ProgressSink => {
  // Decode across chunks so a multi-byte UTF-8 char split at a chunk boundary isn't mangled.
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let progress = 0
  return (chunk: Buffer) => {
    const lines = (pending + decoder.write(chunk)).split('\n')
    pending = lines.pop() ?? ''
    // Runaway line with no newline: stop buffering it (progress is cosmetic; the parsed result
    // is built separately in eventParser from the full stdout).
    if (pending.length > MAX_PENDING_BYTES) pending = ''
    for (const line of lines) {
      const formatted = formatEvent(line)
      if (formatted !== null) {
        progress += 1
        send(formatted, progress)
      }
    }
  }
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
