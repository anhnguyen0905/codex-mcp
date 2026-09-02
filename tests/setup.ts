import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate cross-process workspace leases per vitest worker: many test files reuse fake cwds
// like '/repo', and parallel workers sharing the real ~/.codex-mcp/locks would reject each
// other's runs with "workspace busy". pid + worker id covers both the forks and threads pools.
if (!process.env.CODEX_MCP_LOCKS_DIR) {
  const workerId = process.env.VITEST_WORKER_ID ?? '0'
  process.env.CODEX_MCP_LOCKS_DIR = join(tmpdir(), `codex-mcp-test-locks-${process.pid}-${workerId}`)
}

// Isolate the passive metrics log too: without this, every fake run in the suite appends a line
// to the real ~/.codex-mcp/metrics.jsonl and pollutes codex_metrics / session-cost.mjs output.
if (!process.env.CODEX_MCP_METRICS_LOG) {
  const workerId = process.env.VITEST_WORKER_ID ?? '0'
  process.env.CODEX_MCP_METRICS_LOG = join(
    tmpdir(),
    `codex-mcp-test-metrics-${process.pid}-${workerId}`,
    'metrics.jsonl',
  )
}
