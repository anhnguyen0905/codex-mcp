import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
// @ts-expect-error — plain .mjs helper module without type declarations (bench scripts only).
import * as benchLib from '../scripts/bench-lib.mjs'

const { benchRow, printResultsTable, formatMs, formatMb, waitFor, makeTempDir, cleanupDirs } = benchLib

describe('bench-lib pure helpers', () => {
  let written: string[]

  beforeEach(() => {
    written = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('benchRow builds an immutable-shaped row', () => {
    // Arrange + Act
    const row = benchRow('metric-a', '12ms', '< 100ms', true)

    // Assert
    expect(row).toEqual({ metric: 'metric-a', measured: '12ms', slo: '< 100ms', pass: true })
  })

  test('printResultsTable returns true when every row passed', () => {
    const rows = [benchRow('a', '1ms', '< 10ms', true), benchRow('b', '2ms', '< 10ms', true)]

    const allPassed = printResultsTable('t', rows)

    expect(allPassed).toBe(true)
    expect(written.join('')).toContain('PASS')
    expect(written.join('')).not.toContain('FAIL')
  })

  test('printResultsTable returns false when any row failed', () => {
    const rows = [benchRow('a', '1ms', '< 10ms', true), benchRow('b', '99ms', '< 10ms', false)]

    const allPassed = printResultsTable('t', rows)

    expect(allPassed).toBe(false)
    expect(written.join('')).toContain('FAIL')
  })

  test('printResultsTable does not mutate its input rows', () => {
    const rows = [benchRow('a', '1ms', '< 10ms', true)]
    const snapshot = JSON.parse(JSON.stringify(rows))

    printResultsTable('t', rows)

    expect(rows).toEqual(snapshot)
  })

  test('formatMs rounds to whole milliseconds', () => {
    expect(formatMs(123.6)).toBe('124ms')
  })

  test('formatMb renders bytes as MB with one decimal', () => {
    expect(formatMb(150 * 1024 * 1024)).toBe('150.0MB')
    expect(formatMb(512 * 1024)).toBe('0.5MB')
  })

  test('waitFor resolves true once the condition becomes true', async () => {
    let calls = 0

    const result = await waitFor(() => ++calls >= 3, 1_000, 1)

    expect(result).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('waitFor returns false when the condition never becomes true', async () => {
    const result = await waitFor(() => false, 30, 5)

    expect(result).toBe(false)
  })

  test('makeTempDir creates a directory and cleanupDirs removes it', async () => {
    const dir = makeTempDir('bench-lib-test')
    expect(existsSync(dir)).toBe(true)

    await cleanupDirs([dir])

    expect(existsSync(dir)).toBe(false)
  })
})
