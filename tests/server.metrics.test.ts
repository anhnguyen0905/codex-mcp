import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MetricEntry } from '../src/metricsLog.js'
import { ROTATION_NOTICE } from '../src/metricsLog.js'
import { parseConfigModel, readConfiguredModel } from '../src/modelSource.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const jsonlFixture = [
  JSON.stringify({ type: 'thread.started', thread_id: 'sess-metrics' }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 200, reasoning_output_tokens: 5 },
  }),
].join('\n')

const okOutcome: RunOutcome = { stdout: jsonlFixture, stderr: '', exitCode: 0, timedOut: false }

/** Same run, but the event stream itself declares the effective model (R7.1). */
const modelBearingFixture = (model: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-metrics', model }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 200, reasoning_output_tokens: 5 },
    }),
  ].join('\n')

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

let logPath: string
let codexHome: string
let prevLog: string | undefined
let prevCodexHome: string | undefined

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-int-'))
  tempDirs.push(dir)
  logPath = join(dir, 'metrics.jsonl')
  prevLog = process.env.CODEX_MCP_METRICS_LOG
  process.env.CODEX_MCP_METRICS_LOG = logPath
  // Point the config-model fallback at an empty CODEX_HOME so the operator's real
  // ~/.codex/config.toml can never leak a model into these assertions.
  codexHome = mkdtempSync(join(tmpdir(), 'codex-home-int-'))
  tempDirs.push(codexHome)
  prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
})

afterAll(() => {
  if (prevLog === undefined) delete process.env.CODEX_MCP_METRICS_LOG
  else process.env.CODEX_MCP_METRICS_LOG = prevLog
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevCodexHome
})

const connect = async (runFn: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunOutcome>) => {
  const server = createServer({ runFn, diffFn: async () => null })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}

