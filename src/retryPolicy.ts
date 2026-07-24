import type { RunStatus } from './runStatus.js'

export type ResumeReason = 'timeout' | 'transient-turn-failure' | 'no-completion-marker'

export interface ResumeDecision {
  resume: boolean
  reason?: ResumeReason
  delayMs?: number
}

export const MAX_TRANSIENT_RESUMES = 2
export const MAX_TIMEOUT_RESUMES = 1
export const MAX_PARTIAL_RESUMES = 1
export const RESUME_BACKOFF_MS: readonly number[] = [2_000, 8_000]

const TRANSIENT_ERROR_PATTERN =
  /stream|network|connection|disconnect|reset|timed?[ -]?out|429|rate limit|too many requests|50[023]|overloaded|temporar|unavailable|retry/i

export const isTransientErrorMessage = (message: string): boolean =>
  TRANSIENT_ERROR_PATTERN.test(message)

export interface ResumeSignals {
  status: RunStatus
  timedOut: boolean
  aborted: boolean
  exitCode: number | null
  errors: readonly string[]
  sawCompletion: boolean
  sessionId: string | null
  resumeCounts: Readonly<Record<ResumeReason, number>>
}

/**
 * Resume only failures known to be recoverable and only within their independent budgets.
 * Precedence is fail-closed: once a higher-priority signal applies, exhausting its budget does
 * not allow a lower-priority reason to resume the same run.
 */
export const decideResume = (signals: ResumeSignals): ResumeDecision => {
  if (signals.aborted || signals.sessionId === null) return { resume: false }

  const totalResumesSoFar = Object.values(signals.resumeCounts).reduce(
    (total, count) => total + count,
    0,
  )
  const delayMs =
    RESUME_BACKOFF_MS[Math.min(totalResumesSoFar, RESUME_BACKOFF_MS.length - 1)]

  if (signals.timedOut) {
    return signals.resumeCounts.timeout < MAX_TIMEOUT_RESUMES
      ? { resume: true, reason: 'timeout', delayMs }
      : { resume: false }
  }
  if (signals.exitCode !== 0) return { resume: false }
  if (signals.errors.length > 0) {
    const hasTransientError = signals.errors.some(isTransientErrorMessage)
    return hasTransientError &&
      signals.resumeCounts['transient-turn-failure'] < MAX_TRANSIENT_RESUMES
      ? { resume: true, reason: 'transient-turn-failure', delayMs }
      : { resume: false }
  }
  if (signals.status === 'partial' && !signals.sawCompletion) {
    return signals.resumeCounts['no-completion-marker'] < MAX_PARTIAL_RESUMES
      ? { resume: true, reason: 'no-completion-marker', delayMs }
      : { resume: false }
  }
  return { resume: false }
}
