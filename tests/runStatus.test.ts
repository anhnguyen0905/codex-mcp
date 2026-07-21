import { describe, expect, test } from 'vitest'
import { deriveRunStatus, isErrorStatus, RESULT_SCHEMA_VERSION } from '../src/runStatus.js'

const cleanParse = {
  errors: [] as readonly string[],
  parseErrors: 0,
  sawCompletion: true,
}

const okOutcome = { exitCode: 0 as number | null, timedOut: false, aborted: false }

describe('deriveRunStatus', () => {
  test('returns success when the run exited 0 with a completion marker and a clean parse', () => {
    // Arrange / Act
    const status = deriveRunStatus(okOutcome, cleanParse)

    // Assert
    expect(status).toBe('success')
  })

  test('returns aborted when the run was cancelled, even if other failure signals are present', () => {
    const status = deriveRunStatus({ exitCode: 1, timedOut: true, aborted: true }, cleanParse)

    expect(status).toBe('aborted')
  })

  test('returns failed on timeout', () => {
    const status = deriveRunStatus({ ...okOutcome, timedOut: true, exitCode: null }, cleanParse)

    expect(status).toBe('failed')
  })

  test('returns failed on non-zero exit code', () => {
    const status = deriveRunStatus({ ...okOutcome, exitCode: 2 }, cleanParse)

    expect(status).toBe('failed')
  })

  test('returns failed on a null exit code (killed without timeout/abort)', () => {
    const status = deriveRunStatus({ ...okOutcome, exitCode: null }, cleanParse)

    expect(status).toBe('failed')
  })

  test('returns failed when Codex emitted turn-level errors', () => {
    const status = deriveRunStatus(okOutcome, { ...cleanParse, errors: ['turn failed'] })

    expect(status).toBe('failed')
  })

  test('returns partial when the stream ended without a completion marker', () => {
    const status = deriveRunStatus(okOutcome, { ...cleanParse, sawCompletion: false })

    expect(status).toBe('partial')
  })

  test('returns partial when the stream contained unparseable lines', () => {
    const status = deriveRunStatus(okOutcome, { ...cleanParse, parseErrors: 3 })

    expect(status).toBe('partial')
  })

  test('unknown event types alone do not downgrade success (benign new CLI events)', () => {
    // unknownEvents is intentionally not an input to classification — surfaced, not judged.
    const status = deriveRunStatus(okOutcome, cleanParse)

    expect(status).toBe('success')
  })

  test('warnings never affect status — a warnings-only run classifies by its completion marker', () => {
    // warnings ride in ParsedEvents (payload surface) but are NOT a StatusParse input:
    // a run that produced only warnings and a clean completion marker stays success.
    const parsedWithWarnings = { ...cleanParse, warnings: ['startup warning: something benign'] }

    const status = deriveRunStatus(okOutcome, parsedWithWarnings)

    expect(status).toBe('success')
  })
})

describe('isErrorStatus', () => {
  test('is true exactly for failed and aborted', () => {
    expect(isErrorStatus('failed')).toBe(true)
    expect(isErrorStatus('aborted')).toBe(true)
    expect(isErrorStatus('partial')).toBe(false)
    expect(isErrorStatus('success')).toBe(false)
  })
})

describe('RESULT_SCHEMA_VERSION', () => {
  test('is pinned at 1', () => {
    expect(RESULT_SCHEMA_VERSION).toBe(1)
  })
})