describe('metrics wiring', () => {
  test('each codex_execute run appends one metric line to the log', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const [e1, e2] = lines.map((l) => JSON.parse(l))
    expect(e1.tool).toBe('codex_execute')
    expect(e1.cwd).toBe('/w/1')
    expect(e1.sessionId).toBe('sess-metrics')
    expect(e1.usage.inputTokens).toBe(100)
    expect(e2.cwd).toBe('/w/2')
  })

  test('codex_metrics returns an aggregate over the log', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.totalRuns).toBe(2)
    expect(payload.failed).toBe(0)
    expect(payload.totalTokens.input).toBe(200) // 100 × 2
    expect(payload.byTool.codex_execute.runs).toBe(2)
    expect(payload.estCostUsd).toBeUndefined() // pricing not set
  })

  test('exit-0 run with parsed errors records errorCount/errorKind and counts as failed', async () => {
    const failedTurnFixture = [
      JSON.stringify({ type: 'thread.started', thread_id: 'sess-turn-failed' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'model refused' } }),
    ].join('\n')
    const runFn = vi.fn(async (): Promise<RunOutcome> => ({
      stdout: failedTurnFixture,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.exitCode).toBe(0)
    expect(line.errorCount).toBe(1)
    expect(line.errorKind).toBe('turn-failed')
    expect(line.errorMessage).toBe('model refused')

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)
    expect(payload.totalRuns).toBe(1)
    expect(payload.failed).toBe(1)
  })

  test('records model, queueMs, and timeToFirstProgressMs on the metric entry', async () => {
    const runFn = vi.fn(async (_args: string[], opts: { onStdout?: (c: Buffer) => void }): Promise<RunOutcome> => {
      opts.onStdout?.(Buffer.from(`${jsonlFixture}\n`))
      return okOutcome
    })
    const client = await connect(runFn as never)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5.1-codex')
    expect(line.modelSource).toBe('override')
    expect(typeof line.queueMs).toBe('number')
    expect(line.queueMs).toBeGreaterThanOrEqual(0)
    expect(typeof line.timeToFirstProgressMs).toBe('number')
    expect(line.timeToFirstProgressMs).toBeGreaterThanOrEqual(0)
  })

  test('omits model when no source is available; omits timeToFirstProgressMs when no stdout arrived', async () => {
    const runFn = vi.fn(async () => okOutcome) // never calls onStdout
    const client = await connect(runFn)

    // No --model override, no model in the event stream, and CODEX_HOME holds no config.toml:
    // genuinely unavailable configuration, distinct from the config-fallback case below.
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBeUndefined()
    expect(line.modelSource).toBeUndefined()
    expect(line.timeToFirstProgressMs).toBeUndefined()
  })

  test('batch tasks record taskId and model per metric entry', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_batch',
      arguments: {
        tasks: [
          { cwd: '/w/1', prompt: 'a', model: 'gpt-5.1-codex' },
          { cwd: '/w/2', prompt: 'b' },
        ],
      },
    })

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.taskId).sort()).toEqual(['task-0', 'task-1'])
    const task0 = lines.find((l) => l.taskId === 'task-0')
    const task1 = lines.find((l) => l.taskId === 'task-1')
    expect(task0.model).toBe('gpt-5.1-codex')
    expect(task0.tool).toBe('codex_batch')
    expect(task1.model).toBeUndefined()
  })

  test('codex_metrics aggregate includes the per-model breakdown', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })
    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'b', cwd: '/w/2', model: 'gpt-5.1-codex' },
    })

    const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.byModel['gpt-5.1-codex'].runs).toBe(2)
    expect(payload.byModel['gpt-5.1-codex'].failed).toBe(0)
    expect(payload.byModel['gpt-5.1-codex'].tokens.input).toBe(200)
    // COST_TABLE ships empty: no cost may be claimed for an unpriced model.
    expect(payload.byModel['gpt-5.1-codex'].estimatedCostUsd).toBeUndefined()
    expect(payload.estimatedCostUsd).toBeUndefined()
    expect(payload.avgQueueMs).toBeGreaterThanOrEqual(0)
  })

  test('records the event-stream model with modelSource event even without an override', async () => {
    // Arrange
    const runFn = vi.fn(
      async (): Promise<RunOutcome> => ({ ...okOutcome, stdout: modelBearingFixture('gpt-5-codex-event') }),
    )
    const client = await connect(runFn)

    // Act
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    // Assert
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5-codex-event')
    expect(line.modelSource).toBe('event')
  })

  test('event-stream model wins over an explicit model override', async () => {
    // Arrange
    const runFn = vi.fn(
      async (): Promise<RunOutcome> => ({ ...okOutcome, stdout: modelBearingFixture('gpt-5-codex-event') }),
    )
    const client = await connect(runFn)

    // Act
    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })

    // Assert
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5-codex-event')
    expect(line.modelSource).toBe('event')
  })

  test('falls back to the CODEX_HOME config.toml model with modelSource config', async () => {
    // Arrange
    writeFileSync(
      join(codexHome, 'config.toml'),
      ['# codex config', 'model = "gpt-5-codex-config"', '', '[model_providers.openai]', 'name = "OpenAI"'].join('\n'),
    )
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    // Assert
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5-codex-config')
    expect(line.modelSource).toBe('config')
  })

  test('explicit override wins over the config.toml model', async () => {
    // Arrange
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5-codex-config"\n')
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'a', cwd: '/w/1', model: 'gpt-5.1-codex' },
    })

    // Assert
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBe('gpt-5.1-codex')
    expect(line.modelSource).toBe('override')
  })

  test('a config.toml with no strict top-level model line leaves the field absent', async () => {
    // Arrange — every line here must be rejected by the strict parser.
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        '# model = "commented-out"',
        'model_provider = "openai"',
        "model = 'single-quoted'",
        'model = bare-word',
        '[profiles.fast]',
        'model = "in-a-table"',
      ].join('\n'),
    )
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    // Act
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })

    // Assert
    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.model).toBeUndefined()
    expect(line.modelSource).toBeUndefined()
  })

  test('cwd filter narrows the aggregate', async () => {
    const runFn = vi.fn(async () => okOutcome)
    const client = await connect(runFn)

    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'a', cwd: '/w/1' } })
    await client.callTool({ name: 'codex_execute', arguments: { prompt: 'b', cwd: '/w/2' } })

    const r = await client.callTool({ name: 'codex_metrics', arguments: { cwd: '/w/1' } })
    const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)

    expect(payload.totalRuns).toBe(1)
  })
})

describe('config model fallback parser', () => {
  test('reads a strict top-level model line, ignoring comments and trailing comments', () => {
    // Arrange
    const toml = ['# header', '  model = "gpt-5-codex"  # active model', 'approval_policy = "never"'].join('\n')

    // Act
    const model = parseConfigModel(toml)

    // Assert
    expect(model).toBe('gpt-5-codex')
  })

  test('rejects table-scoped, commented, unquoted, empty, and near-miss keys', () => {
    expect(parseConfigModel('[profiles.fast]\nmodel = "in-a-table"')).toBeUndefined()
    expect(parseConfigModel('# model = "commented"')).toBeUndefined()
    expect(parseConfigModel('model = bare-word')).toBeUndefined()
    expect(parseConfigModel("model = 'single-quoted'")).toBeUndefined()
    expect(parseConfigModel('model = ""')).toBeUndefined()
    expect(parseConfigModel('model_provider = "openai"')).toBeUndefined()
    expect(parseConfigModel('')).toBeUndefined()
  })

  test('returns undefined instead of throwing when the config file is missing', () => {
    // Arrange
    const emptyHome = mkdtempSync(join(tmpdir(), 'codex-home-missing-'))
    tempDirs.push(emptyHome)

    // Act / Assert
    expect(readConfiguredModel({ codexHome: emptyHome })).toBeUndefined()
    // A directory in place of the file is unreadable, not a crash.
    expect(readConfiguredModel({ codexHome: join(emptyHome, 'nope') })).toBeUndefined()
  })
})

