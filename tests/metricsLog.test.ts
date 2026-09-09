import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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
  rotateMetricsLog,
  rotationNoticeFor,
  ROTATION_NOTICE_TEMPLATE,
  withFileLock,
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

  test('omits the rotation notice when only the .1 back-file exists (nothing is missing)', () => {
    const logPath = mkLog()
    writeFileSync(`${logPath}.1`, JSON.stringify(entry({ sessionId: 'rotated' })) + '\n')
    writeFileSync(logPath, JSON.stringify(entry({ sessionId: 'live' })) + '\n')

    const result = readMetricsDetailed({ logPath })

    expect(result.rotationNotice).toBeUndefined()
    expect(result.entries.map((e) => e.sessionId)).toEqual(['rotated', 'live'])
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

    expect(readMetricsDetailed({ logPath })).toEqual({
      entries: [],
      invalidLines: 0,
      historyFiles: 0,
      historyExcluded: false,
    })
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

const mkTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Isolated log + locks + history triple, so rotation never touches the operator's real dirs. */
const mkRotationEnv = (): { logPath: string; locksDir: string; historyDir: string } => {
  const dir = mkTempDir('codex-metrics-rot-')
  return {
    logPath: join(dir, 'metrics.jsonl'),
    locksDir: join(dir, 'locks'),
    historyDir: join(dir, 'history'),
  }
}

const writeLines = (path: string, entries: readonly MetricEntry[]): void => {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const sessionIds = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).sessionId as string)

/** Backdate a lock file so it reads as abandoned; future-date it so it reads as live. */
const setMtime = (path: string, offsetMs: number): void => {
  const when = new Date(Date.now() + offsetMs)
  utimesSync(path, when, when)
}

describe('withFileLock (R6.1)', () => {
  test('holds an O_EXCL lock file for the callback and releases it afterwards', () => {
    // Arrange
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')

    // Act
    let heldDuringCallback = false
    const result = withFileLock(lockPath, () => {
      heldDuringCallback = existsSync(lockPath)
      return 'ran'
    })

    // Assert
    expect(heldDuringCallback).toBe(true)
    expect(result).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('releases the lock when the callback throws', () => {
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')

    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('breaks a lock left behind by a crashed holder (older than staleMs)', () => {
    // Arrange — a lock file from a process that died without releasing it.
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')
    writeFileSync(lockPath, '999999\n')
    setMtime(lockPath, -60_000)

    // Act / Assert
    expect(withFileLock(lockPath, () => 'ran', { staleMs: 5_000, retryMs: 5 })).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('does not break an old lock while its holder pid is still alive', () => {
    // Arrange — an aged lock held by a process that is demonstrably running (this one). Age alone
    // must not be treated as a crash: nothing refreshes the lock mtime, so a slow live rotation
    // would otherwise be stolen and two processes would archive at once.
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')
    writeFileSync(lockPath, `${process.pid}\n`)
    setMtime(lockPath, -60_000)

    // Act / Assert
    expect(() => withFileLock(lockPath, () => 'ran', { staleMs: 30, retryMs: 5 })).toThrow(
      /is held by another process/,
    )
    expect(existsSync(lockPath)).toBe(true)
  })

  test('breaks an old lock whose holder pid is dead', () => {
    // Arrange — an aged lock naming a pid no longer running.
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')
    writeFileSync(lockPath, '4194303\n')
    setMtime(lockPath, -60_000)

    // Act / Assert
    expect(withFileLock(lockPath, () => 'ran', { staleMs: 30, retryMs: 5 })).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('breaks an old lock whose content names no parseable holder', () => {
    // Arrange — truncated/garbled lock content has no holder to probe, so age decides alone.
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')
    writeFileSync(lockPath, 'not-a-pid\n')
    setMtime(lockPath, -60_000)

    // Act / Assert
    expect(withFileLock(lockPath, () => 'ran', { staleMs: 30, retryMs: 5 })).toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('gives up instead of stealing a lock whose holder is still alive', () => {
    // Arrange — a future mtime never ages into staleness within the deadline.
    const lockPath = join(mkTempDir('codex-metrics-lock-'), 'metrics.lock')
    writeFileSync(lockPath, '1\n')
    setMtime(lockPath, 60_000)

    // Act / Assert
    expect(() => withFileLock(lockPath, () => 'ran', { staleMs: 30, retryMs: 5 })).toThrow(
      /is held by another process/,
    )
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe('rotateMetricsLog archive (R6.1)', () => {
  test('archives the previous back-file under its last entry UTC stamp, then rotates', () => {
    // Arrange
    const env = mkRotationEnv()
    writeLines(`${env.logPath}.1`, [
      entry({ ts: '2026-07-16T01:02:03Z', sessionId: 'old-first' }),
      entry({ ts: '2026-07-16T04:05:06.789Z', sessionId: 'old-last' }),
    ])
    writeLines(env.logPath, [entry({ sessionId: 'current' })])

    // Act
    rotateMetricsLog(env.logPath, { locksDir: env.locksDir })

    // Assert
    const archive = join(env.historyDir, 'metrics-20260716-040506.jsonl')
    expect(readdirSync(env.historyDir)).toEqual(['metrics-20260716-040506.jsonl'])
    expect(sessionIds(archive)).toEqual(['old-first', 'old-last'])
    expect(sessionIds(`${env.logPath}.1`)).toEqual(['current'])
    expect(existsSync(env.logPath)).toBe(false)
  })

  test('appends a -2 collision suffix instead of overwriting an existing archive', () => {
    // Arrange — three rotations whose back-files all carry the same last-entry second.
    const env = mkRotationEnv()
    for (const sessionId of ['a', 'b', 'c']) {
      writeLines(env.logPath, [entry({ ts: '2026-07-16T01:02:03Z', sessionId })])
      rotateMetricsLog(env.logPath, { locksDir: env.locksDir })
    }

    // Assert — 'a' and 'b' are archived side by side; 'c' is the current back-file.
    expect(readdirSync(env.historyDir).sort()).toEqual([
      'metrics-20260716-010203-2.jsonl',
      'metrics-20260716-010203.jsonl',
    ])
    expect(sessionIds(join(env.historyDir, 'metrics-20260716-010203.jsonl'))).toEqual(['a'])
    expect(sessionIds(join(env.historyDir, 'metrics-20260716-010203-2.jsonl'))).toEqual(['b'])
    expect(sessionIds(`${env.logPath}.1`)).toEqual(['c'])
  })

  test('archives a back-file with no readable entry rather than deleting it', () => {
    // Arrange
    const env = mkRotationEnv()
    writeFileSync(`${env.logPath}.1`, 'not json at all\n')
    writeLines(env.logPath, [entry({ sessionId: 'current' })])

    // Act
    rotateMetricsLog(env.logPath, { locksDir: env.locksDir })

    // Assert — stamped from its mtime, content preserved byte for byte.
    const archived = readdirSync(env.historyDir)
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatch(/^metrics-\d{8}-\d{6}\.jsonl$/)
    expect(readFileSync(join(env.historyDir, archived[0]), 'utf8')).toBe('not json at all\n')
  })

  test('does not rotate a log that is still below the cap, or one that does not exist', () => {
    const env = mkRotationEnv()
    writeFileSync(env.logPath, 'x')

    rotateMetricsLog(env.logPath, { locksDir: env.locksDir, maxBytes: 1024 })
    expect(existsSync(`${env.logPath}.1`)).toBe(false)

    const missing = mkRotationEnv()
    expect(() => rotateMetricsLog(missing.logPath, { locksDir: missing.locksDir })).not.toThrow()
    expect(existsSync(`${missing.logPath}.1`)).toBe(false)
  })

  test('a crash between the two renames is recovered by the next append with no line lost', () => {
    // Arrange — a rename that dies exactly once, right after the archive step succeeded.
    const env = mkRotationEnv()
    writeLines(`${env.logPath}.1`, [entry({ ts: '2026-07-16T01:02:03Z', sessionId: 'old' })])
    writeLines(env.logPath, [entry({ sessionId: 'live' })])
    let calls = 0
    const crashingRename = (from: string, to: string): void => {
      calls += 1
      if (calls === 2) throw new Error('crash between renames')
      renameSync(from, to)
    }

    // Act — the archive lands, the second rename dies, so no `.1` remains.
    expect(() =>
      rotateMetricsLog(env.logPath, { locksDir: env.locksDir, rename: crashingRename }),
    ).toThrow('crash between renames')
    expect(readdirSync(env.historyDir)).toHaveLength(1)
    expect(existsSync(`${env.logPath}.1`)).toBe(false)

    // Act — the next append detects the missing `.1` and proceeds.
    const written = appendMetric(entry({ sessionId: 'after-recovery' }), {
      logPath: env.logPath,
      locksDir: env.locksDir,
      maxBytes: 1,
    })

    // Assert — every line ever written is still readable, in order.
    expect(written).toBe(true)
    const all = readMetricsDetailed({ logPath: env.logPath, includeHistory: true })
    expect(all.entries.map((e) => e.sessionId)).toEqual(['old', 'live', 'after-recovery'])
    expect(readdirSync(env.historyDir)).toHaveLength(1)
  })

  test('a crash at the archive rename still lands the caller line and keeps the back-file', () => {
    // Arrange
    const env = mkRotationEnv()
    writeLines(`${env.logPath}.1`, [entry({ sessionId: 'old' })])
    writeLines(env.logPath, [entry({ sessionId: 'live' })])
    const failingRename = (): void => {
      throw new Error('archive rename failed')
    }

    // Act
    const written = appendMetric(entry({ sessionId: 'kept' }), {
      logPath: env.logPath,
      locksDir: env.locksDir,
      maxBytes: 1,
      rename: failingRename,
    })

    // Assert — rotation is best-effort, the line is not.
    expect(written).toBe(true)
    expect(sessionIds(env.logPath)).toEqual(['live', 'kept'])
    expect(sessionIds(`${env.logPath}.1`)).toEqual(['old'])
    // The dir is created before the rename is attempted; nothing was archived into it.
    expect(readdirSync(env.historyDir)).toEqual([])
  })

  test('recovers when the crashed rotation also left its lock file behind', () => {
    // Arrange — the exact on-disk state after a process was killed between the two renames:
    // the archive landed, no `.1` remains, and the abandoned lock file was never released.
    const env = mkRotationEnv()
    mkdirSync(env.historyDir, { recursive: true })
    writeLines(join(env.historyDir, 'metrics-20260716-010203.jsonl'), [
      entry({ sessionId: 'archived' }),
    ])
    writeLines(env.logPath, [entry({ sessionId: 'live' })])
    mkdirSync(env.locksDir, { recursive: true })
    const lockPath = join(env.locksDir, 'metrics.lock')
    writeFileSync(lockPath, '999999\n')
    setMtime(lockPath, -60_000)

    // Act
    const written = appendMetric(entry({ sessionId: 'after-recovery' }), {
      logPath: env.logPath,
      locksDir: env.locksDir,
      maxBytes: 1,
    })

    // Assert — the stale lock is reclaimed then released, and no line is lost.
    expect(written).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
    const all = readMetricsDetailed({ logPath: env.logPath, includeHistory: true })
    expect(all.entries.map((e) => e.sessionId)).toEqual(['archived', 'live', 'after-recovery'])
    expect(readdirSync(env.historyDir)).toHaveLength(1)
  })

  test('rotation is serialized: a held lock defers it and the line is still written', () => {
    // Arrange — another process holds ~/.codex-mcp/locks/metrics.lock and keeps it fresh.
    const env = mkRotationEnv()
    writeLines(env.logPath, [entry({ sessionId: 'live' })])
    mkdirSync(env.locksDir, { recursive: true })
    const lockPath = join(env.locksDir, 'metrics.lock')
    writeFileSync(lockPath, '1\n')
    setMtime(lockPath, 60_000)

    // Act
    const written = appendMetric(entry({ sessionId: 'queued' }), {
      logPath: env.logPath,
      locksDir: env.locksDir,
      maxBytes: 1,
      lock: { staleMs: 30, retryMs: 5 },
    })

    // Assert — no concurrent rotation, no lost line, the holder's lock untouched.
    expect(written).toBe(true)
    expect(existsSync(`${env.logPath}.1`)).toBe(false)
    expect(sessionIds(env.logPath)).toEqual(['live', 'queued'])
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe('readMetricsDetailed history (R6.2)', () => {
  /** History dir with two archives (plus a non-jsonl file that must be ignored). */
  const seedHistory = (env: { logPath: string; historyDir: string }): void => {
    mkdirSync(env.historyDir, { recursive: true })
    writeLines(join(env.historyDir, 'metrics-20260101-000000.jsonl'), [
      entry({ sessionId: 'h-oldest' }),
    ])
    writeLines(join(env.historyDir, 'metrics-20260202-000000.jsonl'), [
      entry({ sessionId: 'h-newer' }),
    ])
    writeFileSync(join(env.historyDir, 'README.txt'), 'not a metrics file\n')
  }

  test('includeHistory prepends archives oldest first; without it they are excluded', () => {
    // Arrange
    const env = mkRotationEnv()
    seedHistory(env)
    writeLines(`${env.logPath}.1`, [entry({ sessionId: 'rotated' })])
    writeLines(env.logPath, [entry({ sessionId: 'live' })])

    // Act
    const excluded = readMetricsDetailed({ logPath: env.logPath })
    const included = readMetricsDetailed({ logPath: env.logPath, includeHistory: true })

    // Assert
    expect(excluded.entries.map((e) => e.sessionId)).toEqual(['rotated', 'live'])
    expect(excluded.historyFiles).toBe(2)
    expect(excluded.historyExcluded).toBe(true)
    expect(included.entries.map((e) => e.sessionId)).toEqual([
      'h-oldest',
      'h-newer',
      'rotated',
      'live',
    ])
    expect(included.historyFiles).toBe(2)
    expect(included.historyExcluded).toBe(false)
  })

  test('reports the history notice naming the dir and the file count, in both modes', () => {
    // Arrange
    const env = mkRotationEnv()
    seedHistory(env)
    writeLines(env.logPath, [entry({ sessionId: 'live' })])

    // Act
    const result = readMetricsDetailed({ logPath: env.logPath })

    // Assert
    expect(result.rotationNotice).toBe(
      `metrics: history older than one rotation is in ${env.historyDir} (2 files)`,
    )
    expect(result.rotationNotice).toBe(rotationNoticeFor(env.historyDir, 2))
    expect(readMetricsDetailed({ logPath: env.logPath, includeHistory: true }).rotationNotice).toBe(
      result.rotationNotice,
    )
  })

  test('the notice template and its singular form stay literal (T6 mirror)', () => {
    // Arrange
    const env = mkRotationEnv()
    mkdirSync(env.historyDir, { recursive: true })
    writeLines(join(env.historyDir, 'metrics-20260101-000000.jsonl'), [entry()])

    // Assert — "files" is never pluralized away, so the two readers can be compared byte for byte.
    expect(ROTATION_NOTICE_TEMPLATE).toBe(
      'metrics: history older than one rotation is in <dir> (<n> files)',
    )
    expect(readMetricsDetailed({ logPath: env.logPath }).rotationNotice).toBe(
      `metrics: history older than one rotation is in ${env.historyDir} (1 files)`,
    )
  })

  test('counts invalid lines inside archives and skips a directory archive (IMP-44)', () => {
    // Arrange — one archive with a bad line, one archive path that is a directory (skipped since
    // IMP-44: it is not a regular file, so it is neither counted nor read for an EISDIR error).
    const env = mkRotationEnv()
    mkdirSync(env.historyDir, { recursive: true })
    writeFileSync(
      join(env.historyDir, 'metrics-20260101-000000.jsonl'),
      ['{not json', JSON.stringify(entry({ sessionId: 'h-good' }))].join('\n') + '\n',
    )
    mkdirSync(join(env.historyDir, 'metrics-20260202-000000.jsonl'))
    writeLines(env.logPath, [entry({ sessionId: 'live' })])

    // Act
    const result = readMetricsDetailed({ logPath: env.logPath, includeHistory: true })

    // Assert
    expect(result.entries.map((e) => e.sessionId)).toEqual(['h-good', 'live'])
    expect(result.invalidLines).toBe(1)
    expect(result.readErrors).toBeUndefined()
    expect(result.historyFiles).toBe(1)
    expect(result.rotationNotice).toBe(rotationNoticeFor(env.historyDir, 1))
  })

  test('skips a symlinked archive instead of pulling foreign entries in (IMP-44)', () => {
    // Arrange — a link that resolves to a valid metrics file OUTSIDE history/ must not be read.
    const env = mkRotationEnv()
    const outside = mkTempDir('codex-metrics-foreign-')
    const foreign = join(outside, 'foreign.jsonl')
    writeLines(foreign, [entry({ sessionId: 'foreign' })])
    mkdirSync(env.historyDir, { recursive: true })
    symlinkSync(foreign, join(env.historyDir, 'metrics-20260404-000000.jsonl'))
    writeLines(env.logPath, [entry({ sessionId: 'live' })])

    // Act
    const result = readMetricsDetailed({ logPath: env.logPath, includeHistory: true })

    // Assert
    expect(result.entries.map((e) => e.sessionId)).toEqual(['live'])
    expect(result.historyFiles).toBe(0)
    expect(result.readErrors).toBeUndefined()
    expect(result.rotationNotice).toBeUndefined()
  })

  test('reports a history dir that exists but cannot be listed', () => {
    // Arrange — a plain FILE where the history dir belongs (ENOTDIR on readdir).
    const dir = mkTempDir('codex-metrics-hist-')
    const logPath = join(dir, 'metrics.jsonl')
    const historyDir = join(dir, 'history')
    writeFileSync(historyDir, 'x')
    writeLines(logPath, [entry({ sessionId: 'live' })])

    // Act
    const result = readMetricsDetailed({ logPath, includeHistory: true })

    // Assert — the archives are unknown, not assumed absent.
    expect(result.entries.map((e) => e.sessionId)).toEqual(['live'])
    expect(result.readErrors).toEqual([
      expect.stringContaining(`unable to read metrics history dir ${historyDir}: `),
    ])
    expect(result.historyFiles).toBe(0)
    expect(result.historyExcluded).toBe(false)
  })

  test('readMetrics keeps its signature and ignores history entirely', () => {
    // Arrange
    const env = mkRotationEnv()
    seedHistory(env)
    writeLines(env.logPath, [entry({ sessionId: 'live' })])

    // Act
    const entries = readMetrics({ logPath: env.logPath })

    // Assert
    expect(entries.map((e) => e.sessionId)).toEqual(['live'])
  })
})

describe('aggregate completeness (R6.3)', () => {
  const pricedTable: Record<string, ModelCostRates> = {
    'gpt-5.1-codex': { inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1, reasoningOutputPer1M: 1 },
  }

  test('is complete when every run is priced and nothing was excluded', () => {
    // Arrange / Act
    const agg = aggregate([entry({ model: 'gpt-5.1-codex' })], {}, undefined, pricedTable)

    // Assert
    expect(agg.completeness).toEqual({
      complete: true,
      unpricedRuns: 0,
      missingUsage: 0,
      readErrors: 0,
      historyExcluded: false,
    })
  })

  test('an empty roll-up is complete', () => {
    expect(aggregate([]).completeness.complete).toBe(true)
  })

  test('counts runs with usage but no priced model as unpriced', () => {
    // Arrange — one unknown model, one legacy line with no model at all.
    const agg = aggregate([entry({ model: 'mystery' }), entry()], {}, undefined, pricedTable)

    // Assert
    expect(agg.completeness.unpricedRuns).toBe(2)
    expect(agg.completeness.missingUsage).toBe(0)
    expect(agg.completeness.complete).toBe(false)
  })

  test('counts entries written with usage: null as missing usage, not unpriced', () => {
    const agg = aggregate([entry({ usage: null, model: 'gpt-5.1-codex' })], {}, undefined, pricedTable)

    expect(agg.completeness).toEqual({
      complete: false,
      unpricedRuns: 0,
      missingUsage: 1,
      readErrors: 0,
      historyExcluded: false,
    })
  })

  test('forwards the read diagnostics the entries cannot express', () => {
    const agg = aggregate([entry({ model: 'gpt-5.1-codex' })], {}, undefined, pricedTable, {
      readErrors: 2,
      historyExcluded: true,
    })

    expect(agg.completeness).toEqual({
      complete: false,
      unpricedRuns: 0,
      missingUsage: 0,
      readErrors: 2,
      historyExcluded: true,
    })
  })

  test.each([
    ['a read error alone', { readErrors: 1 }, { readErrors: 1, historyExcluded: false }],
    ['excluded history alone', { historyExcluded: true }, { readErrors: 0, historyExcluded: true }],
  ])('is incomplete on %s', (_label, diagnostics, expected) => {
    const agg = aggregate([entry({ model: 'gpt-5.1-codex' })], {}, undefined, pricedTable, diagnostics)

    expect(agg.completeness).toEqual({
      complete: false,
      unpricedRuns: 0,
      missingUsage: 0,
      ...expected,
    })
  })

  test('counts only entries that pass the filters', () => {
    // Arrange — the filtered-out entry also has null usage and must not be counted.
    const agg = aggregate(
      [entry({ usage: null, tool: 'codex_review' }), entry({ usage: null })],
      { tool: 'codex_execute' },
    )

    // Assert
    expect(agg.totalRuns).toBe(1)
    expect(agg.completeness.missingUsage).toBe(1)
  })

  test('a detailed read feeds its own diagnostics straight into completeness', () => {
    // Arrange
    const env = mkRotationEnv()
    mkdirSync(env.historyDir, { recursive: true })
    writeLines(join(env.historyDir, 'metrics-20260101-000000.jsonl'), [entry()])
    writeLines(env.logPath, [entry({ model: 'gpt-5.1-codex' })])

    // Act
    const read = readMetricsDetailed({ logPath: env.logPath })
    const agg = aggregate(read.entries, {}, undefined, pricedTable, {
      readErrors: read.readErrors?.length ?? 0,
      historyExcluded: read.historyExcluded,
    })

    // Assert
    expect(agg.completeness).toEqual({
      complete: false,
      unpricedRuns: 0,
      missingUsage: 0,
      readErrors: 0,
      historyExcluded: true,
    })
  })
})
