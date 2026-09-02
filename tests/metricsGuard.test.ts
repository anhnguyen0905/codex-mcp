import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { appendMetric, isMetricsWriteSuppressed, type MetricEntry } from '../src/metricsLog.js'

const entry = (): MetricEntry => ({
  ts: '2026-09-02T00:00:00Z',
  tool: 'codex_execute',
  cwd: '/repo',
  sessionId: 's',
  exitCode: 0,
  durationMs: 1,
  usage: null,
})

describe('metrics write suppression under a test runner', () => {
  const previous = process.env.CODEX_MCP_METRICS_LOG
  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_MCP_METRICS_LOG
    else process.env.CODEX_MCP_METRICS_LOG = previous
  })

  test('the vitest setup file redirects the default log away from the home directory', () => {
    expect(process.env.CODEX_MCP_METRICS_LOG).toBeDefined()
    expect(process.env.CODEX_MCP_METRICS_LOG).not.toContain(join('.codex-mcp', 'metrics.jsonl'))
  })

  test('is suppressed when VITEST is set and no log path override exists', () => {
    expect(isMetricsWriteSuppressed({ VITEST: 'true' }, undefined)).toBe(true)
    expect(isMetricsWriteSuppressed({ VITEST: 'true', CODEX_MCP_METRICS_LOG: '/x' }, undefined)).toBe(false)
    expect(isMetricsWriteSuppressed({ VITEST: 'true' }, '/explicit')).toBe(false)
    expect(isMetricsWriteSuppressed({}, undefined)).toBe(false)
  })

  test('appendMetric skips the default path when suppressed but honors an explicit logPath', () => {
    delete process.env.CODEX_MCP_METRICS_LOG
    const dir = mkdtempSync(join(tmpdir(), 'codex-metrics-guard-'))
    const explicitLog = join(dir, 'metrics.jsonl')
    try {
      expect(appendMetric(entry())).toBe(false)

      expect(appendMetric(entry(), { logPath: explicitLog })).toBe(true)
      expect(existsSync(explicitLog)).toBe(true)
      expect(readFileSync(explicitLog, 'utf8').trim().split('\n')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
