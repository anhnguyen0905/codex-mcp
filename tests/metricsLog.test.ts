import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  aggregate,
  appendMetric,
  parsePricing,
  readMetrics,
  type MetricEntry,
} from '../src/metricsLog.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

const mkLog = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-'))
  tempDirs.push(dir)
  return join(dir, 'metrics.jsonl')
}

const entry = (over: Partial<MetricEntry> = {}): MetricEntry => ({
  ts: '2026-07-16T00:00:00Z',
  tool: 'codex_execute',
  cwd: '/w/one',
  sessionId: 'sess-1',
  exitCode: 0,
  durationMs: 1000,
  usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 200, reasoningOutputTokens: 5 },
  ...over,
})

describe('appendMetric', () => {
  test('writes one JSONL line per call', () => {
    const logPath = mkLog()
    appendMetric(entry({ sessionId: 'a' }), { logPath })
    appendMetric(entry({ sessionId: 'b' }), { logPath })
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).sessionId).toBe('a')
    expect(JSON.parse(lines[1]).sessionId).toBe('b')
  })

  test('creates the log with mode 0o600', () => {
    const logPath = mkLog()
    appendMetric(entry(), { logPath })
    const mode = statSync(logPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('rotates to <path>.1 when the log exceeds maxBytes', () => {
    const logPath = mkLog()
    // Seed the log past the cap.
    writeFileSync(logPath, 'x'.repeat(2048))
    appendMetric(entry({ sessionId: 'after-rotate' }), { logPath, maxBytes: 1024 })
    const current = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(current).toHaveLength(1)
    expect(JSON.parse(current[0]).sessionId).toBe('after-rotate')
    const rotated = readFileSync(`${logPath}.1`, 'utf8')
    expect(rotated.length).toBe(2048)
  })

  test('never throws when the target dir is unwritable (best-effort)', () => {
    // Path under an existing FILE — makes mkdir fail; must not throw.
    const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-'))
    tempDirs.push(dir)
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'x')
    expect(() => appendMetric(entry(), { logPath: join(blocker, 'sub', 'log.jsonl') })).not.toThrow()
  })
})

describe('readMetrics', () => {
  test('returns [] when the log does not exist', () => {
    const logPath = mkLog()
    expect(readMetrics({ logPath })).toEqual([])
  })

  test('skips malformed lines', () => {
    const logPath = mkLog()
    writeFileSync(
      logPath,
      [JSON.stringify(entry({ sessionId: 'good1' })), '{not json', '42', JSON.stringify(entry({ sessionId: 'good2' })), ''].join('\n'),
    )
    const entries = readMetrics({ logPath })
    expect(entries.map((e) => e.sessionId)).toEqual(['good1', 'good2'])
  })
})

describe('aggregate', () => {
  const many = [
    entry({ sessionId: 'a', tool: 'codex_execute', durationMs: 1000, exitCode: 0 }),
    entry({ sessionId: 'b', tool: 'codex_execute', durationMs: 500, exitCode: 1 }),
    entry({ sessionId: 'c', tool: 'codex_review', durationMs: 2000, exitCode: 0 }),
  ]

  test('sums runs, duration, and tokens across tools; counts failures', () => {
    const agg = aggregate(many)
    expect(agg.totalRuns).toBe(3)
    expect(agg.totalDurationMs).toBe(3500)
    expect(agg.failed).toBe(1)
    expect(agg.byTool.codex_execute.runs).toBe(2)
    expect(agg.byTool.codex_review.runs).toBe(1)
    expect(agg.totalTokens.input).toBe(300)
  })

  test('respects filters', () => {
    const only = aggregate(many, { tool: 'codex_review' })
    expect(only.totalRuns).toBe(1)
    expect(only.byTool.codex_review.runs).toBe(1)
    expect(only.byTool.codex_execute).toBeUndefined()
  })

  test('estCostUsd populated only when pricing supplied', () => {
    const noCost = aggregate(many)
    expect(noCost.estCostUsd).toBeUndefined()
    const pricing = parsePricing(
      JSON.stringify({ inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 2, reasoningOutputPer1M: 3 }),
    )
    const withCost = aggregate(many, {}, pricing)
    // total input=300, cachedInput=30, output=600, reasoning=15 → cost = 300/1M*1 + 30/1M*0.5 + 600/1M*2 + 15/1M*3
    // ≈ 0.0003 + 0.000015 + 0.0012 + 0.000045 = 0.00156
    expect(withCost.estCostUsd).toBeCloseTo(0.00156, 6)
  })

  test('handles entries with missing usage', () => {
    const agg = aggregate([entry({ usage: null })])
    expect(agg.totalTokens.input).toBe(0)
    expect(agg.totalRuns).toBe(1)
  })
})

describe('parsePricing', () => {
  test('returns undefined on missing/malformed input', () => {
    expect(parsePricing(undefined)).toBeUndefined()
    expect(parsePricing('')).toBeUndefined()
    expect(parsePricing('{not json')).toBeUndefined()
    expect(parsePricing('null')).toBeUndefined()
    expect(parsePricing('{"inputPer1M":1}')).toBeUndefined() // missing required fields
  })

  test('accepts a well-formed pricing table', () => {
    const p = parsePricing(
      JSON.stringify({ inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 2, reasoningOutputPer1M: 3 }),
    )
    expect(p).toEqual({ inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 2, reasoningOutputPer1M: 3 })
  })
})
