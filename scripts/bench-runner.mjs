// Micro-benchmarks for the codex runner hot paths, using a fake codex binary (no real CLI, no
// network). Injection point: the runner resolves the binary via the CODEX_BIN env override
// (src/codexRunner.ts resolveCodexBinary), so pointing CODEX_BIN at a local node script exercises
// the REAL spawn / process-group / streaming / kill machinery end to end.
//
// Run: npm run build && node scripts/bench-runner.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  benchRow,
  cleanupDirs,
  formatMb,
  formatMs,
  makeTempDir,
  printResultsTable,
  settleEventLoop,
  waitFor,
  writeFakeCodex,
} from './bench-lib.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { runCodex } = await import(pathToFileURL(join(repoRoot, 'dist', 'codexRunner.js')).href)
const { runBatch } = await import(pathToFileURL(join(repoRoot, 'dist', 'batchRunner.js')).href)

// --- SLOs -----------------------------------------------------------------------------------
// Generous LOCAL bounds (CI/laptop variance), tuned ~3x above actuals measured on this machine
// (Apple Silicon macOS, 2026-07-21 — see docs/benchmarks.md for the measured numbers).
/** Peak RSS growth while streaming a 50MB JSONL run — proves the tail-rotation design is O(1). */
const SLO_LARGE_RUN_PEAK_RSS_DELTA_BYTES = 150 * 1024 * 1024
/** Wall time to parse+settle the 50MB run itself (measured ~220-460ms). */
const SLO_LARGE_RUN_WALL_MS = 3_000
/** Wall time for 50 fake tasks of ~100ms at the configured concurrency (measured ~710ms) — must beat serial (5s). */
const SLO_BATCH_WALL_MS = 2_500
/** Cancellation: abort → promise settled. */
const SLO_CANCEL_SETTLE_MS = 500
/** After cancel, how long we give the process group for descendants to be reaped. */
const DESCENDANT_REAP_TIMEOUT_MS = 300

const LARGE_RUN_BYTES = 50 * 1024 * 1024
const BATCH_TASK_COUNT = 50
const BATCH_TASK_SLEEP_MS = 100
const BATCH_MAX_CONCURRENT = parsePositiveInt(process.env.BENCH_MAX_CONCURRENT) ?? 10

function parsePositiveInt(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

const isPosix = process.platform !== 'win32'

/** Live (non-zombie or zombie) direct children of this bench process, via ps. POSIX only. */
const listDirectChildren = () => {
  if (!isPosix) return []
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 3 && Number(cols[1]) === process.pid)
    .map(([pid, , stat, ...comm]) => ({ pid: Number(pid), stat, comm: comm.join(' ') }))
    // `ps` itself is momentarily a live child of this process while it runs — not a leak.
    .filter((child) => child.comm.split('/').pop() !== 'ps')
}

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Track peak RSS via polling while `work` runs; returns { result, peakRssDelta }. */
const measurePeakRss = async (work) => {
  if (global.gc) global.gc()
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const poll = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
  }, 20)
  try {
    const result = await work()
    return { result, peakRssDelta: peak - baseline }
  } finally {
    clearInterval(poll)
  }
}

// --- Scenario a: 50MB streaming run ----------------------------------------------------------
const benchLargeOutput = async (fakeBin, workDir) => {
  process.env.CODEX_BIN = fakeBin
  process.env.FAKE_CODEX_MODE = 'large'
  process.env.FAKE_CODEX_BYTES = String(LARGE_RUN_BYTES)
  const started = performance.now()
  const { result, peakRssDelta } = await measurePeakRss(() =>
    runCodex(['exec', '--json'], { cwd: workDir, timeoutMs: 120_000 }),
  )
  const wallMs = performance.now() - started
  const sawCompletion = result.parsed?.sawCompletion === true
  const exitedClean = result.exitCode === 0 && !result.timedOut && !result.aborted
  return [
    benchRow('large-run: peak RSS delta (50MB stream)', formatMb(peakRssDelta), `< ${formatMb(SLO_LARGE_RUN_PEAK_RSS_DELTA_BYTES)}`, peakRssDelta < SLO_LARGE_RUN_PEAK_RSS_DELTA_BYTES),
    benchRow('large-run: wall time', formatMs(wallMs), `< ${formatMs(SLO_LARGE_RUN_WALL_MS)}`, wallMs < SLO_LARGE_RUN_WALL_MS),
    benchRow('large-run: parsed sawCompletion + exit 0', `${sawCompletion}/${exitedClean}`, 'true/true', sawCompletion && exitedClean),
  ]
}

