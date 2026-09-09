import { afterEach, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  aggregateEntries,
  describeHistoryDir,
  filterEntries,
  historyDirFor,
  isFailedEntry as scriptIsFailedEntry,
  parseArgs,
  readEntries,
  readEntriesDetailed,
  renderMarkdown,
  resolveLogPath,
  resolvePricing,
  rotationNotice,
  rotationNoticeFor,
  ROTATION_NOTICE_TEMPLATE,
} from '../scripts/session-cost.mjs'
import {
  isFailedEntry as serverIsFailedEntry,
  ROTATION_NOTICE_TEMPLATE as serverRotationNoticeTemplate,
  type MetricEntry,
} from '../src/metricsLog.js'

interface Usage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

interface Entry {
  ts: string
  tool: string
  cwd: string
  sessionId: string | null
  exitCode: number | null
  durationMs: number
  usage: Usage | null
  model?: string
  modelSource?: string
  errorKind?: string
  errorCount?: number
  timedOut?: boolean
  aborted?: boolean
}

const PRICING = { inputPer1M: 2, cachedInputPer1M: 1, outputPer1M: 4, reasoningOutputPer1M: 8 }

const tempDirs: string[] = []
const SESSION_COST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'session-cost.mjs')

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const makeTempLogPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'session-cost-'))
  tempDirs.push(directory)
  return join(directory, 'metrics.jsonl')
}

const makeEntry = (overrides: Partial<Entry> = {}): Entry => ({
  ts: '2026-07-23T10:00:00.000Z',
  tool: 'codex_execute',
  cwd: '/workspace/project',
  sessionId: 'session-1',
  exitCode: 0,
  durationMs: 100,
  usage: {
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 4,
    reasoningOutputTokens: 2,
  },
  model: 'gpt-5',
  ...overrides,
})

describe('parseArgs', () => {
  test('parses valid value flags', () => {
    const args = parseArgs([
      '--since',
      '2026-07-23T09:00:00Z',
      '--until',
      '2026-07-23T11:00:00Z',
      '--cwd',
      '/workspace/project',
      '--log',
      '/tmp/metrics.jsonl',
    ])

    expect(args).toEqual({
      since: '2026-07-23T09:00:00Z',
      until: '2026-07-23T11:00:00Z',
      cwd: '/workspace/project',
      log: '/tmp/metrics.jsonl',
      json: false,
      history: false,
    })
  })

  test('throws when --since is missing or invalid', () => {
    expect(() => parseArgs([])).toThrow(/--since/)
    expect(() => parseArgs(['--since', 'not-a-date'])).toThrow(/valid ISO date/)
    expect(() => parseArgs(['--since', 'July 23, 2026'])).toThrow(/valid ISO date/)
    expect(() => parseArgs(['--since', '2026-02-30T00:00:00Z'])).toThrow(/valid ISO date/)
  })

  test('accepts a plain ISO calendar date', () => {
    const args = parseArgs(['--since', '2026-07-23'])

    expect(args.since).toBe('2026-07-23')
  })

  test('parses the --json flag', () => {
    const args = parseArgs(['--since', '2026-07-23T09:00:00Z', '--json'])

    expect(args.json).toBe(true)
  })
})

describe('CLI', () => {
  test('reads the env log and pricing and emits a JSON aggregate', () => {
    const logPath = makeTempLogPath()
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)
    const pricing = JSON.stringify({
      inputPer1M: 2,
      cachedInputPer1M: 1,
      outputPer1M: 4,
      reasoningOutputPer1M: 8,
    })

    const result = spawnSync(process.execPath, [SESSION_COST_SCRIPT, '--since', '2026-07-23', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_MCP_METRICS_LOG: logPath,
        CODEX_MCP_PRICING: pricing,
      },
    })

    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as { totalRuns: number; estimatedCostUsd?: number }
    expect(output.totalRuns).toBe(1)
    expect(output.estimatedCostUsd).toBe(0.000039)
  })

  test('emits the totals table in default Markdown mode', () => {
    const logPath = makeTempLogPath()
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    const result = spawnSync(process.execPath, [SESSION_COST_SCRIPT, '--since', '2026-07-23'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_MCP_METRICS_LOG: logPath },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| Metric | Value |')
  })
})

describe('resolveLogPath', () => {
  test('prefers the explicit log argument over the environment', () => {
    expect(resolveLogPath({ log: '/args/metrics.jsonl' }, { CODEX_MCP_METRICS_LOG: '/env/metrics.jsonl' })).toBe(
      '/args/metrics.jsonl',
    )
  })

  test('uses the environment path when the log argument is absent', () => {
    expect(resolveLogPath({}, { CODEX_MCP_METRICS_LOG: '/env/metrics.jsonl' })).toBe('/env/metrics.jsonl')
  })

  test('uses the home-directory default when no override exists', () => {
    expect(resolveLogPath({}, {})).toBe(join(homedir(), '.codex-mcp', 'metrics.jsonl'))
  })
})