/** One valid JSONL metric line; overrides let a test vary just the field under test. */
const metricLine = (overrides: Partial<MetricEntry> = {}): string =>
  JSON.stringify({
    ts: '2026-09-09T00:00:00.000Z',
    tool: 'codex_execute',
    cwd: '/w/1',
    sessionId: 'sess-fixture',
    exitCode: 0,
    durationMs: 1_000,
    usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 200, reasoningOutputTokens: 5 },
    ...overrides,
  } satisfies MetricEntry)

/** codex_metrics payload for a log the test has already staged on disk. */
const readMetricsPayload = async (): Promise<Record<string, unknown>> => {
  const client = await connect(vi.fn(async () => okOutcome))
  const r = await client.callTool({ name: 'codex_metrics', arguments: {} })
  return JSON.parse((r.content as Array<{ text: string }>)[0].text)
}

describe('codex_metrics diagnostics forwarding', () => {
  test('forwards invalidLines and the rotation notice for a log with a back-file (R7.3)', async () => {
    // Arrange — one entry in the rotated back-file, one entry plus one unparseable line live.
    writeFileSync(`${logPath}.1`, `${metricLine({ cwd: '/w/rotated' })}\n`)
    writeFileSync(logPath, [metricLine(), '{ not json', ''].join('\n'))

    // Act
    const payload = await readMetricsPayload()

    // Assert
    expect(payload.totalRuns).toBe(2)
    expect(payload.invalidLines).toBe(1)
    expect(payload.rotationNotice).toBe(ROTATION_NOTICE)
    expect(payload.readErrors).toBeUndefined()
  })

  test('counts a shape-invalid line as invalid without dropping the valid ones', async () => {
    // Arrange — parses as JSON but durationMs is negative, so the shape check rejects it.
    writeFileSync(logPath, [metricLine(), metricLine({ durationMs: -1 }), ''].join('\n'))

    // Act
    const payload = await readMetricsPayload()

    // Assert
    expect(payload.totalRuns).toBe(1)
    expect(payload.invalidLines).toBe(1)
    expect(payload.rotationNotice).toBeUndefined()
  })

  test('omits every diagnostic key on a clean log with no back-file', async () => {
    // Arrange
    writeFileSync(logPath, `${metricLine({ model: 'gpt-5.1-codex' })}\n`)

    // Act
    const payload = await readMetricsPayload()

    // Assert — absent, not zero/empty, so the payload stays additive.
    expect(payload.totalRuns).toBe(1)
    expect(payload.invalidLines).toBeUndefined()
    expect(payload.rotationNotice).toBeUndefined()
    expect(payload.readErrors).toBeUndefined()
    const byModel = payload.byModel as Record<string, { sources?: unknown }>
    expect(byModel['gpt-5.1-codex'].sources).toBeUndefined()
  })

  test('forwards readErrors when the log path is a directory (EISDIR)', async () => {
    // Arrange — a directory where the log file should be: exists, but unreadable.
    mkdirSync(logPath, { recursive: true })

    // Act
    const payload = await readMetricsPayload()

    // Assert — the gap is disclosed instead of reported as an empty log.
    expect(payload.totalRuns).toBe(0)
    const readErrors = payload.readErrors as string[]
    expect(readErrors).toHaveLength(1)
    expect(readErrors[0]).toContain(`unable to read metrics log ${logPath}`)
    expect(payload.invalidLines).toBeUndefined()
  })

  test('forwards byModel sources when entries carry modelSource', async () => {
    // Arrange
    writeFileSync(
      logPath,
      [
        metricLine({ model: 'gpt-5.1-codex', modelSource: 'config' }),
        metricLine({ model: 'gpt-5.1-codex', modelSource: 'event' }),
        metricLine({ model: 'gpt-5.1-codex', modelSource: 'event' }),
        '',
      ].join('\n'),
    )

    // Act
    const payload = await readMetricsPayload()

    // Assert
    const byModel = payload.byModel as Record<string, { runs: number; sources: Record<string, number> }>
    expect(byModel['gpt-5.1-codex'].runs).toBe(3)
    expect(byModel['gpt-5.1-codex'].sources).toEqual({ event: 2, override: 0, config: 1 })
  })
})
