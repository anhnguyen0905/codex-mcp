import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createLiveView } from '../src/liveView.js'
import { LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'

const tempDirs: string[] = []
const BENIGN_NOTICE =
  '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A live view whose terminal launcher is a no-op so tests never open real windows. */
const makeView = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-marker-'))
  tempDirs.push(cwd)
  return createLiveView(cwd, { openTerminalFn: () => true })
}

const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 3000

/** Wait for the async WriteStream flush after close(), then return the log's last line parsed. */
const readMarker = async (logPath: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    let content = ''
    try {
      content = readFileSync(logPath, 'utf8')
    } catch {
      // WriteStream creates the file asynchronously — keep polling until the deadline.
    }
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]
    if (last?.includes(LIVE_RUN_FINISHED_TYPE)) return JSON.parse(last) as Record<string, unknown>
    if (Date.now() > deadline) throw new Error(`no completion marker in ${logPath} after ${POLL_TIMEOUT_MS}ms`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

describe('createLiveView completion marker', () => {
  test('writes a completed marker (with sessionId) when the stream saw turn.completed', async () => {
    const view = makeView()
    expect(view.logPath).toBeTruthy()
    view.onStdout?.(Buffer.from('{"type":"thread.started","thread_id":"sess-42"}\n'))
    view.onStdout?.(Buffer.from('{"type":"turn.completed","usage":{"input_tokens":1}}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.type).toBe(LIVE_RUN_FINISHED_TYPE)
    expect(marker.status).toBe('completed')
    expect(marker.sessionId).toBe('sess-42')
  })

  test('writes a failed marker when the stream saw turn.failed', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"turn.failed","error":{"message":"boom"}}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('failed')
  })

  test('writes a completed marker when turn.failed contains an allowlisted notice', async () => {
    const view = makeView()
    view.onStdout?.(
      Buffer.from(
        `${JSON.stringify({ type: 'turn.failed', error: { message: BENIGN_NOTICE } })}\n`,
      ),
    )

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('completed')
  })

  test('writes an interrupted marker when the run settled without a terminal turn event (abort/timeout/kill)', async () => {
    const view = makeView()
    view.onStdout?.(Buffer.from('{"type":"thread.started","thread_id":"sess-43"}\n'))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('interrupted')
  })

  test('handles a terminal event split across chunk boundaries', async () => {
    const view = makeView()
    const eventLine = '{"type":"turn.completed","usage":{"input_tokens":1}}\n'
    view.onStdout?.(Buffer.from(eventLine.slice(0, 10)))
    view.onStdout?.(Buffer.from(eventLine.slice(10)))

    view.close()

    const marker = await readMarker(view.logPath as string)
    expect(marker.status).toBe('completed')
  })
})

describe('createLiveView symlink guard', () => {
  test('refuses when the nested .codex-flow/live dir is a planted symlink (no write through it)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-'))
    const target = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-target-'))
    tempDirs.push(cwd, target)

    // Simulate a cloned repo with a real .codex-flow/ but `live` committed as a symlink elsewhere.
    mkdirSync(join(cwd, '.codex-flow'))
    symlinkSync(target, join(cwd, '.codex-flow', 'live'))

    const view = createLiveView(cwd)

    // Guard tripped → degraded no-op view, and nothing written through the symlink to the target.
    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
    expect(readdirSync(target)).toHaveLength(0)
  })
})