describe('resolvePricing', () => {
  test('returns valid pricing from the environment', () => {
    const pricing = {
      inputPer1M: 2,
      cachedInputPer1M: 1,
      outputPer1M: 4,
      reasoningOutputPer1M: 8,
    }

    expect(resolvePricing({ CODEX_MCP_PRICING: JSON.stringify(pricing) })).toEqual(pricing)
  })

  test('returns undefined for malformed pricing', () => {
    expect(resolvePricing({ CODEX_MCP_PRICING: '{broken' })).toBeUndefined()
  })

  test('returns undefined when pricing is absent', () => {
    expect(resolvePricing({})).toBeUndefined()
  })
})

describe('filterEntries', () => {
  test('filters by inclusive since and until boundaries and exact cwd', () => {
    const entries = [
      makeEntry({ ts: '2026-07-23T09:00:00Z' }),
      makeEntry({ ts: '2026-07-23T10:00:00Z', cwd: '/workspace/other' }),
      makeEntry({ ts: '2026-07-23T11:00:00Z' }),
      makeEntry({ ts: '2026-07-23T11:00:00.001Z' }),
    ]

    const filtered = filterEntries(entries, {
      since: '2026-07-23T09:00:00Z',
      until: '2026-07-23T11:00:00Z',
      cwd: '/workspace/project',
    })

    expect(filtered.map((entry: Entry) => entry.ts)).toEqual([
      '2026-07-23T09:00:00Z',
      '2026-07-23T11:00:00Z',
    ])
  })
})

describe('aggregateEntries', () => {
  test('aggregates totals, per-model values, per-tool runs, and failures', () => {
    const entries = [
      makeEntry(),
      makeEntry({
        tool: 'codex_review',
        exitCode: 1,
        errorKind: 'exit',
        durationMs: 200,
        usage: null,
      }),
      makeEntry({
        tool: 'codex_execute',
        model: 'gpt-5-mini',
        exitCode: 0,
        timedOut: true,
        durationMs: 300,
        usage: {
          inputTokens: 20,
          cachedInputTokens: 10,
          outputTokens: 8,
          reasoningOutputTokens: 4,
        },
      }),
      makeEntry({
        tool: 'codex_continue',
        model: undefined,
        exitCode: null,
        errorKind: 'abort',
        aborted: true,
        durationMs: 400,
        usage: null,
      }),
    ]

    const aggregate = aggregateEntries(entries)

    expect(aggregate).toMatchObject({
      totalRuns: 4,
      failed: 3,
      totalDurationMs: 1000,
      totalTokens: { input: 30, cachedInput: 15, output: 12, reasoningOutput: 6 },
      byTool: {
        codex_execute: { runs: 2 },
        codex_review: { runs: 1 },
        codex_continue: { runs: 1 },
      },
    })
    expect(aggregate.byModel).toEqual({
      'gpt-5': {
        runs: 2,
        failed: 1,
        totalDurationMs: 300,
        tokens: { input: 10, cachedInput: 5, output: 4, reasoningOutput: 2 },
      },
      'gpt-5-mini': {
        runs: 1,
        failed: 1,
        totalDurationMs: 300,
        tokens: { input: 20, cachedInput: 10, output: 8, reasoningOutput: 4 },
      },
    })
  })

  test('returns an empty aggregate for empty input', () => {
    expect(aggregateEntries([])).toEqual({
      totalRuns: 0,
      failed: 0,
      totalDurationMs: 0,
      totalTokens: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 },
      byModel: {},
      byTool: {},
      completeness: {
        complete: true,
        unpricedRuns: 0,
        missingUsage: 0,
        readErrors: 0,
        historyExcluded: false,
      },
    })
  })

  test('does not mutate input entries', () => {
    const entry = makeEntry()
    const original = structuredClone(entry)

    aggregateEntries([entry])

    expect(entry).toEqual(original)
  })

  test('calculates an exact flat-rate USD estimate', () => {
    const entry = makeEntry({
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 250_000,
        reasoningOutputTokens: 125_000,
      },
    })
    const pricing = {
      inputPer1M: 2,
      cachedInputPer1M: 1,
      outputPer1M: 4,
      reasoningOutputPer1M: 8,
    }

    const aggregate = aggregateEntries([entry], pricing)

    expect(aggregate.estimatedCostUsd).toBe(3)
  })

  test('clamps negative non-subset token counts to zero', () => {
    const entry = makeEntry({
      usage: {
        inputTokens: 100,
        cachedInputTokens: 200,
        outputTokens: 100,
        reasoningOutputTokens: 200,
      },
    })

    const aggregate = aggregateEntries([entry], {
      inputPer1M: 2,
      cachedInputPer1M: 1,
      outputPer1M: 4,
      reasoningOutputPer1M: 8,
    })

    expect(aggregate.estimatedCostUsd).toBe(0.0018)
  })
})

