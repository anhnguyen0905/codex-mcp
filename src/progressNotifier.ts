import { formatEvent } from './progressFormatter.js'

export type ProgressSink = (chunk: Buffer) => void
export type ProgressSender = (message: string, progress: number) => void

/**
 * Turn Codex's raw JSONL stdout stream into human-readable progress callbacks.
 * Buffers partial lines across chunks; unparseable or uninteresting lines are skipped.
 */
export const createProgressNotifier = (send: ProgressSender): ProgressSink => {
  let pending = ''
  let progress = 0
  return (chunk: Buffer) => {
    const lines = (pending + chunk.toString('utf8')).split('\n')
    pending = lines.pop() ?? ''
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
