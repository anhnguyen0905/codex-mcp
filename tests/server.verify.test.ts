import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createLiveView } from '../src/liveView.js'
import { writeNotes, type NotesRequest } from '../src/notesWriter.js'
import { LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'
import { createProgressNotifier } from '../src/progressNotifier.js'
import { createServer } from '../src/server.js'
import type { CodexResult, RunOutcome } from '../src/types.js'
import { runVerification, VERIFY_OUTPUT_TAIL_CHARS, type VerifyFn } from '../src/verification.js'

const okFixture = [
  JSON.stringify({ type: 'thread.started', thread_id: 'sess-v' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'tests pass, trust me' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
].join('\n')

const okOutcome: RunOutcome = { stdout: okFixture, stderr: '', exitCode: 0, timedOut: false }
const failedOutcome: RunOutcome = { stdout: '', stderr: 'boom', exitCode: 1, timedOut: false }

const connect = async (runFn: () => Promise<RunOutcome>, verifyFn: VerifyFn) => {
  const server = createServer({ runFn, verifyFn })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const payloadOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0].text)

describe('verifyCommand', () => {
  test('runs the acceptance command in cwd after a successful run and attaches the result', async () => {
    const verifyFn = vi.fn<VerifyFn>(async (command, options) => ({
      command,
      exitCode: 2,
      timedOut: false,
      durationMs: 42,
      outputTail: `ran in ${options.cwd} with timeout ${options.timeoutMs}`,
      passed: false,
    }))
    const client = await connect(async () => okOutcome, verifyFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'do it', cwd: '/repo', verifyCommand: 'npm test', verifyTimeoutMs: 1234 },
    })
    const payload = payloadOf(result)

    expect(verifyFn).toHaveBeenCalledTimes(1)
    expect(payload.status).toBe('success')
    expect(payload.agentMessage).toBe('tests pass, trust me')
    expect(payload.verification).toMatchObject({ command: 'npm test', exitCode: 2, passed: false })
    expect(payload.verification.outputTail).toBe('ran in /repo with timeout 1234')
    expect(result.isError).toBe(false)
    expect((result.structuredContent as { verification: unknown }).verification).toEqual(payload.verification)
  })

  test('does not run the acceptance command when the Codex run itself failed', async () => {
    const verifyFn = vi.fn<VerifyFn>()
    const client = await connect(async () => failedOutcome, verifyFn)

    const result = await client.callTool({
      name: 'codex_continue',
      arguments: { sessionId: 'sess-v', prompt: 'fix', cwd: '/repo', verifyCommand: 'npm test' },
    })
    const payload = payloadOf(result)

    expect(verifyFn).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(payload.verification).toMatchObject({ command: 'npm test', passed: false, skipped: 'run-failed' })
  })

  test('omits the verification field entirely when no verifyCommand was given', async () => {
    const verifyFn = vi.fn<VerifyFn>()
    const client = await connect(async () => okOutcome, verifyFn)

    const payload = payloadOf(
      await client.callTool({ name: 'codex_execute', arguments: { prompt: 'do it', cwd: '/repo' } }),
    )

    expect(verifyFn).not.toHaveBeenCalled()
    expect(payload).not.toHaveProperty('verification')
  })

  test('rejects a verifyTimeoutMs above the cap at the schema boundary', async () => {
    const verifyFn = vi.fn<VerifyFn>()
    const client = await connect(async () => okOutcome, verifyFn)

    const result = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'do it', cwd: '/repo', verifyCommand: 'npm test', verifyTimeoutMs: 31 * 60 * 1000 },
    })

    expect(result.isError).toBe(true)
    expect(verifyFn).not.toHaveBeenCalled()
  })
})