describe('readEntries', () => {
  test('skips malformed JSONL lines', () => {
    const logPath = makeTempLogPath()
    const entry = makeEntry()
    writeFileSync(logPath, `${JSON.stringify(entry)}\nnot-json\n{"broken":\n`)

    const entries = readEntries(logPath)

    expect(entries).toEqual([entry])
  })

  test('merges the rotated file before the main file', () => {
    const logPath = makeTempLogPath()
    const older = makeEntry({ ts: '2026-07-23T09:00:00Z' })
    const newer = makeEntry({ ts: '2026-07-23T10:00:00Z' })
    writeFileSync(`${logPath}.1`, `${JSON.stringify(older)}\n`)
    writeFileSync(logPath, `${JSON.stringify(newer)}\n`)

    const entries = readEntries(logPath)

    expect(entries).toEqual([older, newer])
  })

  test('returns an empty aggregate when the log file is missing', () => {
    const logPath = makeTempLogPath()

    const aggregate = aggregateEntries(readEntries(logPath))

    expect(aggregate).toMatchObject({
      totalRuns: 0,
      failed: 0,
      totalDurationMs: 0,
      byModel: {},
      byTool: {},
    })
  })
})

describe('renderMarkdown', () => {
  test('renders totals, per-model, and per-tool tables with priced cost', () => {
    const aggregate = aggregateEntries([makeEntry()], {
      inputPer1M: 2,
      cachedInputPer1M: 1,
      outputPer1M: 4,
      reasoningOutputPer1M: 8,
    })

    const markdown = renderMarkdown(aggregate)

    expect(markdown).toContain('| Runs | 1 |')
    expect(markdown).toContain('| Model | Runs | Failed | Duration (ms) |')
    expect(markdown).toContain('| gpt-5 | 1 | 0 | 100 |')
    expect(markdown).toContain('| Tool | Runs |')
    expect(markdown).toContain('Estimated cost: $0.000039 (via CODEX_MCP_PRICING)')
  })

  test('renders the pricing guidance when pricing is absent', () => {
    const markdown = renderMarkdown(aggregateEntries([]))

    expect(markdown).toContain('Estimated cost: n/a (set CODEX_MCP_PRICING)')
  })

  test('replaces control characters in model names without breaking table rows', () => {
    const markdown = renderMarkdown(aggregateEntries([makeEntry({ model: 'gpt\n5' })]))

    expect(markdown).toContain('| gpt 5 | 1 | 0 | 100 |')
    expect(markdown).not.toContain('gpt\n5')
  })
})

describe('--session filter (R5.2)', () => {
  test('parseArgs collects repeatable --session values in order and de-duplicates', () => {
    const parsed = parseArgs(['--since', '2026-07-23', '--session', 'a', '--session', 'b', '--session', 'a'])

    expect(parsed.sessions).toEqual(['a', 'b'])
  })

  test('parseArgs rejects an empty or flag-like --session value', () => {
    expect(() => parseArgs(['--since', '2026-07-23', '--session', ''])).toThrow('--session requires a value')
    expect(() => parseArgs(['--since', '2026-07-23', '--session', '--json'])).toThrow('--session requires a value')
  })

  test('parseArgs without --session yields no sessions key so cwd filtering is unchanged', () => {
    const parsed = parseArgs(['--since', '2026-07-23', '--cwd', '/w'])

    expect(parsed.sessions).toBeUndefined()
    expect(parsed.cwd).toBe('/w')
  })

  test('filterEntries matches by sessionId and ignores cwd when sessions are given', () => {
    const entries = [
      makeEntry({ ts: '2026-07-23T09:00:00Z', sessionId: 'keep-1', cwd: '/worktree/a' }),
      makeEntry({ ts: '2026-07-23T09:30:00Z', sessionId: 'drop', cwd: '/workspace/project' }),
      makeEntry({ ts: '2026-07-23T10:00:00Z', sessionId: 'keep-2', cwd: '/worktree/b' }),
    ]

    const filtered = filterEntries(entries, { since: '2026-07-23T00:00:00Z', cwd: '/workspace/project', sessions: ['keep-1', 'keep-2'] })

    expect(filtered.map((entry) => entry.sessionId)).toEqual(['keep-1', 'keep-2'])
  })

  test('filterEntries with an empty sessions list behaves exactly like the cwd filter', () => {
    const entries = [makeEntry({ ts: '2026-07-23T09:00:00Z', cwd: '/workspace/project' }), makeEntry({ ts: '2026-07-23T09:00:00Z', cwd: '/other' })]

    const filtered = filterEntries(entries, { since: '2026-07-23T00:00:00Z', cwd: '/workspace/project', sessions: [] })

    expect(filtered).toHaveLength(1)
  })

  test('filterEntries rejects a non-array or non-string sessions option', () => {
    expect(() => filterEntries([], { since: '2026-07-23', sessions: 'x' as unknown as string[] })).toThrow(/sessions/)
  })
})

