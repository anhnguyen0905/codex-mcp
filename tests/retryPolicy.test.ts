import { describe, expect, test } from 'vitest'
import {
  decideResume,
  isTransientErrorMessage,
  MAX_PARTIAL_RESUMES,
  MAX_TIMEOUT_RESUMES,
  MAX_TRANSIENT_RESUMES,
  RESUME_BACKOFF_MS,
  type ResumeSignals,
} from '../src/retryPolicy.js'

const noResumeCounts = {
  timeout: 0,
  'transient-turn-failure': 0,
  'no-completion-marker': 0,
} as const

const successfulSignals: ResumeSignals = {
  status: 'success',
  timedOut: false,
  aborted: false,
  exitCode: 0,
  errors: [],
  sawCompletion: true,
  sessionId: 'session-123',
  resumeCounts: noResumeCounts,
}

describe('retry policy contract', () => {
  test('exports the documented resume budgets and backoff schedule', () => {
    // Arrange / Act / Assert
    expect(MAX_TRANSIENT_RESUMES).toBe(2)
    expect(MAX_TIMEOUT_RESUMES).toBe(1)
    expect(MAX_PARTIAL_RESUMES).toBe(1)
    expect(RESUME_BACKOFF_MS).toEqual([2_000, 8_000])
  })
})

describe('isTransientErrorMessage', () => {
  test.each([
    'stream disconnected',
    '429 Too Many Requests',
    'error: unexpected status 503',
    'network connection reset',
    'request timed-out',
    'service temporarily unavailable',
    'server overloaded; retry later',
  ])('returns true for transient error message: %s', (message) => {
    // Arrange / Act
    const isTransient = isTransientErrorMessage(message)

    // Assert
    expect(isTransient).toBe(true)
  })

  test.each(['compilation failed', 'test assertion failed'])(
    'returns false for non-transient error message: %s',
    (message) => {
      // Arrange / Act
      const isTransient = isTransientErrorMessage(message)

      // Assert
      expect(isTransient).toBe(false)
    },
  )
})

describe('decideResume', () => {
  test('does not resume an aborted run even when a timeout is otherwise eligible', () => {
    // Arrange
    const signals = { ...successfulSignals, status: 'aborted' as const, aborted: true, timedOut: true }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume without a session id even when a timeout is otherwise eligible', () => {
    // Arrange
    const signals = { ...successfulSignals, status: 'failed' as const, timedOut: true, sessionId: null }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('resumes an eligible timeout before evaluating a non-zero exit code', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      timedOut: true,
      exitCode: 1,
      errors: ['compilation failed'],
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: true, reason: 'timeout', delayMs: 2_000 })
  })

  test('does not resume a timeout at its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      timedOut: true,
      resumeCounts: { ...noResumeCounts, timeout: MAX_TIMEOUT_RESUMES },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a timeout over its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      timedOut: true,
      resumeCounts: { ...noResumeCounts, timeout: MAX_TIMEOUT_RESUMES + 1 },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a non-zero exit even when transient errors and partial status are present', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      exitCode: 1,
      errors: ['stream disconnected'],
      sawCompletion: false,
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a null exit even when transient errors and partial status are present', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      exitCode: null,
      errors: ['stream disconnected'],
      sawCompletion: false,
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('resumes when at least one turn error is transient', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      errors: ['compilation failed', 'stream disconnected'],
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({
      resume: true,
      reason: 'transient-turn-failure',
      delayMs: 2_000,
    })
  })

  test('does not resume when turn errors are all non-transient', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      errors: ['compilation failed', 'test assertion failed'],
      sawCompletion: false,
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a transient turn failure at its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      errors: ['429 Too Many Requests'],
      resumeCounts: {
        ...noResumeCounts,
        'transient-turn-failure': MAX_TRANSIENT_RESUMES,
      },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a transient turn failure over its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      errors: ['error: unexpected status 503'],
      resumeCounts: {
        ...noResumeCounts,
        'transient-turn-failure': MAX_TRANSIENT_RESUMES + 1,
      },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test.each([
    ['at', MAX_TRANSIENT_RESUMES],
    ['over', MAX_TRANSIENT_RESUMES + 1],
  ] as const)(
    'does not fall through to partial recovery when the transient budget is %s its maximum',
    (_budgetState, transientResumeCount) => {
      // Arrange
      const signals = {
        ...successfulSignals,
        status: 'partial' as const,
        errors: ['stream disconnected'],
        sawCompletion: false,
        resumeCounts: {
          ...noResumeCounts,
          'transient-turn-failure': transientResumeCount,
        },
      }

      // Act
      const decision = decideResume(signals)

      // Assert
      expect(decision).toEqual({ resume: false })
    },
  )

  test('resumes a partial run once when no completion marker was seen', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      sawCompletion: false,
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({
      resume: true,
      reason: 'no-completion-marker',
      delayMs: 2_000,
    })
  })

  test('does not resume a partial run when a completion marker was seen', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      sawCompletion: true,
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a partial run at its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      sawCompletion: false,
      resumeCounts: {
        ...noResumeCounts,
        'no-completion-marker': MAX_PARTIAL_RESUMES,
      },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a partial run over its maximum resume count', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'partial' as const,
      sawCompletion: false,
      resumeCounts: {
        ...noResumeCounts,
        'no-completion-marker': MAX_PARTIAL_RESUMES + 1,
      },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('does not resume a successful run without recoverable failure signals', () => {
    // Arrange / Act
    const decision = decideResume(successfulSignals)

    // Assert
    expect(decision).toEqual({ resume: false })
  })

  test('uses the second backoff after one prior resume across any reason', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      errors: ['network unavailable'],
      resumeCounts: { ...noResumeCounts, timeout: 1 },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision.delayMs).toBe(RESUME_BACKOFF_MS[1])
  })

  test('reuses the last backoff when total prior resumes exceed the configured range', () => {
    // Arrange
    const signals = {
      ...successfulSignals,
      status: 'failed' as const,
      errors: ['stream disconnected'],
      resumeCounts: {
        timeout: 3,
        'transient-turn-failure': 0,
        'no-completion-marker': 4,
      },
    }

    // Act
    const decision = decideResume(signals)

    // Assert
    expect(decision.delayMs).toBe(RESUME_BACKOFF_MS[RESUME_BACKOFF_MS.length - 1])
  })
})