describe('accepted verdict on execute/continue payloads', () => {
  const verifyWith = (passed: boolean): VerifyFn =>
    vi.fn<VerifyFn>(async (command) => ({ command, exitCode: passed ? 0 : 1, timedOut: false, durationMs: 1, outputTail: '', passed }))

  test('accepted is true for a successful run without verifyCommand', async () => {
    const client = await connect(async () => okOutcome, vi.fn<VerifyFn>())

    const payload = payloadOf(await client.callTool({ name: 'codex_execute', arguments: { prompt: 'x', cwd: '/repo' } }))

    expect(payload.status).toBe('success')
    expect(payload.accepted).toBe(true)
  })

  test('accepted is true when verification passed', async () => {
    const client = await connect(async () => okOutcome, verifyWith(true))

    const payload = payloadOf(
      await client.callTool({ name: 'codex_execute', arguments: { prompt: 'x', cwd: '/repo', verifyCommand: 'npm test' } }),
    )

    expect(payload.accepted).toBe(true)
  })

  test('accepted is false when verification failed even though status is success', async () => {
    const client = await connect(async () => okOutcome, verifyWith(false))

    const result = await client.callTool({ name: 'codex_continue', arguments: { sessionId: 's', prompt: 'x', cwd: '/repo', verifyCommand: 'npm test' } })
    const payload = payloadOf(result)

    expect(payload.status).toBe('success')
    expect(result.isError).toBe(false)
    expect(payload.accepted).toBe(false)
    expect((result.structuredContent as { accepted: boolean }).accepted).toBe(false)
  })

  test('accepted is false when the run failed and verification was skipped', async () => {
    const client = await connect(async () => failedOutcome, vi.fn<VerifyFn>())

    const payload = payloadOf(
      await client.callTool({ name: 'codex_execute', arguments: { prompt: 'x', cwd: '/repo', verifyCommand: 'npm test' } }),
    )

    expect(payload.status).toBe('failed')
    expect(payload.accepted).toBe(false)
  })
})


/*
 * R5.2 — redaction at the verification / notes / live-log sinks. One secret shape (`sk-` key on an
 * `OPENAI_API_KEY=` line) is reused across every sink so the assertions compare like with like.
 */
const RAW_SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz'
const SECRET_LINE = `OPENAI_API_KEY=${RAW_SECRET}`
const OPENAI_PLACEHOLDER = '[REDACTED:openai-key]'
/** Mirrors MAX_BUFFERED_CHARS in src/verification.ts (module-private there). */
const MAX_VERIFY_BUFFER_CHARS = VERIFY_OUTPUT_TAIL_CHARS * 4

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const mkCwd = (prefix: string): string => {
  const cwd = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(cwd)
  return cwd
}

/** Echo `text` from a real child process, portably (no shell-specific echo quoting). */
const printCommand = (text: string): string =>
  `"${process.execPath}" -e "console.log('${text}')"`

describe('verification output redaction (R5.2)', () => {
  test('redacts a secret printed by the verify command and reports redactions without changing passed', async () => {
    const cwd = mkCwd('codex-verify-redact-')

    const result = await runVerification(printCommand(SECRET_LINE), { cwd })

    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.outputTail).not.toContain(RAW_SECRET)
    expect(result.outputTail).toContain(`OPENAI_API_KEY=${OPENAI_PLACEHOLDER}`)
    expect(result.redactions).toBe(1)
  })

  test('omits redactions entirely when the verify command prints no secret', async () => {
    const cwd = mkCwd('codex-verify-clean-')

    const result = await runVerification(printCommand('all green'), { cwd })

    expect(result.outputTail).toContain('all green')
    expect(result).not.toHaveProperty('redactions')
  })

  test('a failing verify command still reports passed false with a redacted tail', async () => {
    const cwd = mkCwd('codex-verify-fail-')
    const command = `"${process.execPath}" -e "console.log('${SECRET_LINE}'); process.exit(3)"`

    const result = await runVerification(command, { cwd })

    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.outputTail).not.toContain(RAW_SECRET)
    expect(result.redactions).toBe(1)
  })

  // Regression for the streaming buffer: the child's output is trimmed to a fixed buffer as it
  // arrives, so a secret straddling that boundary must already be redacted by the time the trim
  // happens — otherwise its prefix is cut off, it stops matching, and it is neither counted nor
  // removed. `filler` sizes place the raw key exactly across the buffer's cut point.
  test('redacts a secret that straddles the streaming buffer boundary', async () => {
    const cwd = mkCwd('codex-verify-boundary-')
    // `sk-` only matches on a word boundary, so the leading filler must end on a separator.
    const leading = 'a '.repeat(50)
    const secretPrefixChars = 17
    // Sized so the buffer's cut point lands `secretPrefixChars` into the raw key.
    const trailingChars = MAX_VERIFY_BUFFER_CHARS - (RAW_SECRET.length - secretPrefixChars)
    const command = `"${process.execPath}" -e "process.stdout.write('${leading}' + '${RAW_SECRET}' + 'b'.repeat(${trailingChars}))"`

    const result = await runVerification(command, { cwd })

    expect(result.passed).toBe(true)
    expect(result.redactions).toBe(1)
    expect(result.outputTail).not.toContain('ijklmnopqrstuvwxyz')
  })

  test('forwards the redacted tail and redactions through the tool payload', async () => {
    const verifyFn = vi.fn<VerifyFn>(async (command) => ({
      command,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      outputTail: `OPENAI_API_KEY=${OPENAI_PLACEHOLDER}`,
      passed: true,
      redactions: 1,
    }))
    const client = await connect(async () => okOutcome, verifyFn)

    const payload = payloadOf(
      await client.callTool({
        name: 'codex_execute',
        arguments: { prompt: 'do it', cwd: '/repo', verifyCommand: 'npm test' },
      }),
    )

    expect(payload.verification).toMatchObject({ passed: true, redactions: 1 })
    expect(payload.verification.outputTail).not.toContain(RAW_SECRET)
  })
})

