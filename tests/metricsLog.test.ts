import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  aggregate,
  appendMetric,
  estimateCostUsd,
  isFailedEntry,
  isValidMetricEntry,
  parsePricing,
  readMetrics,
  readMetricsDetailed,
  ROTATION_NOTICE,
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

describe('isFailedEntry (IMP-17)', () => {
  test('counts an exit-0 entry whose only failure signal is errorKind as failed', () => {
    // Arrange — a turn-failed classification that never carried an errorCount.
    const classifiedOnly = entry({ exitCode: 0, errorKind: 'turn-failed' })

    // Act & Assert
    expect(isFailedEntry(classifiedOnly)).toBe(true)
    expect(aggregate([classifiedOnly]).failed).toBe(1)
  })

  test('an empty-string errorKind is not a failure signal', () => {
    expect(isFailedEntry(entry({ exitCode: 0, errorKind: '' }))).toBe(false)
    expect(aggregate([entry({ exitCode: 0, errorKind: '' })]).failed).toBe(0)
  })

  test('a clean legacy entry with no error fields stays a success', () => {
    expect(isFailedEntry(entry({ exitCode: 0 }))).toBe(false)
  })

  test.each<[string, Partial<MetricEntry>]>([
    ['non-zero exitCode', { exitCode: 2 }],
    ['null exitCode', { exitCode: null }],
    ['timedOut', { exitCode: 0, timedOut: true }],
    ['aborted', { exitCode: 0, aborted: true }],
    ['errorCount > 0', { exitCode: 0, errorCount: 1 }],
  ])('still counts %s as failed', (_label, overrides) => {
    expect(isFailedEntry(entry(overrides))).toBe(true)
  })
})