describe('session-report skill cost instructions (R5.3)', () => {
  const skillRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const skill = readFileSync(join(skillRepoRoot, 'skills', 'session-report', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')

  test('tells the orchestrator to pass every TASKS.md session id as --session and fall back to --cwd only without ids', () => {
    expect(skill).toContain('--session <id>')
    expect(skill).toContain('collect every Session id from TASKS.md')
    expect(skill).toContain('worktree runs included')
    expect(skill).toContain('only when no session ids exist')
  })
})

describe('metric shape rules (R7.2)', () => {
  test.each([
    ['an empty model', { model: '' }],
    ['a non-string model', { model: 5 }],
    ['an unknown modelSource', { model: 'gpt-5', modelSource: 'guess' }],
    ['an unparseable ts', { ts: 'not-a-date' }],
    ['an empty tool', { tool: '' }],
    ['a non-integer exitCode', { exitCode: 0.5 }],
    ['a negative durationMs', { durationMs: -1 }],
    ['a negative token count', { usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }],
  ])('readEntries skips a line with %s', (_label, overrides) => {
    // Arrange
    const logPath = makeTempLogPath()
    const good = makeEntry({ sessionId: 'keep' })
    writeFileSync(logPath, `${JSON.stringify({ ...makeEntry(), ...overrides })}\n${JSON.stringify(good)}\n`)

    // Act
    const entries = readEntries(logPath)

    // Assert
    expect(entries).toEqual([good])
  })

  test.each(['__proto__', 'constructor', 'prototype'])(
    'readEntries skips a line whose model is %s and leaves Object.prototype alone',
    (unsafe) => {
      // Arrange
      const logPath = makeTempLogPath()
      const good = makeEntry({ sessionId: 'keep', model: 'gpt-5.1-codex' })
      writeFileSync(logPath, `${JSON.stringify({ ...makeEntry(), model: unsafe })}\n${JSON.stringify(good)}\n`)

      // Act
      const entries = readEntries(logPath)
      const aggregate = aggregateEntries(entries)

      // Assert
      expect(entries).toEqual([good])
      expect(Object.keys(aggregate.byModel)).toEqual(['gpt-5.1-codex'])
      expect(Object.prototype).not.toHaveProperty('runs')
    },
  )

  test.each(['event', 'override', 'config'])('readEntries keeps a line whose modelSource is %s', (modelSource) => {
    const logPath = makeTempLogPath()
    const entry = { ...makeEntry(), modelSource }
    writeFileSync(logPath, `${JSON.stringify(entry)}\n`)

    expect(readEntries(logPath)).toEqual([entry])
  })

  test('readEntries keeps a legacy line with no model or telemetry fields', () => {
    const logPath = makeTempLogPath()
    const legacy = {
      ts: '2026-07-23T10:00:00.000Z',
      tool: 'codex_execute',
      cwd: '/workspace/project',
      sessionId: 'session-1',
      exitCode: 0,
      durationMs: 100,
      usage: null,
    }
    writeFileSync(logPath, `${JSON.stringify(legacy)}\n`)

    expect(readEntries(logPath)).toEqual([legacy])
  })
})

describe('readEntriesDetailed read failures (IMP-9)', () => {
  /** A path that exists but can never be read as a file: a directory (EISDIR). */
  const makeUnreadablePath = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'session-cost-unreadable-'))
    tempDirs.push(directory)
    return directory
  }

  test('reports an unreadable live log instead of passing it off as empty', () => {
    // Arrange
    const logPath = makeUnreadablePath()

    // Act
    const result = readEntriesDetailed(logPath) as { entries: unknown[]; readErrors: string[] }

    // Assert
    expect(result.entries).toEqual([])
    expect(result.readErrors).toHaveLength(1)
    expect(result.readErrors[0]).toContain(`unable to read metrics log ${logPath}: `)
  })

  test('keeps the live entries when only the rotated file is unreadable', () => {
    // Arrange
    const directory = makeUnreadablePath()
    const logPath = join(directory, 'metrics.jsonl')
    mkdirSync(`${logPath}.1`)
    const entry = makeEntry()
    writeFileSync(logPath, `${JSON.stringify(entry)}\n`)

    // Act
    const result = readEntriesDetailed(logPath) as { entries: unknown[]; readErrors: string[] }

    // Assert
    expect(result.entries).toEqual([entry])
    expect(result.readErrors).toHaveLength(1)
    expect(result.readErrors[0]).toContain(`${logPath}.1`)
  })

  test('reports no read errors for a missing or healthy log', () => {
    const missing = readEntriesDetailed(makeTempLogPath()) as { readErrors: string[] }
    const healthyPath = makeTempLogPath()
    writeFileSync(healthyPath, `${JSON.stringify(makeEntry())}\n`)
    const healthy = readEntriesDetailed(healthyPath) as { readErrors: string[] }

    expect(missing.readErrors).toEqual([])
    expect(healthy.readErrors).toEqual([])
  })

  test('readEntries rejects a non-string log path', () => {
    expect(() => readEntries(42)).toThrow(TypeError)
  })

  test('CLI discloses the unreadable file on stderr and exits non-zero', () => {
    // Arrange
    const directory = makeUnreadablePath()
    const logPath = join(directory, 'metrics.jsonl')
    mkdirSync(`${logPath}.1`)
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    // Act
    const result = spawnSync(process.execPath, [SESSION_COST_SCRIPT, '--since', '2026-07-23', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_MCP_METRICS_LOG: logPath },
    })

    // Assert — the partial report is still machine-readable, the gap is disclosed, exit is 1.
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`session-cost: unable to read metrics log ${logPath}.1: `)
    expect((JSON.parse(result.stdout) as { totalRuns: number }).totalRuns).toBe(1)
  })
})