// --- Scenario b: batch of 50 tasks through the worker pool -----------------------------------
const benchBatch = async (fakeBin, batchRoot) => {
  process.env.CODEX_BIN = fakeBin
  process.env.FAKE_CODEX_MODE = 'task'
  process.env.FAKE_CODEX_SLEEP_MS = String(BATCH_TASK_SLEEP_MS)

  // Warm-up run so lazily created runtime handles don't count as a leak against the baseline.
  const warmDir = join(batchRoot, 'warmup')
  mkdirSync(warmDir)
  await runCodex(['exec'], { cwd: warmDir, timeoutMs: 30_000 })
  await settleEventLoop()
  const handleBaseline = process._getActiveHandles().length

  const tasks = Array.from({ length: BATCH_TASK_COUNT }, (_, i) => {
    const cwd = join(batchRoot, `task-${i}`)
    mkdirSync(cwd)
    return { cwd, prompt: `bench task ${i}` }
  })
  const runTask = async (task, taskIndex, signal) => {
    const outcome = await runCodex(['exec'], { cwd: task.cwd, timeoutMs: 30_000, signal })
    return {
      taskIndex,
      cwd: task.cwd,
      schemaVersion: 1,
      status: outcome.exitCode === 0 ? 'success' : 'failed',
      parsed: outcome.parsed,
      diff: null,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      stderr: outcome.stderr,
      liveLog: null,
      isError: outcome.exitCode !== 0,
    }
  }

  const started = performance.now()
  const results = await runBatch(tasks, runTask, { maxConcurrency: BATCH_MAX_CONCURRENT }, new AbortController().signal)
  const wallMs = performance.now() - started

  const allSucceeded = results.length === BATCH_TASK_COUNT && results.every((r) => !r.isError && r.parsed?.sawCompletion)
  const serialEstimateMs = BATCH_TASK_COUNT * BATCH_TASK_SLEEP_MS

  // Leak checks: active handles back to baseline, and no leftover/zombie direct children.
  const handlesRecovered = await waitFor(async () => {
    await settleEventLoop()
    return process._getActiveHandles().length <= handleBaseline
  }, 2_000, 50)
  const leftoverChildren = isPosix ? listDirectChildren() : []

  return [
    benchRow(`batch: wall time (${BATCH_TASK_COUNT}x${BATCH_TASK_SLEEP_MS}ms @ ${BATCH_MAX_CONCURRENT} workers)`, formatMs(wallMs), `< ${formatMs(SLO_BATCH_WALL_MS)}`, wallMs < SLO_BATCH_WALL_MS),
    benchRow('batch: parallel vs serial estimate', formatMs(wallMs), `< serial ${formatMs(serialEstimateMs)}`, wallMs < serialEstimateMs),
    benchRow('batch: all tasks completed cleanly', String(allSucceeded), 'true', allSucceeded),
    benchRow('batch: active handles back to baseline', String(handlesRecovered), 'true', handlesRecovered),
    benchRow('batch: leftover/zombie child processes', String(leftoverChildren.length), '0', leftoverChildren.length === 0),
  ]
}

// --- Scenario c: cancellation latency + descendant cleanup ------------------------------------
const benchCancellation = async (fakeBin, workDir) => {
  process.env.CODEX_BIN = fakeBin
  process.env.FAKE_CODEX_MODE = 'hang'
  const pidFile = join(workDir, 'grandchild.pid')
  process.env.FAKE_CODEX_PIDFILE = pidFile

  const controller = new AbortController()
  const runPromise = runCodex(['exec'], {
    cwd: workDir,
    timeoutMs: 60_000,
    signal: controller.signal,
  })
  const spawned = await waitFor(() => existsSync(pidFile), 5_000)
  if (!spawned) {
    controller.abort()
    await runPromise
    return [benchRow('cancel: fake run failed to start', 'no pidfile', 'started', false)]
  }
  const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())

  const abortedAt = performance.now()
  controller.abort()
  const outcome = await runPromise
  const settleMs = performance.now() - abortedAt

  const descendantGone = await waitFor(() => !isPidAlive(grandchildPid), DESCENDANT_REAP_TIMEOUT_MS)
  return [
    benchRow('cancel: abort → settle latency', formatMs(settleMs), `< ${formatMs(SLO_CANCEL_SETTLE_MS)}`, settleMs < SLO_CANCEL_SETTLE_MS),
    benchRow('cancel: outcome flagged aborted', String(outcome.aborted === true), 'true', outcome.aborted === true),
    benchRow(`cancel: grandchild dead within ${DESCENDANT_REAP_TIMEOUT_MS}ms`, String(descendantGone), 'true', descendantGone),
  ]
}

// --- main -------------------------------------------------------------------------------------
const main = async () => {
  const binDir = makeTempDir('codex-bench-bin')
  const largeDir = makeTempDir('codex-bench-large')
  const batchRoot = makeTempDir('codex-bench-batch')
  const cancelDir = makeTempDir('codex-bench-cancel')
  const tempDirs = [binDir, largeDir, batchRoot, cancelDir]
  try {
    const fakeBin = writeFakeCodex(binDir)
    const rows = [
      ...(await benchLargeOutput(fakeBin, largeDir)),
      ...(await benchBatch(fakeBin, batchRoot)),
      ...(await benchCancellation(fakeBin, cancelDir)),
    ]
    const allPassed = printResultsTable('bench-runner: codex runner hot paths (fake codex via CODEX_BIN)', rows)
    process.exitCode = allPassed ? 0 : 1
  } finally {
    await cleanupDirs(tempDirs)
  }
}

await main()
