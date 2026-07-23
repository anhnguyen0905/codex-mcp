import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  aggregate,
  appendMetric,
  estimateCostUsd,
  parsePricing,
  readMetrics,
  type MetricEntry,
  type ModelCostRates,
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

  // POSIX permissions don't exist on Windows: statSync().mode reports 0o666 regardless.
  test.skipIf(process.platform === 'win32')('creates the log with mode 0o600', () => {
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

  test('includes entries from the rotated .1 file, older entries first', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, JSON.stringify(entry({ sessionId: 'rotated-old' })) + '\n')
    writeFileSync(logPath, JSON.stringify(entry({ sessionId: 'live-new' })) + '\n')
    const entries = readMetrics({ logPath })
    expect(entries.map((e) => e.sessionId)).toEqual(['rotated-old', 'live-new'])
  })

  test('reads only the rotated file when the live file is missing', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, JSON.stringify(entry({ sessionId: 'rotated-only' })) + '\n')
    const entries = readMetrics({ logPath })
    expect(entries.map((e) => e.sessionId)).toEqual(['rotated-only'])
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
    // total input=300, cachedInput=30, output=600, reasoning=15 → cost = 270/1M*1 + 30/1M*0.5 + 585/1M*2 + 15/1M*3
    // ≈ 0.00027 + 0.000015 + 0.00117 + 0.000045 = 0.0015
    expect(withCost.estCostUsd).toBeCloseTo(0.0015, 6)
  })

  test('counts an exit-0 entry with parsed errors (errorCount > 0) as failed', () => {
    const agg = aggregate([entry({ exitCode: 0, errorCount: 2, errorKind: 'turn-failed' })])
    expect(agg.totalRuns).toBe(1)
    expect(agg.failed).toBe(1)
  })

  test('legacy entries without errorCount keep their existing success/failure behavior', () => {
    const legacyOk = entry({ exitCode: 0 })
    const legacyFailed = entry({ exitCode: 1 })
    delete (legacyOk as Partial<MetricEntry>).errorCount
    delete (legacyFailed as Partial<MetricEntry>).errorCount
    const agg = aggregate([legacyOk, legacyFailed])
    expect(agg.totalRuns).toBe(2)
    expect(agg.failed).toBe(1)
  })

  test('handles entries with missing usage', () => {
    const agg = aggregate([entry({ usage: null })])
    expect(agg.totalTokens.input).toBe(0)
    expect(agg.totalRuns).toBe(1)
  })
})

describe('aggregate per-model breakdown', () => {
  test('groups runs, failures, duration, and tokens by model; modelless entries stay out of byModel', () => {
    const agg = aggregate([
      entry({ model: 'gpt-5.1-codex', durationMs: 1000, exitCode: 0 }),
      entry({ model: 'gpt-5.1-codex', durationMs: 500, exitCode: 1 }),
      entry({ model: 'o4-mini', durationMs: 2000, exitCode: 0 }),
      entry({ durationMs: 300, exitCode: 0 }), // legacy line without model
    ])
    expect(agg.totalRuns).toBe(4)
    expect(Object.keys(agg.byModel).sort()).toEqual(['gpt-5.1-codex', 'o4-mini'])
    expect(agg.byModel['gpt-5.1-codex']).toMatchObject({
      runs: 2,
      failed: 1,
      totalDurationMs: 1500,
    })
    expect(agg.byModel['gpt-5.1-codex'].tokens.input).toBe(200) // 100 × 2
    expect(agg.byModel['o4-mini']).toMatchObject({ runs: 1, failed: 0, totalDurationMs: 2000 })
  })

  test('byModel is an empty record when no entry carries a model', () => {
    const agg = aggregate([entry(), entry()])
    expect(agg.byModel).toEqual({})
  })

  test('per-model tokens ignore entries with null usage', () => {
    const agg = aggregate([entry({ model: 'm', usage: null }), entry({ model: 'm' })])
    expect(agg.byModel.m.runs).toBe(2)
    expect(agg.byModel.m.tokens.input).toBe(100)
  })
})

describe('aggregate timing averages', () => {
  test('averages queueMs and timeToFirstProgressMs only over entries that recorded them', () => {
    const agg = aggregate([
      entry({ queueMs: 100, timeToFirstProgressMs: 40 }),
      entry({ queueMs: 300 }),
      entry({}), // legacy line without either field
    ])
    expect(agg.avgQueueMs).toBe(200) // (100 + 300) / 2
    expect(agg.avgTimeToFirstProgressMs).toBe(40) // single sample
  })

  test('averages absent when no entry carries the field', () => {
    const agg = aggregate([entry(), entry()])
    expect(agg.avgQueueMs).toBeUndefined()
    expect(agg.avgTimeToFirstProgressMs).toBeUndefined()
  })
})

describe('model-aware cost estimation', () => {
  const rates: ModelCostRates = {
    inputPer1M: 1,
    cachedInputPer1M: 0.5,
    outputPer1M: 2,
    reasoningOutputPer1M: 3,
  }
  const table = { 'gpt-5.1-codex': rates }

  test('estimateCostUsd computes per-run cost from the table', () => {
    const usage = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 200, reasoningOutputTokens: 5 }
    // 90/1M*1 + 10/1M*0.5 + 195/1M*2 + 5/1M*3 = 0.0005
    expect(estimateCostUsd('gpt-5.1-codex', usage, table)).toBeCloseTo(0.0005, 8)
  })

  test('estimateCostUsd returns undefined for unknown model or missing usage — never 0', () => {
    const usage = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 200, reasoningOutputTokens: 5 }
    expect(estimateCostUsd('mystery-model', usage, table)).toBeUndefined()
    expect(estimateCostUsd(undefined, usage, table)).toBeUndefined()
    expect(estimateCostUsd('gpt-5.1-codex', null, table)).toBeUndefined()
  })

  test('aggregate sums estimatedCostUsd per model and overall when rates are known', () => {
    const agg = aggregate(
      [entry({ model: 'gpt-5.1-codex' }), entry({ model: 'gpt-5.1-codex' })],
      {},
      undefined,
      table,
    )
    expect(agg.byModel['gpt-5.1-codex'].estimatedCostUsd).toBeCloseTo(0.001, 8)
    expect(agg.estimatedCostUsd).toBeCloseTo(0.001, 8)
  })

  test('unknown model claims no cost: estimatedCostUsd stays undefined', () => {
    const agg = aggregate([entry({ model: 'mystery-model' })], {}, undefined, table)
    expect(agg.byModel['mystery-model'].estimatedCostUsd).toBeUndefined()
    expect(agg.estimatedCostUsd).toBeUndefined()
  })

  test('known and unknown models mix: only known-rate runs contribute to the sum', () => {
    const agg = aggregate(
      [entry({ model: 'gpt-5.1-codex' }), entry({ model: 'mystery-model' })],
      {},
      undefined,
      table,
    )
    expect(agg.estimatedCostUsd).toBeCloseTo(0.0005, 8)
    expect(agg.byModel['mystery-model'].estimatedCostUsd).toBeUndefined()
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