/**
 * IMP-17: the script's predicate is the reference and src/metricsLog.ts mirrors it. Both are run
 * over one shared vector so a rule added to either side without the other fails here.
 */
describe('isFailedEntry parity between the script and src/metricsLog.ts (IMP-17)', () => {
  const vector: readonly [string, Partial<Entry>, boolean][] = [
    ['clean success', {}, false],
    ['non-zero exitCode', { exitCode: 2 }, true],
    ['null exitCode', { exitCode: null }, true],
    ['timedOut on exit 0', { timedOut: true }, true],
    ['aborted on exit 0', { aborted: true }, true],
    ['errorKind only on exit 0', { errorKind: 'turn-failed' }, true],
    ['empty-string errorKind', { errorKind: '' }, false],
    // IMP-28: Codex-reported errors on an exit-0 run are a failure on both sides.
    ['errorCount above zero on exit 0', { errorCount: 3 }, true],
    ['errorCount zero', { errorCount: 0 }, false],
    ['errorCount above zero with no errorKind', { errorCount: 1, errorKind: undefined }, true],
    ['both errorKind and non-zero exit', { exitCode: 1, errorKind: 'exit' }, true],
    ['explicit false flags', { timedOut: false, aborted: false }, false],
  ]

  test.each(vector)('%s → failed=%s in both predicates', (_label, overrides, expected) => {
    // Arrange
    const entry = makeEntry({ exitCode: 0, ...overrides })

    // Act & Assert
    expect(scriptIsFailedEntry(entry)).toBe(expected)
    expect(serverIsFailedEntry(entry as unknown as MetricEntry)).toBe(expected)
  })

  test('the script aggregate and the shared predicate agree on the failure count', () => {
    const entries = vector.map(([, overrides]) => makeEntry({ exitCode: 0, ...overrides }))
    const expectedFailures = vector.filter(([, , expected]) => expected).length

    expect((aggregateEntries(entries) as { failed: number }).failed).toBe(expectedFailures)
  })
})


/** Write one `history/<name>` archive next to `logPath`; returns the archive path. */
const writeArchive = (logPath: string, name: string, entries: readonly Entry[]): string => {
  const directory = historyDirFor(logPath) as string
  mkdirSync(directory, { recursive: true })
  const file = join(directory, name)
  writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  return file
}

const runScript = (args: readonly string[], logPath: string, pricing?: string) =>
  spawnSync(process.execPath, [SESSION_COST_SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_MCP_METRICS_LOG: logPath,
      ...(pricing === undefined ? {} : { CODEX_MCP_PRICING: pricing }),
    },
  })

