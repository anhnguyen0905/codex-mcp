import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'

const TAIL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tail-progress.mjs')
const EXIT_TIMEOUT_MS = 10_000
const MARKER_DELAY_MS = 300

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface WatcherResult {
  code: number | null
  stdout: string
}

/** Spawn the watcher against `logPath` and resolve with its exit code (bounded by a hard kill). */
const runWatcher = (logPath: string, env: NodeJS.ProcessEnv = {}): { done: Promise<WatcherResult> } => {
  const child = spawn(process.execPath, [TAIL_SCRIPT, logPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  const done = new Promise<WatcherResult>((resolve, reject) => {
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`watcher did not exit within ${EXIT_TIMEOUT_MS}ms; stdout:\n${stdout}`))
    }, EXIT_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ code, stdout })
    })
    child.on('error', (error) => {
      clearTimeout(killTimer)
      reject(error)
    })
  })
  return { done }
}

describe('tail-progress watcher auto-exit', () => {
  test('exits 0 with a message when the end-of-run marker is appended', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    writeFileSync(logPath, '{"type":"thread.started","thread_id":"sess-1"}\n')

    const watcher = runWatcher(logPath)
    // Let the watcher start following before the run "settles".
    await new Promise((resolve) => setTimeout(resolve, MARKER_DELAY_MS))
    appendFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: 'sess-1' })}\n`,
    )

    const { code, stdout } = await watcher.done
    expect(code).toBe(0)
    expect(stdout).toContain('run finished')
  })

  test('exits 0 immediately when the marker is already present at startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'failed', sessionId: null })}\n`,
    )

    const { code } = await runWatcher(logPath).done
    expect(code).toBe(0)
  })

  test('exits 1 via the timeout fallback when no marker ever arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-tail-'))
    tempDirs.push(dir)
    const logPath = join(dir, 'run.jsonl')
    writeFileSync(logPath, '{"type":"thread.started","thread_id":"sess-2"}\n')

    const { code, stdout } = await runWatcher(logPath, { CODEX_TAIL_TIMEOUT_MS: '500' }).done
    expect(code).toBe(1)
    expect(stdout).toContain('giving up')
  })
})