describe('aggregate byModel provenance counts (IMP-8)', () => {
  test('counts each modelSource per model bucket', () => {
    // Arrange
    const entries = [
      entry({ model: 'gpt-5.1-codex', modelSource: 'config' }),
      entry({ model: 'gpt-5.1-codex', modelSource: 'config' }),
      entry({ model: 'gpt-5.1-codex', modelSource: 'override' }),
      entry({ model: 'o4-mini', modelSource: 'event' }),
    ]

    // Act
    const agg = aggregate(entries)

    // Assert
    expect(agg.byModel['gpt-5.1-codex'].sources).toEqual({ event: 0, override: 1, config: 2 })
    expect(agg.byModel['o4-mini'].sources).toEqual({ event: 1, override: 0, config: 0 })
  })

  test('omits sources entirely for a bucket whose entries recorded no provenance', () => {
    const agg = aggregate([entry({ model: 'legacy-model' })])

    expect(agg.byModel['legacy-model'].sources).toBeUndefined()
    expect(Object.hasOwn(agg.byModel['legacy-model'], 'sources')).toBe(false)
  })

  test('counts only the entries that carry a provenance in a mixed bucket', () => {
    const agg = aggregate([
      entry({ model: 'm', modelSource: 'config' }),
      entry({ model: 'm' }), // legacy line, no modelSource
    ])

    expect(agg.byModel.m.runs).toBe(2)
    expect(agg.byModel.m.sources).toEqual({ event: 0, override: 0, config: 1 })
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

  test.each(['__proto__', 'constructor', 'prototype'])(
    'rejects %s as a model name so it can never become a bucket key',
    (unsafe) => {
      expect(isValidMetricEntry({ ...entry(), model: unsafe })).toBe(false)
    },
  )

  test('a prototype-polluting model name is counted invalid and leaves Object.prototype alone', () => {
    // Arrange
    const logPath = mkLog()
    writeFileSync(
      logPath,
      [
        JSON.stringify({ ...entry(), model: '__proto__' }),
        JSON.stringify(entry({ sessionId: 'good', model: 'gpt-5.1-codex' })),
      ].join('\n') + '\n',
    )

    // Act
    const result = readMetricsDetailed({ logPath })
    const agg = aggregate(result.entries)

    // Assert
    expect(result.entries.map((e) => e.sessionId)).toEqual(['good'])
    expect(result.invalidLines).toBe(1)
    expect(Object.keys(agg.byModel)).toEqual(['gpt-5.1-codex'])
    expect(({} as Record<string, unknown>).runs).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('runs')
  })

  test('aggregating a __proto__ tool name does not pollute Object.prototype', () => {
    // Arrange — `tool` only has to be a non-empty string, so this key can reach the bucket store.
    const agg = aggregate([entry({ tool: '__proto__' })])

    // Assert
    expect(agg.byTool['__proto__']).toMatchObject({ runs: 1 })
    expect(({} as Record<string, unknown>).runs).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('runs')
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

describe('isValidMetricEntry', () => {
  test('accepts a legacy line carrying only the original required fields', () => {
    // Arrange — no errorCount/errorKind/runId/model, as written before T5 telemetry.
    const legacy = {
      ts: '2026-07-16T00:00:00Z',
      tool: 'codex_execute',
      cwd: '/w/one',
      sessionId: 'sess-1',
      exitCode: 0,
      durationMs: 1000,
      usage: null,
    }

    // Act / Assert
    expect(isValidMetricEntry(legacy)).toBe(true)
  })

  test('accepts an entry carrying a model with each valid modelSource', () => {
    for (const modelSource of ['event', 'override', 'config']) {
      expect(isValidMetricEntry({ ...entry(), model: 'gpt-5.1-codex', modelSource })).toBe(true)
    }
  })

  test.each([
    ['non-record JSON value', 42],
    ['array instead of object', [entry()]],
    ['missing ts', { ...entry(), ts: undefined }],
    ['unparseable ts', { ...entry(), ts: 'not-a-date' }],
    ['empty tool', { ...entry(), tool: '' }],
    ['non-string cwd', { ...entry(), cwd: 7 }],
    ['non-integer exitCode', { ...entry(), exitCode: 1.5 }],
    ['negative durationMs', { ...entry(), durationMs: -1 }],
    ['non-finite durationMs', { ...entry(), durationMs: Number.POSITIVE_INFINITY }],
    ['negative token count', { ...entry(), usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }],
    ['non-numeric token count', { ...entry(), usage: { inputTokens: '10', cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }],
    ['usage missing a token field', { ...entry(), usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 } }],
    ['empty model', { ...entry(), model: '' }],
    ['non-string model', { ...entry(), model: 3 }],
    ['unknown modelSource', { ...entry(), model: 'gpt-5', modelSource: 'guess' }],
    ['negative errorCount', { ...entry(), errorCount: -2 }],
    ['non-string errorKind', { ...entry(), errorKind: 4 }],
    ['non-boolean timedOut', { ...entry(), timedOut: 'yes' }],
    ['non-boolean aborted', { ...entry(), aborted: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(isValidMetricEntry(value)).toBe(false)
  })
})

describe('readMetricsDetailed', () => {
  test('counts invalid JSON and invalid-shape lines while keeping the valid ones', () => {
    // Arrange
    const logPath = mkLog()
    writeFileSync(
      logPath,
      [
        JSON.stringify(entry({ sessionId: 'good1' })),
        '{not json',
        '42',
        JSON.stringify({ ...entry(), durationMs: -5 }),
        JSON.stringify({ ...entry(), model: '' }),
        JSON.stringify(entry({ sessionId: 'good2' })),
        '',
      ].join('\n'),
    )

    // Act
    const result = readMetricsDetailed({ logPath })

    // Assert
    expect(result.entries.map((e) => e.sessionId)).toEqual(['good1', 'good2'])
    expect(result.invalidLines).toBe(4)
  })

  test('sums invalid lines across the rotated and live files', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, ['nope', JSON.stringify(entry({ sessionId: 'old' }))].join('\n') + '\n')
    writeFileSync(logPath, ['{"tool":"codex_execute"}', JSON.stringify(entry({ sessionId: 'new' }))].join('\n') + '\n')

    const result = readMetricsDetailed({ logPath })

    expect(result.entries.map((e) => e.sessionId)).toEqual(['old', 'new'])
    expect(result.invalidLines).toBe(2)
  })

  test('reports the rotation notice when the .1 back-file exists', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, JSON.stringify(entry({ sessionId: 'rotated' })) + '\n')
    writeFileSync(logPath, JSON.stringify(entry({ sessionId: 'live' })) + '\n')

    const result = readMetricsDetailed({ logPath })

    expect(result.rotationNotice).toBe('metrics: history older than one rotation is not retained')
    expect(result.rotationNotice).toBe(ROTATION_NOTICE)
  })

  test('omits the rotation notice when no .1 back-file exists', () => {
    const logPath = mkLog()
    writeFileSync(logPath, JSON.stringify(entry()) + '\n')

    const result = readMetricsDetailed({ logPath })

    expect(result.rotationNotice).toBeUndefined()
    expect(Object.hasOwn(result, 'rotationNotice')).toBe(false)
  })

  test('reports zero invalid lines and no notice for a missing log', () => {
    const logPath = mkLog()

    expect(readMetricsDetailed({ logPath })).toEqual({ entries: [], invalidLines: 0 })
  })
})

describe('readMetricsDetailed read failures (IMP-9)', () => {
  /** A path that exists but can never be read as a file: a directory (EISDIR). */
  const mkUnreadablePath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-unreadable-'))
    tempDirs.push(dir)
    return dir
  }

  test('reports an unreadable live log instead of passing it off as empty', () => {
    // Arrange
    const logPath = mkUnreadablePath()

    // Act
    const result = readMetricsDetailed({ logPath })

    // Assert
    expect(result.entries).toEqual([])
    expect(result.readErrors).toHaveLength(1)
    expect(result.readErrors?.[0]).toContain(`unable to read metrics log ${logPath}: `)
  })

  test('keeps the live entries when only the rotated file is unreadable', () => {
    // Arrange — <dir>/rotated is the live log; <dir>/rotated.1 is a directory.
    const dir = mkUnreadablePath()
    const logPath = join(dir, 'rotated')
    mkdirSync(`${logPath}.1`)
    writeFileSync(logPath, JSON.stringify(entry({ sessionId: 'live' })) + '\n')

    // Act
    const result = readMetricsDetailed({ logPath })

    // Assert
    expect(result.entries.map((e) => e.sessionId)).toEqual(['live'])
    expect(result.readErrors).toHaveLength(1)
    expect(result.readErrors?.[0]).toContain(`${logPath}.1`)
  })

  test('omits readErrors entirely when every read succeeds', () => {
    const logPath = mkLog()
    writeFileSync(logPath, JSON.stringify(entry()) + '\n')

    const result = readMetricsDetailed({ logPath })

    expect(result.readErrors).toBeUndefined()
    expect(Object.hasOwn(result, 'readErrors')).toBe(false)
  })

  test('a missing log is not a read failure', () => {
    const result = readMetricsDetailed({ logPath: mkLog() })

    expect(result.readErrors).toBeUndefined()
  })

  test('readMetrics keeps its bare-array contract on an unreadable log', () => {
    const entries = readMetrics({ logPath: mkUnreadablePath() })

    expect(entries).toEqual([])
  })
})

describe('readMetrics backward compatibility', () => {
  test('still returns a bare entries array, rotated file first', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, JSON.stringify(entry({ sessionId: 'rotated-old' })) + '\n')
    writeFileSync(logPath, ['garbage', JSON.stringify(entry({ sessionId: 'live-new' }))].join('\n') + '\n')

    const entries = readMetrics({ logPath })

    expect(Array.isArray(entries)).toBe(true)
    expect(entries.map((e) => e.sessionId)).toEqual(['rotated-old', 'live-new'])
  })
})

describe('parsePricing rate validation', () => {
  const withRate = (key: string, value: unknown): string =>
    JSON.stringify({ inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1, reasoningOutputPer1M: 1, [key]: value })

  test.each(['inputPer1M', 'cachedInputPer1M', 'outputPer1M', 'reasoningOutputPer1M'])(
    'rejects a negative %s',
    (key) => {
      expect(parsePricing(withRate(key, -0.5))).toBeUndefined()
    },
  )

  test('rejects an infinite rate (JSON 1e999 parses to Infinity)', () => {
    expect(parsePricing('{"inputPer1M":1e999,"cachedInputPer1M":1,"outputPer1M":1,"reasoningOutputPer1M":1}')).toBeUndefined()
  })

  // JSON has no NaN literal, so a NaN rate can only arrive as the bare token (invalid JSON) or as
  // the string "NaN"; both must yield undefined rather than a NaN-poisoned cost.
  test('rejects a NaN rate in either form it can arrive as', () => {
    expect(parsePricing('{"inputPer1M":NaN,"cachedInputPer1M":1,"outputPer1M":1,"reasoningOutputPer1M":1}')).toBeUndefined()
    expect(parsePricing(withRate('inputPer1M', 'NaN'))).toBeUndefined()
  })

  test('rejects a non-numeric rate', () => {
    expect(parsePricing(withRate('outputPer1M', '2'))).toBeUndefined()
    expect(parsePricing(withRate('outputPer1M', null))).toBeUndefined()
  })

  test('accepts zero rates', () => {
    expect(parsePricing(withRate('cachedInputPer1M', 0))).toEqual({
      inputPer1M: 1,
      cachedInputPer1M: 0,
      outputPer1M: 1,
      reasoningOutputPer1M: 1,
    })
  })
})