describe('history archive reads (R6.2)', () => {
  test('parseArgs parses the --history flag and defaults it to false', () => {
    expect(parseArgs(['--since', '2026-07-23', '--history']).history).toBe(true)
    expect(parseArgs(['--since', '2026-07-23']).history).toBe(false)
  })

  test('includeHistory reads archives oldest first, before the rotated file and the live log', () => {
    // Arrange
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry({ sessionId: 'old' })])
    writeArchive(logPath, 'metrics-20260201-000000.jsonl', [makeEntry({ sessionId: 'newer' })])
    writeFileSync(`${logPath}.1`, `${JSON.stringify(makeEntry({ sessionId: 'rotated' }))}\n`)
    writeFileSync(logPath, `${JSON.stringify(makeEntry({ sessionId: 'live' }))}\n`)

    // Act
    const result = readEntriesDetailed(logPath, { includeHistory: true }) as {
      entries: Entry[]
      historyFiles: number
      historyExcluded: boolean
    }

    // Assert
    expect(result.entries.map((entry) => entry.sessionId)).toEqual(['old', 'newer', 'rotated', 'live'])
    expect(result.historyFiles).toBe(2)
    expect(result.historyExcluded).toBe(false)
  })

  test('without the flag archives are excluded but disclosed, never silently dropped', () => {
    // Arrange
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry({ sessionId: 'old' })])
    writeFileSync(logPath, `${JSON.stringify(makeEntry({ sessionId: 'live' }))}\n`)

    // Act
    const result = readEntriesDetailed(logPath) as {
      entries: Entry[]
      historyFiles: number
      historyExcluded: boolean
      rotationNotice: string
    }

    // Assert
    expect(result.entries.map((entry) => entry.sessionId)).toEqual(['live'])
    expect(result.historyExcluded).toBe(true)
    expect(result.historyFiles).toBe(1)
    expect(result.rotationNotice).toBe(
      `metrics: history older than one rotation is in ${historyDirFor(logPath)} (1 files)`,
    )
  })

  test('a log with no history dir reports no archives, no notice and no read error', () => {
    const logPath = makeTempLogPath()
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    const result = readEntriesDetailed(logPath) as {
      historyFiles: number
      historyExcluded: boolean
      rotationNotice?: string
      readErrors: string[]
    }

    expect(result).toMatchObject({ historyFiles: 0, historyExcluded: false, readErrors: [] })
    expect(result.rotationNotice).toBeUndefined()
  })

  test('an unreadable history dir is disclosed as a read error', () => {
    // Arrange — the history "dir" is a plain file, so readdir fails with ENOTDIR.
    const logPath = makeTempLogPath()
    writeFileSync(historyDirFor(logPath) as string, 'not a directory\n')
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    // Act
    const result = readEntriesDetailed(logPath, { includeHistory: true }) as { readErrors: string[] }

    // Assert
    expect(result.readErrors).toHaveLength(1)
    expect(result.readErrors[0]).toContain(
      `unable to read metrics history dir ${historyDirFor(logPath)}: `,
    )
  })

  test('non-.jsonl files in the history dir are ignored', () => {
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry({ sessionId: 'old' })])
    writeFileSync(join(historyDirFor(logPath) as string, 'README.md'), 'notes\n')

    const result = readEntriesDetailed(logPath, { includeHistory: true }) as {
      entries: Entry[]
      historyFiles: number
    }

    expect(result.historyFiles).toBe(1)
    expect(result.entries.map((entry) => entry.sessionId)).toEqual(['old'])
  })

  test('a directory named like an archive is skipped, not counted or read (IMP-44)', () => {
    // Arrange
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry({ sessionId: 'old' })])
    mkdirSync(join(historyDirFor(logPath) as string, 'metrics-20260301-000000.jsonl'))
    writeFileSync(logPath, `${JSON.stringify(makeEntry({ sessionId: 'live' }))}\n`)

    // Act
    const result = readEntriesDetailed(logPath, { includeHistory: true }) as {
      entries: Entry[]
      historyFiles: number
      readErrors: string[]
    }

    // Assert
    expect(result.historyFiles).toBe(1)
    expect(result.readErrors).toEqual([])
    expect(result.entries.map((entry) => entry.sessionId)).toEqual(['old', 'live'])
  })

  test('rejects a non-boolean includeHistory', () => {
    expect(() => readEntriesDetailed(makeTempLogPath(), { includeHistory: 'yes' })).toThrow(TypeError)
  })

  test('CLI --history includes the archived runs in the totals', () => {
    // Arrange
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry({ ts: '2026-07-23T08:00:00Z' })])
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    // Act
    const withHistory = runScript(['--since', '2026-07-23', '--json', '--history'], logPath)
    const withoutHistory = runScript(['--since', '2026-07-23', '--json'], logPath)

    // Assert
    expect(withHistory.status).toBe(0)
    expect((JSON.parse(withHistory.stdout) as { totalRuns: number }).totalRuns).toBe(2)
    expect((JSON.parse(withoutHistory.stdout) as { totalRuns: number }).totalRuns).toBe(1)
  })
})