describe('notes redaction (R5.2)', () => {
  const parsedWithSecret = (): CodexResult => ({
    sessionId: 'redact-1',
    agentMessage: `exported ${SECRET_LINE}`,
    fileChanges: [],
    commands: [{ command: `curl -H "Authorization: Bearer ${RAW_SECRET}" https://api.example.com`, exitCode: 0 }],
    usage: null,
    errors: [],
  })

  const notesRequest = (cwd: string, overrides: Partial<NotesRequest> = {}): NotesRequest => ({
    cwd,
    sessionId: 'redact-1',
    prompt: `use ${SECRET_LINE} for the run`,
    mode: 'execute',
    parsed: parsedWithSecret(),
    exitCode: 0,
    startedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  })

  test('never writes the raw secret into a new notes file', () => {
    const cwd = mkCwd('codex-notes-redact-')

    const path = writeNotes(notesRequest(cwd))

    expect(path).not.toBeNull()
    const content = readFileSync(path as string, 'utf8')
    expect(content).not.toContain(RAW_SECRET)
    // Prompt, agent message and the recorded command all carry the key; each is redacted.
    expect(content.match(/\[REDACTED:openai-key\]/g)).toHaveLength(3)
  })

  // Redaction wraps the whole rendered body, not selected fields, so metadata lines (`- Cwd:`,
  // `- Run:`) and file-change paths are covered by the same choke point.
  test('redacts a secret embedded in metadata and in a file-change path', () => {
    const cwd = mkCwd('codex-notes-redact-meta-')

    const path = writeNotes(
      notesRequest(cwd, {
        runId: RAW_SECRET,
        parsed: {
          ...parsedWithSecret(),
          agentMessage: 'clean',
          fileChanges: [{ path: `config/${SECRET_LINE}.env`, kind: 'edit' }],
        },
      }),
    )

    const content = readFileSync(path as string, 'utf8')
    expect(content).not.toContain(RAW_SECRET)
    expect(content).toContain(`- Run: ${OPENAI_PLACEHOLDER}`)
    // The path's `KEY=<value>` shape is caught by the env-secret rule (its value runs to the
    // extension, so the whole tail is replaced) — the kind differs, the raw key is still gone.
    expect(content).toContain('config/OPENAI_API_KEY=[REDACTED:env-secret]')
  })

  test('never writes the raw secret into an appended continuation block', () => {
    const cwd = mkCwd('codex-notes-redact-cont-')
    writeNotes(notesRequest(cwd, { parsed: { ...parsedWithSecret(), agentMessage: 'clean start' }, prompt: 'clean' }))

    const path = writeNotes(notesRequest(cwd, { mode: 'continue' }))

    const content = readFileSync(path as string, 'utf8')
    expect(content).toContain('## Continuation')
    expect(content).not.toContain(RAW_SECRET)
    expect(content).toContain(OPENAI_PLACEHOLDER)
  })
})

