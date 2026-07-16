import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_ALLOWED_CONCURRENCY,
  runBatch,
  type BatchTaskResult,
  type BatchTaskSpec,
  type TaskRunner,
} from '../src/batchRunner.js'

const success = (task: BatchTaskSpec, taskIndex: number): BatchTaskResult => ({
  taskIndex,
  cwd: task.cwd,
  parsed: { sessionId: `s${taskIndex}`, agentMessage: 'ok', fileChanges: [], commands: [], usage: null, errors: [] },
  diff: null,
  exitCode: 0,
  timedOut: false,
  aborted: false,
  stderr: '',
  liveLog: null,
  isError: false,
})

const failed = (task: BatchTaskSpec, taskIndex: number): BatchTaskResult => ({
  ...success(task, taskIndex),
  exitCode: 1,
  isError: true,
})

const mkTasks = (n: number): BatchTaskSpec[] =>
  Array.from({ length: n }, (_, i) => ({ cwd: `/tmp/w${i}`, prompt: `t${i}` }))

describe('runBatch', () => {
  test('returns empty for empty input, does not call the runner', async () => {
    const runner: TaskRunner = vi.fn()
    const results = await runBatch([], runner, {}, new AbortController().signal)
    expect(results).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })

  test('runs all tasks, preserves input order in results', async () => {
    const tasks = mkTasks(4)
    const runner: TaskRunner = async (task, i) => success(task, i)
    const results = await runBatch(tasks, runner, {}, new AbortController().signal)
    expect(results.map((r) => r.taskIndex)).toEqual([0, 1, 2, 3])
    expect(results.every((r) => !r.isError)).toBe(true)
  })

  test('respects maxConcurrency', async () => {
    let inflight = 0
    let peak = 0
    const runner: TaskRunner = async (task, i) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return success(task, i)
    }
    await runBatch(mkTasks(8), runner, { maxConcurrency: 2 }, new AbortController().signal)
    expect(peak).toBe(2)
  })

  test('one failure does not sink siblings when failFast=false (default)', async () => {
    const tasks = mkTasks(3)
    const runner: TaskRunner = async (task, i) => (i === 1 ? failed(task, i) : success(task, i))
    const results = await runBatch(tasks, runner, {}, new AbortController().signal)
    expect(results.map((r) => r.isError)).toEqual([false, true, false])
  })

  test('failFast cancels pending siblings on first failure', async () => {
    let started = 0
    const runner: TaskRunner = async (task, i, signal) => {
      started++
      await new Promise((r) => setTimeout(r, i === 0 ? 5 : 50))
      if (signal.aborted) return { ...success(task, i), aborted: true, isError: true }
      return i === 0 ? failed(task, i) : success(task, i)
    }
    const results = await runBatch(mkTasks(6), runner, { failFast: true, maxConcurrency: 2 }, new AbortController().signal)
    // task 0 fails fast at ~5ms; workers cap=2 so task 1 was already in flight → both start (2),
    // remaining 4 must never start.
    expect(started).toBeLessThanOrEqual(2)
    expect(results[0].isError).toBe(true)
    expect(results.slice(2).every((r) => r.isError)).toBe(true) // skipped or aborted
  })

  test('external abort cancels the batch', async () => {
    const ac = new AbortController()
    const runner: TaskRunner = async (task, i, signal) => {
      await new Promise((r) => {
        const t = setTimeout(r, 100)
        signal.addEventListener('abort', () => {
          clearTimeout(t)
          r(undefined)
        })
      })
      return signal.aborted ? { ...success(task, i), aborted: true, isError: true } : success(task, i)
    }
    setTimeout(() => ac.abort(), 10)
    const results = await runBatch(mkTasks(6), runner, { maxConcurrency: 2 }, ac.signal)
    expect(results.some((r) => r.isError && (r.aborted || r.error?.includes('cancelled')))).toBe(true)
  })

  test('duplicate cwd fails fast at input validation', async () => {
    const runner: TaskRunner = vi.fn()
    await expect(
      runBatch(
        [
          { cwd: '/a', prompt: 'x' },
          { cwd: '/a', prompt: 'y' },
        ],
        runner,
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/duplicate cwd/i)
    expect(runner).not.toHaveBeenCalled()
  })

  test('invalid maxConcurrency rejected', async () => {
    const runner: TaskRunner = vi.fn()
    for (const bad of [0, -1, NaN, 1.5]) {
      await expect(
        runBatch(mkTasks(2), runner, { maxConcurrency: bad }, new AbortController().signal),
      ).rejects.toThrow(/positive integer/i)
    }
  })

  test('maxConcurrency clamped to MAX_ALLOWED_CONCURRENCY', async () => {
    let peak = 0
    let inflight = 0
    const runner: TaskRunner = async (task, i) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 1))
      inflight--
      return success(task, i)
    }
    await runBatch(mkTasks(50), runner, { maxConcurrency: 1000 }, new AbortController().signal)
    expect(peak).toBeLessThanOrEqual(MAX_ALLOWED_CONCURRENCY)
  })

  test('constants are exported and sensible', () => {
    expect(DEFAULT_BATCH_CONCURRENCY).toBeGreaterThanOrEqual(1)
    expect(MAX_ALLOWED_CONCURRENCY).toBeGreaterThanOrEqual(DEFAULT_BATCH_CONCURRENCY)
  })
})