describe('rotation notice (R6.2, R7.3)', () => {
  test('the template is byte-identical to the src/metricsLog.ts mirror', () => {
    expect(ROTATION_NOTICE_TEMPLATE).toBe(
      'metrics: history older than one rotation is in <dir> (<n> files)',
    )
    expect(ROTATION_NOTICE_TEMPLATE).toBe(serverRotationNoticeTemplate)
  })

  test('rotationNoticeFor never pluralizes away the word files', () => {
    expect(rotationNoticeFor('/logs/history', 1)).toBe(
      'metrics: history older than one rotation is in /logs/history (1 files)',
    )
  })

  test('returns the notice when the history dir holds an archive', () => {
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])

    expect(rotationNotice(logPath)).toEqual({
      notice: `metrics: history older than one rotation is in ${historyDirFor(logPath)} (1 files)`,
      readError: undefined,
    })
  })

  test('returns an undefined notice when no archive exists, even with a .1 back-file', () => {
    const logPath = makeTempLogPath()
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)
    writeFileSync(`${logPath}.1`, `${JSON.stringify(makeEntry())}\n`)

    expect(rotationNotice(logPath)).toEqual({ notice: undefined, readError: undefined })
  })

  test('surfaces a listing failure as readError instead of reporting no archives (IMP-45)', () => {
    // Arrange — the history "dir" is a plain file, so readdir fails with ENOTDIR.
    const logPath = makeTempLogPath()
    writeFileSync(historyDirFor(logPath) as string, 'not a directory\n')

    // Act
    const result = rotationNotice(logPath) as { notice?: string, readError?: string }

    // Assert
    expect(result.notice).toBeUndefined()
    expect(result.readError).toContain(
      `unable to read metrics history dir ${historyDirFor(logPath)}: `,
    )
  })

  test('rejects an empty log path', () => {
    expect(() => rotationNotice('')).toThrow(TypeError)
  })

  test('CLI prints the one-line notice on stderr and keeps --json stdout parseable', () => {
    // Arrange
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    // Act
    const result = runScript(['--since', '2026-07-23', '--json'], logPath)

    // Assert
    expect(result.status).toBe(0)
    expect(result.stderr.trim()).toBe(
      `metrics: history older than one rotation is in ${historyDirFor(logPath)} (1 files)`,
    )
    expect((JSON.parse(result.stdout) as { totalRuns: number }).totalRuns).toBe(1)
  })

  test('CLI prints the notice in Markdown mode too', () => {
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    const result = runScript(['--since', '2026-07-23'], logPath)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('metrics: history older than one rotation is in ')
  })

  test('CLI prints an unreadable history dir on stderr and fails the run (IMP-45)', () => {
    // Arrange — the history "dir" is a plain file, so readdir fails with ENOTDIR.
    const logPath = makeTempLogPath()
    writeFileSync(historyDirFor(logPath) as string, 'not a directory\n')
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    // Act
    const result = runScript(['--since', '2026-07-23'], logPath)

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      `session-cost: unable to read metrics history dir ${historyDirFor(logPath)}: `,
    )
  })

  test('CLI stays silent when no archive exists', () => {
    const logPath = makeTempLogPath()
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    const result = runScript(['--since', '2026-07-23'], logPath)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})

describe('completeness counters (R6.3)', () => {
  test('is complete when every priced run reported usage and nothing was excluded', () => {
    const aggregate = aggregateEntries([makeEntry()], PRICING) as { completeness: unknown }

    expect(aggregate.completeness).toEqual({
      complete: true,
      unpricedRuns: 0,
      missingUsage: 0,
      readErrors: 0,
      historyExcluded: false,
    })
  })

  test('counts runs with usage as unpriced when no pricing table is configured', () => {
    const aggregate = aggregateEntries([makeEntry(), makeEntry({ usage: null })]) as {
      completeness: { complete: boolean; unpricedRuns: number; missingUsage: number }
    }

    expect(aggregate.completeness).toMatchObject({ complete: false, unpricedRuns: 1, missingUsage: 1 })
  })

  test('counts entries written with usage: null as missing usage', () => {
    const aggregate = aggregateEntries([makeEntry({ usage: null })], PRICING) as {
      completeness: { complete: boolean; missingUsage: number }
    }

    expect(aggregate.completeness).toMatchObject({ complete: false, missingUsage: 1 })
  })

  test('carries the read-side diagnostics into the counters', () => {
    const aggregate = aggregateEntries([makeEntry()], PRICING, {
      readErrors: 2,
      historyExcluded: true,
    }) as { completeness: { complete: boolean; readErrors: number; historyExcluded: boolean } }

    expect(aggregate.completeness).toMatchObject({
      complete: false,
      readErrors: 2,
      historyExcluded: true,
    })
  })

  test('rejects malformed diagnostics instead of silently reporting complete', () => {
    expect(() => aggregateEntries([], PRICING, { readErrors: -1 })).toThrow(TypeError)
    expect(() => aggregateEntries([], PRICING, { historyExcluded: 'yes' })).toThrow(TypeError)
    expect(() => aggregateEntries([], PRICING, null)).toThrow(TypeError)
  })

  test('renders the Completeness section as the only addition below the cost line', () => {
    const markdown = renderMarkdown(
      aggregateEntries([makeEntry({ usage: null })], undefined, { historyExcluded: true }),
    ) as string

    expect(markdown.endsWith(
      [
        '',
        '## Completeness',
        '',
        '| Check | Value |',
        '| --- | ---: |',
        '| Complete | no |',
        '| Unpriced runs | 0 |',
        '| Missing usage | 1 |',
        '| Read errors | 0 |',
        '| History excluded | yes |',
      ].join('\n'),
    )).toBe(true)
  })

  test('renderMarkdown rejects an aggregate with no completeness block', () => {
    expect(() => renderMarkdown({ totalTokens: {}, byModel: {}, byTool: {} })).toThrow(TypeError)
  })

  test('CLI --json forwards the completeness block', () => {
    const logPath = makeTempLogPath()
    writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])
    writeFileSync(logPath, `${JSON.stringify(makeEntry())}\n`)

    const result = runScript(['--since', '2026-07-23', '--json'], logPath)

    expect((JSON.parse(result.stdout) as { completeness: { historyExcluded: boolean } }).completeness)
      .toMatchObject({ complete: false, historyExcluded: true })
  })
})