describe('live-log redaction (R5.2)', () => {
  const TAIL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tail-progress.mjs')

  /** WriteStream flushes asynchronously; poll until the end-of-run marker lands. */
  const readSettledLog = async (logPath: string): Promise<string[]> => {
    const deadline = Date.now() + 3000
    for (;;) {
      let content = ''
      try {
        content = readFileSync(logPath, 'utf8')
      } catch {
        content = ''
      }
      const lines = content.split('\n').filter((line) => line.length > 0)
      if (lines.some((line) => line.includes(LIVE_RUN_FINISHED_TYPE))) return lines
      if (Date.now() > deadline) throw new Error(`live log never settled: ${content}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  test('redacts each live-log line while keeping it valid JSON', async () => {
    const cwd = mkCwd('codex-live-redact-')
    const view = createLiveView(cwd, { openTerminalFn: () => true })
    if (!view.logPath) throw new Error('expected a live log path')
    const event = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: `token is ${SECRET_LINE}` },
    })
    view.onStdout?.(Buffer.from(`${event}\n`))
    view.close()

    const lines = await readSettledLog(view.logPath)

    expect(lines.join('\n')).not.toContain(RAW_SECRET)
    const first = JSON.parse(lines[0] ?? '') as { item: { text: string }; at: string }
    expect(first.item.text).toBe(`token is OPENAI_API_KEY=${OPENAI_PLACEHOLDER}`)
    expect(Number.isNaN(Date.parse(first.at))).toBe(false)
    expect(JSON.parse(lines[lines.length - 1] ?? '')).toMatchObject({ type: LIVE_RUN_FINISHED_TYPE })
  })

  test('redacts a partial (non-JSON) live-log line as text', async () => {
    const cwd = mkCwd('codex-live-redact-partial-')
    const view = createLiveView(cwd, { openTerminalFn: () => true })
    if (!view.logPath) throw new Error('expected a live log path')
    view.onStdout?.(Buffer.from(`{"type":"turn.started",broken ${SECRET_LINE}\n`))
    view.close()

    const lines = await readSettledLog(view.logPath)

    expect(lines[0]).not.toContain(RAW_SECRET)
    expect(lines[0]).toContain(OPENAI_PLACEHOLDER)
  })

  test('scripts/tail-progress.mjs still parses and exits on a redacted live log', async () => {
    const cwd = mkCwd('codex-live-redact-tail-')
    const view = createLiveView(cwd, { openTerminalFn: () => true })
    if (!view.logPath) throw new Error('expected a live log path')
    view.onStdout?.(
      Buffer.from(
        `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: SECRET_LINE } })}\n`,
      ),
    )
    view.close()
    await readSettledLog(view.logPath)

    const result = spawnSync(process.execPath, [TAIL_SCRIPT, view.logPath], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_TAIL_TIMEOUT_MS: '5000' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('run finished')
    expect(result.stdout).not.toContain(RAW_SECRET)
  })

  test('a live log with an unparseable line is left unchanged when it holds no secret', async () => {
    const cwd = mkCwd('codex-live-redact-probe-')
    const logPath = join(cwd, 'probe.jsonl')
    writeFileSync(
      logPath,
      `not json at all\n${JSON.stringify({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: null, at: new Date().toISOString() })}\n`,
      'utf8',
    )

    const result = spawnSync(process.execPath, [TAIL_SCRIPT, logPath], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_TAIL_TIMEOUT_MS: '5000' },
    })

    expect(result.status, result.stderr).toBe(0)
  })
})

describe('progress notification redaction (R5.2)', () => {
  test('redacts a secret before the progress message leaves the notifier', () => {
    const send = vi.fn<(message: string, progress: number) => void>()
    const notifier = createProgressNotifier(send, 0)

    notifier.sink(
      Buffer.from(
        `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: SECRET_LINE } })}\n`,
      ),
    )
    notifier.settle()

    expect(send).toHaveBeenCalled()
    const messages = send.mock.calls.map(([message]) => message)
    expect(messages.join('\n')).not.toContain(RAW_SECRET)
    expect(messages.join('\n')).toContain(OPENAI_PLACEHOLDER)
  })

  test('leaves a secret-free progress message byte-identical', () => {
    const send = vi.fn<(message: string, progress: number) => void>()
    const notifier = createProgressNotifier(send, 0)

    notifier.sink(
      Buffer.from(
        `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'all good' } })}\n`,
      ),
    )
    notifier.settle()

    expect(send.mock.calls.map(([message]) => message).join('\n')).toContain('💬 all good')
  })
})
