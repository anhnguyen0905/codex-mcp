import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { runCodex, type RunOptions } from '../src/codexRunner.js'
import { runOnce, SNAPSHOT_DEADLINE_MS, type RunAndReportDeps, type RunFn } from '../src/runReport.js'
import {
  attributeWorkspaceDiff,
  HASH_CONCURRENCY,
  runGit,
  type RunAttribution,
  type WorkspaceDiff,
} from '../src/workspaceDiff.js'
import type { RunOutcome } from '../src/types.js'

const EMPTY_DIFF: WorkspaceDiff = { status: '', statusTruncated: false, patch: '', truncated: false }

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: NodeJS.Signals) => void
}

const makeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  return child
}

const view = {
  onStdout: undefined,
  close: vi.fn(),
  logPath: null,
}

const baseDeps = (runFn: RunFn, diffFn: RunAndReportDeps['diffFn']): RunAndReportDeps => ({
  runFn,
  view,
  diffFn,
  snapshotFn: async () => null,
  attributeFn: async (): Promise<RunAttribution> => ({ files: [], untracked: [] }),
  runId: 'post-run-test',
  tool: 'codex_execute',
})

describe('post-run bound', () => {
  test('returns within timeoutMs + 60 s when the child ignores signals and post-run never resolves', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const child = makeChild()
      const runFn: RunFn = async (_args: string[], options: Omit<RunOptions, 'spawnFn' | 'onStdout'>) =>
        runCodex(['exec', 'test'], {
          ...options,
          spawnFn: (() => child) as never,
          sigkillGraceMs: 10,
        })
      const never = (): Promise<WorkspaceDiff | null> => new Promise(() => {})
      const start = Date.now()
      const resultPromise = runOnce(
        baseDeps(runFn, never),
        [],
        { cwd: '/repo', timeoutMs: 100 },
      )

      await vi.advanceTimersByTimeAsync(30_120)
      const result = await resultPromise

      expect(result.payload.timedOut).toBe(true)
      expect(result.payload.diff).toMatchObject({
        unavailable: true,
        reason: 'post-run deadline exceeded',
      })
      expect(Date.now() - start).toBeLessThanOrEqual(60_100)
    } finally {
      vi.useRealTimers()
    }
  })

  test('returns a healthy fast diff unchanged', async () => {
    const diff: WorkspaceDiff = { ...EMPTY_DIFF, status: ' M a.txt' }
    const runFn: RunFn = async (): Promise<RunOutcome> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })
    const result = await runOnce(
      baseDeps(runFn, async () => diff),
      [],
      { cwd: '/repo' },
    )

    expect(result.payload.diff).toEqual(diff)
    expect(result.payload.diff).not.toHaveProperty('unavailable')
  })

  test('pre-run snapshot that never resolves is abandoned after the deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const runFn: RunFn = async (): Promise<RunOutcome> => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      })
      const snapshotFn = vi.fn(async () => new Promise<null>(() => {}))
      const attributeFn = vi.fn(async (_cwd: string, snapshot: null): Promise<RunAttribution> => ({
        files:
          snapshot === null
            ? [{ path: 'created.txt', status: '??', attribution: 'changedByRun' }]
            : [],
        untracked: [],
      }))
      const resultPromise = runOnce(
        {
          ...baseDeps(runFn, async () => EMPTY_DIFF),
          snapshotFn,
          attributeFn,
        },
        [],
        { cwd: '/repo' },
      )

      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS)
      const result = await resultPromise

      expect(snapshotFn).toHaveBeenCalledTimes(1)
      expect(attributeFn).toHaveBeenCalledWith('/repo', null)
      expect(result.payload.attribution?.files[0]?.attribution).toBe('changedByRun')
    } finally {
      vi.useRealTimers()
    }
  })

  test('preserves attribution path order with more than HASH_CONCURRENCY files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-mcp-hash-order-'))
    try {
      const paths = Array.from({ length: HASH_CONCURRENCY + 4 }, (_, index) => `file-${index}.txt`)
      for (const path of paths) writeFileSync(join(directory, path), path)
      const statusPorcelainZ = Promise.resolve(paths.map((path) => `?? ${path}\0`).join(''))

      const attribution = await attributeWorkspaceDiff(directory, null, { statusPorcelainZ })

      expect(attribution?.files.map((file) => file.path)).toEqual(paths)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  const testPosix = process.platform === 'win32' ? test.skip : test
  testPosix('runGit kills the git process group and settles when git ignores SIGTERM', async () => {
    await expect(
      runGit('/tmp', ['-c', "trap '' TERM; sleep 60"], {
        command: 'sh',
        timeoutMs: 20,
      }),
    ).rejects.toThrow('git command timed out')
  }, 3_000)
})