describe('per-model sources (IMP-26)', () => {
  test('counts model-attribution provenance per model bucket', () => {
    // Arrange
    const entries = [
      makeEntry({ modelSource: 'event' }),
      makeEntry({ modelSource: 'event' }),
      makeEntry({ modelSource: 'config' }),
      makeEntry({ model: 'gpt-5-mini', modelSource: 'override' }),
    ]

    // Act
    const aggregate = aggregateEntries(entries) as {
      byModel: Record<string, { sources?: Record<string, number> }>
    }

    // Assert
    expect(aggregate.byModel['gpt-5'].sources).toEqual({ event: 2, override: 0, config: 1 })
    expect(aggregate.byModel['gpt-5-mini'].sources).toEqual({ event: 0, override: 1, config: 0 })
  })

  test('leaves sources absent for a legacy bucket with no provenance', () => {
    const aggregate = aggregateEntries([makeEntry()]) as {
      byModel: Record<string, { sources?: unknown }>
    }

    expect(aggregate.byModel['gpt-5'].sources).toBeUndefined()
  })

  test('renders a Sources column with the non-zero counts, and an em dash without any', () => {
    const withSources = renderMarkdown(aggregateEntries([makeEntry({ modelSource: 'config' })])) as string
    const withoutSources = renderMarkdown(aggregateEntries([makeEntry()])) as string

    expect(withSources).toContain('| Reasoning output | Sources |')
    expect(withSources).toContain('| gpt-5 | 1 | 0 | 100 | 10 | 5 | 4 | 2 | config=1 |')
    expect(withoutSources).toContain('| gpt-5 | 1 | 0 | 100 | 10 | 5 | 4 | 2 | — |')
    expect(renderMarkdown(aggregateEntries([]))).toContain('| _None_ | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |')
  })
})

describe('describeHistoryDir (R6.4)', () => {
  test('reports the dir, archive count and total bytes', () => {
    // Arrange
    const logPath = makeTempLogPath()
    const first = writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])
    const second = writeArchive(logPath, 'metrics-20260201-000000.jsonl', [makeEntry(), makeEntry()])
    const expectedBytes = readFileSync(first).byteLength + readFileSync(second).byteLength

    // Act
    const described = describeHistoryDir(logPath) as { dir: string; files: number; bytes: number }

    // Assert
    expect(described).toEqual({ dir: historyDirFor(logPath), files: 2, bytes: expectedBytes })
  })

  test('reports an absent history dir as zero files and zero bytes', () => {
    const logPath = makeTempLogPath()

    expect(describeHistoryDir(logPath)).toEqual({
      dir: historyDirFor(logPath),
      files: 0,
      bytes: 0,
    })
  })

  test('discloses an unreadable history dir instead of reporting it empty', () => {
    const logPath = makeTempLogPath()
    writeFileSync(historyDirFor(logPath) as string, 'not a directory\n')

    const described = describeHistoryDir(logPath) as { readError?: string }

    expect(described.readError).toContain(
      `unable to read metrics history dir ${historyDirFor(logPath)}: `,
    )
  })

  test('skips a directory named like an archive (IMP-44)', () => {
    // Arrange
    const logPath = makeTempLogPath()
    const archive = writeArchive(logPath, 'metrics-20260101-000000.jsonl', [makeEntry()])
    mkdirSync(join(historyDirFor(logPath) as string, 'metrics-20260301-000000.jsonl'))

    // Act
    const described = describeHistoryDir(logPath) as { files: number, bytes: number }

    // Assert
    expect(described).toEqual({
      dir: historyDirFor(logPath),
      files: 1,
      bytes: readFileSync(archive).byteLength,
    })
  })

  test('rejects an empty log path', () => {
    expect(() => describeHistoryDir('')).toThrow(TypeError)
  })
})

describe('history listing mirrors metricsLog (IMP-44 symlink rule)', () => {
  test('skips a symlinked archive instead of pulling foreign entries into the totals', async () => {
    // Arrange
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'sc-symlink-'))
    const logPath = join(dir, 'metrics.jsonl')
    const historyDir = join(dir, 'history')
    mkdirSync(historyDir)
    const foreign = join(dir, 'foreign.jsonl')
    const line = JSON.stringify({ ts: '2026-09-01T00:00:00Z', tool: 'codex_execute', cwd: '/x', sessionId: 's', exitCode: 0, durationMs: 1, usage: null, timedOut: false, aborted: false, truncated: false, errorCount: 0, runId: 'r' })
    writeFileSync(foreign, `${line}\n`)
    writeFileSync(logPath, '')
    symlinkSync(foreign, join(historyDir, 'metrics-20260901-000000.jsonl'))

    // Act
    const { readEntriesDetailed } = await import('../scripts/session-cost.mjs')
    const result = readEntriesDetailed(logPath, { includeHistory: true })

    // Assert
    expect(result.entries).toHaveLength(0)
    expect(result.readErrors ?? []).toHaveLength(0)
  })
})
