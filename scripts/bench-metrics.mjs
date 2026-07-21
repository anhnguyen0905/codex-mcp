// Scale benchmarks for the metrics log and session store read paths. Both modules expose
// injectable roots (metricsLog: `logPath` option; sessionStore: `codexHome` option), so the bench
// generates synthetic data in temp dirs and times the REAL exported functions from dist/.
//
// Run: npm run build && node scripts/bench-metrics.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { benchRow, cleanupDirs, formatMs, makeTempDir, printResultsTable } from './bench-lib.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { readMetrics, aggregate } = await import(pathToFileURL(join(repoRoot, 'dist', 'metricsLog.js')).href)
const { listSessions, MAX_LIMIT } = await import(pathToFileURL(join(repoRoot, 'dist', 'sessionStore.js')).href)

// --- SLOs -----------------------------------------------------------------------------------
// Generous LOCAL bounds (CI/laptop variance), tuned ~3x above actuals measured on this machine
// (Apple Silicon macOS, 2026-07-21 — see docs/benchmarks.md for the measured numbers).
/** readMetrics (active + rotated .1 file, 5,000 lines total) + aggregate() with pricing. */
const SLO_METRICS_AGGREGATE_MS = 500
/** listSessions over 2,000 rollout files (walk + stat + head-read of the newest MAX_LIMIT). */
const SLO_SESSION_LISTING_MS = 1_000

const METRIC_ENTRY_COUNT = 5_000
const SESSION_FILE_COUNT = 2_000

const TOOLS = ['codex_execute', 'codex_continue', 'codex_review', 'codex_batch']
const PRICING = { inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 8, reasoningOutputPer1M: 8 }

const syntheticMetricLine = (i) =>
  JSON.stringify({
    ts: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    tool: TOOLS[i % TOOLS.length],
    cwd: `/tmp/bench/ws-${i % 20}`,
    sessionId: `session-${i % 100}`,
    exitCode: i % 25 === 0 ? 1 : 0,
    durationMs: 500 + (i % 900),
    usage: { inputTokens: 1_000 + i, cachedInputTokens: 200, outputTokens: 400, reasoningOutputTokens: 50 },
    runId: `run-${i}`,
  })

// --- Scenario 1: metrics aggregate over 5,000 entries (rotated + active file) ------------------
const benchMetricsAggregate = (metricsDir) => {
  const logPath = join(metricsDir, 'metrics.jsonl')
  const half = METRIC_ENTRY_COUNT / 2
  const lines = Array.from({ length: METRIC_ENTRY_COUNT }, (_, i) => syntheticMetricLine(i))
  // Simulate rotation exactly as appendMetric produces it: older half in `<file>.1`, newer in file.
  writeFileSync(`${logPath}.1`, lines.slice(0, half).join('\n') + '\n')
  writeFileSync(logPath, lines.slice(half).join('\n') + '\n')

  const started = performance.now()
  const entries = readMetrics({ logPath })
  const agg = aggregate(entries, { tool: 'codex_execute' }, PRICING)
  const aggAll = aggregate(entries, {}, PRICING)
  const elapsedMs = performance.now() - started

  const readAll = entries.length === METRIC_ENTRY_COUNT
  const aggregatedCorrectly =
    aggAll.totalRuns === METRIC_ENTRY_COUNT && agg.totalRuns === METRIC_ENTRY_COUNT / TOOLS.length && typeof aggAll.estCostUsd === 'number'
  return [
    benchRow(`metrics: read+aggregate ${METRIC_ENTRY_COUNT} entries (+rotated .1)`, formatMs(elapsedMs), `< ${formatMs(SLO_METRICS_AGGREGATE_MS)}`, elapsedMs < SLO_METRICS_AGGREGATE_MS),
    benchRow('metrics: all lines parsed', String(readAll), 'true', readAll),
    benchRow('metrics: aggregate totals correct', String(aggregatedCorrectly), 'true', aggregatedCorrectly),
  ]
}

// --- Scenario 2: session listing over 2,000 rollout files --------------------------------------
const sessionMetaLine = (i) =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: new Date(Date.UTC(2026, 5, 1) + i * 30_000).toISOString(),
    payload: {
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      cwd: `/tmp/bench/ws-${i % 20}`,
      cli_version: '0.99.0',
      originator: 'bench',
    },
  })

const benchSessionListing = async (codexHome) => {
  // Mirror the real layout: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl
  const filler = JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(200) } })
  for (let i = 0; i < SESSION_FILE_COUNT; i++) {
    const day = String((i % 28) + 1).padStart(2, '0')
    const dir = join(codexHome, 'sessions', '2026', '06', day)
    mkdirSync(dir, { recursive: true })
    const iso = new Date(Date.UTC(2026, 5, (i % 28) + 1, 0, 0, i % 60)).toISOString().replaceAll(':', '-')
    const file = join(dir, `rollout-${iso}-${String(i).padStart(4, '0')}.jsonl`)
    writeFileSync(file, sessionMetaLine(i) + '\n' + `${filler}\n`.repeat(5))
  }

  const started = performance.now()
  const newest = await listSessions({ codexHome })
  const capped = await listSessions({ codexHome, limit: MAX_LIMIT })
  const elapsedMs = performance.now() - started

  const defaultsOk = newest.length === 50 && newest.every((s) => s.sessionId && s.cwd)
  const cappedOk = capped.length === MAX_LIMIT
  return [
    benchRow(`sessions: list over ${SESSION_FILE_COUNT} rollouts (default + limit ${MAX_LIMIT})`, formatMs(elapsedMs), `< ${formatMs(SLO_SESSION_LISTING_MS)}`, elapsedMs < SLO_SESSION_LISTING_MS),
    benchRow('sessions: default listing shape correct', String(defaultsOk), 'true', defaultsOk),
    benchRow(`sessions: limit=${MAX_LIMIT} honored`, String(cappedOk), 'true', cappedOk),
  ]
}

// --- main -------------------------------------------------------------------------------------
const main = async () => {
  const metricsDir = makeTempDir('codex-bench-metrics')
  const codexHome = makeTempDir('codex-bench-codexhome')
  try {
    const rows = [...benchMetricsAggregate(metricsDir), ...(await benchSessionListing(codexHome))]
    const allPassed = printResultsTable('bench-metrics: metrics log + session store scale', rows)
    process.exitCode = allPassed ? 0 : 1
  } finally {
    await cleanupDirs([metricsDir, codexHome])
  }
}

await main()
