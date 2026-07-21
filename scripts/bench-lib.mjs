// Shared helpers for the bench-* scripts. Node builtins only — no dependencies.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One measured benchmark row: metric name, measured value, SLO bound, pass flag. */
export const benchRow = (metric, measured, slo, pass) => ({ metric, measured, slo, pass })

const pad = (text, width) => String(text).padEnd(width)

/**
 * Print a metric → measured → SLO → PASS/FAIL table and return true when every row passed.
 * Immutable: does not modify `rows`.
 */
export const printResultsTable = (title, rows) => {
  const headers = ['metric', 'measured', 'SLO', 'result']
  const cells = rows.map((r) => [r.metric, String(r.measured), String(r.slo), r.pass ? 'PASS' : 'FAIL'])
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (cols) => `| ${cols.map((c, i) => pad(c, widths[i])).join(' | ')} |`
  process.stdout.write(`\n${title}\n`)
  process.stdout.write(`${line(headers)}\n`)
  process.stdout.write(`${line(widths.map((w) => '-'.repeat(w)))}\n`)
  for (const row of cells) process.stdout.write(`${line(row)}\n`)
  return rows.every((r) => r.pass)
}

/** Create a unique temp directory with the given prefix. Caller removes it via cleanupDirs. */
export const makeTempDir = (prefix) => mkdtempSync(join(tmpdir(), `${prefix}-`))

/** Best-effort recursive removal of the given directories (used in finally blocks). */
export const cleanupDirs = async (dirs) => {
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup — a leftover temp dir must not flip the bench result
    }
  }
}

export const formatMs = (ms) => `${Math.round(ms)}ms`
export const formatMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`

/** Await a small number of macrotask turns so just-closed handles are reaped before counting. */
export const settleEventLoop = (turns = 3) =>
  new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : setImmediate(() => step(left - 1)))
    step(turns)
  })

/** Poll `check` every `intervalMs` until it returns true or `timeoutMs` elapses. */
export const waitFor = async (check, timeoutMs, intervalMs = 10) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return check()
}

/**
 * Fake `codex` CLI used by the benches so no real Codex binary (or network) is involved.
 * Injected via the runner's CODEX_BIN env override (see src/codexRunner.ts resolveCodexBinary).
 * Modes (selected via FAKE_CODEX_MODE in the inherited env):
 *  - "large": stream FAKE_CODEX_BYTES of JSONL item events, then agent_message + turn.completed.
 *  - "task":  sleep FAKE_CODEX_SLEEP_MS, emit a minimal successful event stream, exit 0.
 *  - "hang":  spawn a `sleep` grandchild (pid written to FAKE_CODEX_PIDFILE), then idle forever.
 */
const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.env.FAKE_CODEX_MODE ?? 'task'

const write = (chunk) =>
  new Promise((resolve) => {
    if (process.stdout.write(chunk)) resolve()
    else process.stdout.once('drain', resolve)
  })

const finishStream = async () => {
  await write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\\n')
  await write(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
    }) + '\\n',
  )
}

if (mode === 'large') {
  const totalBytes = Number(process.env.FAKE_CODEX_BYTES ?? String(50 * 1024 * 1024))
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x'.repeat(160) } }) + '\\n'
  const block = line.repeat(Math.ceil((1024 * 1024) / line.length))
  let written = 0
  await write(JSON.stringify({ type: 'thread.started', thread_id: 'bench-large' }) + '\\n')
  while (written < totalBytes) {
    await write(block)
    written += block.length
  }
  await finishStream()
  process.exit(0)
} else if (mode === 'hang') {
  const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
  writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(grandchild.pid))
  await write(JSON.stringify({ type: 'thread.started', thread_id: 'bench-hang' }) + '\\n')
  setInterval(() => {}, 1_000_000) // idle until signalled
} else {
  const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? '100')
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
  await write(JSON.stringify({ type: 'thread.started', thread_id: 'bench-task' }) + '\\n')
  await finishStream()
  process.exit(0)
}
`

/** Write the fake codex CLI into `dir` and return its absolute path (already chmod +x). */
export const writeFakeCodex = (dir) => {
  const binPath = join(dir, 'fake-codex.mjs')
  writeFileSync(binPath, FAKE_CODEX_SOURCE)
  chmodSync(binPath, 0o755)
  return binPath
}
