import { afterEach, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  aggregateEntries,
  filterEntries,
  parseArgs,
  readEntries,
  renderMarkdown,
  resolveLogPath,
  resolvePricing,
} from '../scripts/session-cost.mjs'

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
  errorKind?: string
  timedOut?: boolean
  aborted?: boolean
}

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
