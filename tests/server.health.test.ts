import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunOutcomeWithEvents } from '../src/codexRunner.js'
import {
  HEALTH_PROBE_PROMPT,
  MAX_PROBE_MESSAGE_CHARS,
  runExecProbe,
  type ExecProbeStatus,
} from '../src/healthProbe.js'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'

const versionOutcome: RunOutcome = { stdout: 'codex-cli 0.144.1', stderr: '', exitCode: 0, timedOut: false }

const connect = async (runFn: (args: string[], opts: { cwd: string }) => Promise<RunOutcome>) => {
  const server = createServer({ runFn })
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}

const parse = (r: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((r.content as Array<{ text: string }>)[0].text) as {
    version: string
    loggedIn: boolean
    loginProbe: string
    loginStatus: string
    authMode: string
    execProbe?: ExecProbeStatus
    execProbeMessage?: string
  }

describe('codex_health login probe states (T4.5)', () => {
  let runFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    runFn = vi.fn()
  })

  test('logged in: probe ok, loggedIn true', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('ok')
    expect(payload.loggedIn).toBe(true)
  })

  test('clean not-logged-in (probe succeeded): probe ok, loggedIn false', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      // codex CLI exits non-zero when not logged in, but the probe itself worked.
      .mockResolvedValueOnce({ stdout: 'Not logged in', stderr: '', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('ok')
    expect(payload.loggedIn).toBe(false)
  })

  test('probe timeout is reported as timeout, never as a plain not-logged-in', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, timedOut: true })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('timeout')
    expect(payload.loggedIn).toBe(false)
  })

  test('probe failure (non-zero exit without a recognizable answer) is reported as failed', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: '', stderr: 'spawn codex ENOENT', exitCode: 1, timedOut: false })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('failed')
    expect(payload.loggedIn).toBe(false)
  })

  test('an aborted probe is reported as failed, not as logged-out', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('failed')
    expect(payload.loggedIn).toBe(false)
  })

  test('a hung probe whose text looks logged-in still reports timeout and loggedIn false', async () => {
    runFn
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: null, timedOut: true })
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(payload.loginProbe).toBe('timeout')
    expect(payload.loggedIn).toBe(false)
  })
})

describe('codex_health deep exec probe (R3.1, R3.2)', () => {
  let runFn: ReturnType<typeof vi.fn>

  const loginOutcome: RunOutcome = {
    stdout: 'Logged in using ChatGPT',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  }
  const cleanProbe: RunOutcome = { stdout: '{"type":"turn.completed"}', stderr: '', exitCode: 0, timedOut: false }

  const probeOutcome = (overrides: Partial<RunOutcomeWithEvents>): RunOutcomeWithEvents => ({
    ...cleanProbe,
    ...overrides,
  })

  const deepPayload = async (probe: RunOutcomeWithEvents) => {
    runFn.mockResolvedValueOnce(versionOutcome).mockResolvedValueOnce(loginOutcome).mockResolvedValueOnce(probe)
    const client = await connect(runFn)
    return parse(await client.callTool({ name: 'codex_health', arguments: { deep: true } }))
  }

  beforeEach(() => {
    runFn = vi.fn()
  })

  test('without deep the payload keeps exactly the legacy fields and spawns no probe', async () => {
    runFn.mockResolvedValueOnce(versionOutcome).mockResolvedValueOnce(loginOutcome)
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    expect(Object.keys(payload)).toEqual([
      'version',
      'loggedIn',
      'loginProbe',
      'loginStatus',
      'authMode',
    ])
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  test('an explicit deep false behaves like an absent deep: legacy fields, no probe', async () => {
    runFn.mockResolvedValueOnce(versionOutcome).mockResolvedValueOnce(loginOutcome)
    const client = await connect(runFn)

    const payload = parse(await client.callTool({ name: 'codex_health', arguments: { deep: false } }))

    expect(Object.keys(payload)).toEqual([
      'version',
      'loggedIn',
      'loginProbe',
      'loginStatus',
      'authMode',
    ])
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  test('deep true dispatches exactly one bounded read-only exec probe with the fixed prompt', async () => {
    const payload = await deepPayload(probeOutcome({}))

    expect(runFn).toHaveBeenCalledTimes(3)
    const [args, options] = runFn.mock.calls[2] as [string[], { stdinInput?: string; timeoutMs?: number }]
    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      process.cwd(),
      '--sandbox',
      'read-only',
      '--',
      '-',
    ])
    expect(options.stdinInput).toBe(HEALTH_PROBE_PROMPT)
    expect(options.timeoutMs).toBeGreaterThan(0)
    expect(payload.execProbe).toBe('ok')
    expect(payload.execProbeMessage).toBe('probe completed')
  })

  test('the out-of-credits signature observed on 2026-09-08 classifies as quota', async () => {
    const payload = await deepPayload(
      probeOutcome({
        stderr: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
        exitCode: 1,
      }),
    )

    expect(payload.execProbe).toBe('quota')
    expect(payload.execProbeMessage).toContain('out of credits')
  })

  test('the newer-version signature in parsed errors classifies as model', async () => {
    const payload = await deepPayload(
      probeOutcome({
        exitCode: 1,
        parsed: {
          sessionId: null,
          agentMessage: null,
          fileChanges: [],
          commands: [],
          usage: null,
          errors: [
            "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
          ],
          parseErrors: 0,
          unknownEvents: 0,
          sawCompletion: false,
          warnings: [],
          turnCount: 0,
        },
      }),
    )

    expect(payload.execProbe).toBe('model')
    expect(payload.execProbeMessage).toContain('requires a newer version of Codex')
  })

  test('the missing model-metadata signature classifies as model', async () => {
    const payload = await deepPayload(
      probeOutcome({ stderr: "Model metadata for 'gpt-6-astra' not found", exitCode: 1 }),
    )

    expect(payload.execProbe).toBe('model')
  })

  test('a signature that only reaches the raw JSONL stdout still classifies', async () => {
    const payload = await deepPayload(
      probeOutcome({
        stdout: '{"type":"error","message":"Your workspace is out of credits."}',
        exitCode: 1,
      }),
    )

    expect(payload.execProbe).toBe('quota')
  })

  test('quota wins over the model signature when both appear', async () => {
    const payload = await deepPayload(
      probeOutcome({
        stderr: "Model metadata for 'gpt-6-astra' not found\nYour workspace is out of credits.",
        exitCode: 1,
      }),
    )

    expect(payload.execProbe).toBe('quota')
  })

  test('an unrecognized probe failure classifies as error with a bounded message', async () => {
    const payload = await deepPayload(
      probeOutcome({ stdout: '', stderr: 'x'.repeat(2000), exitCode: 1 }),
    )

    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage?.length).toBeLessThanOrEqual(MAX_PROBE_MESSAGE_CHARS)
  })

  test('a probe that exits zero with empty stdout classifies as error, never as ok', async () => {
    // Arrange / Act
    const payload = await deepPayload(probeOutcome({ stdout: '', exitCode: 0 }))

    // Assert
    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage).toBe('probe exited 0 without a completed turn')
  })

  test('a probe that exits zero with parseable events but no completion marker classifies as error', async () => {
    // Arrange / Act
    const payload = await deepPayload(
      probeOutcome({
        stdout: '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}',
        exitCode: 0,
      }),
    )

    // Assert
    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage).toBe('probe exited 0 without a completed turn')
  })

  test('a probe that exits zero with unparseable JSONL lines classifies as error', async () => {
    // Arrange / Act
    const payload = await deepPayload(
      probeOutcome({ stdout: '{"type":"turn.completed"}\nnot json at all', exitCode: 0 }),
    )

    // Assert
    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage).toBe('probe exited 0 with unparseable events')
  })

  test('a probe whose raw stdout reports an error event before turn.completed classifies as error', async () => {
    // Arrange / Act
    const payload = await deepPayload(
      probeOutcome({ stdout: '{"type":"item.completed","item":{"type":"error","message":"upstream failure"}}\n{"type":"turn.completed"}', exitCode: 0 }),
    )

    // Assert
    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage).toBe('upstream failure')
  })

  test('a timed-out probe classifies as error, never as ok', async () => {
    const payload = await deepPayload(probeOutcome({ stdout: '', exitCode: null, timedOut: true }))

    expect(payload.execProbe).toBe('error')
    expect(payload.execProbeMessage).toContain('timed out')
  })

  test('an aborted request skips the probe without spawning a process', async () => {
    const runProbe = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const result = await runExecProbe(runProbe as never, {
      cwd: process.cwd(),
      timeoutMs: 1000,
      signal: controller.signal,
    })

    expect(result.execProbe).toBe('skipped')
    expect(runProbe).not.toHaveBeenCalled()
  })

  test('a runner rejection is reported as error rather than propagating', async () => {
    const runProbe = vi.fn().mockRejectedValue(new Error('spawn codex ENOENT'))

    const result = await runExecProbe(runProbe as never, { cwd: process.cwd(), timeoutMs: 1000 })

    expect(result).toEqual({ execProbe: 'error', execProbeMessage: 'spawn codex ENOENT' })
  })
})

describe('codex_health authMode (R3.1, C1)', () => {
  const loginOutcome = (stdout: string): RunOutcome => ({
    stdout,
    stderr: '',
    exitCode: 0,
    timedOut: false,
  })

  const healthPayload = async (loginStdout: string) => {
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce(loginOutcome(loginStdout))
    const client = await connect(runFn as never)
    return parse(await client.callTool({ name: 'codex_health', arguments: {} }))
  }

  test('reports chatgpt for a ChatGPT login without spawning an extra process', async () => {
    // Arrange
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce(loginOutcome('Logged in using ChatGPT'))
    const client = await connect(runFn as never)

    // Act
    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    // Assert — still exactly two spawns: --version and login status.
    expect(payload.authMode).toBe('chatgpt')
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  test('reports apikey for an API-key login', async () => {
    // Arrange / Act
    const payload = await healthPayload('Logged in using an API key')

    // Assert
    expect(payload.authMode).toBe('apikey')
  })

  test('reports unknown for unrecognised login text', async () => {
    // Arrange / Act
    const payload = await healthPayload('Not logged in')

    // Assert
    expect(payload.authMode).toBe('unknown')
  })

  test('re-detects the mode on every call, so a re-login is picked up', async () => {
    // Arrange — one server, two health calls with different login text.
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce(loginOutcome('Logged in using ChatGPT'))
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce(loginOutcome('Logged in using an API key'))
    const client = await connect(runFn as never)

    // Act
    const first = parse(await client.callTool({ name: 'codex_health', arguments: {} }))
    const second = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    // Assert
    expect(first.authMode).toBe('chatgpt')
    expect(second.authMode).toBe('apikey')
  })
})

describe('codex_health authMode when the login probe itself failed (R3.3)', () => {
  const CHATGPT_TEXT = 'Logged in using ChatGPT'
  const RUN_JSONL = [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n')

  /** One health round-trip with a broken login probe, then a `model` override on codex_execute. */
  const healthThenOverride = async (login: RunOutcome) => {
    const runFn = vi.fn(async (args: string[]) => {
      if (args[0] === '--version') return versionOutcome
      if (args[0] === 'login') return login
      return { stdout: RUN_JSONL, stderr: '', exitCode: 0, timedOut: false } satisfies RunOutcome
    })
    const client = await connect(runFn as never)
    const health = parse(await client.callTool({ name: 'codex_health', arguments: {} }))
    const run = await client.callTool({
      name: 'codex_execute',
      arguments: { prompt: 'go', cwd: '/repo', model: 'gpt-5.1-codex' },
    })
    return { health, run }
  }

  test('a timed-out probe whose text looks like ChatGPT reports unknown and does not block model', async () => {
    // Arrange / Act
    const { health, run } = await healthThenOverride({
      stdout: CHATGPT_TEXT,
      stderr: '',
      exitCode: null,
      timedOut: true,
    })

    // Assert — unknown is permissive: the override must reach Codex.
    expect(health.loginProbe).toBe('timeout')
    expect(health.authMode).toBe('unknown')
    expect(run.isError ?? false).toBe(false)
  })

  test('an aborted probe whose text looks like ChatGPT reports unknown and does not block model', async () => {
    // Arrange / Act
    const { health, run } = await healthThenOverride({
      stdout: CHATGPT_TEXT,
      stderr: '',
      exitCode: null,
      timedOut: false,
      aborted: true,
    })

    // Assert
    expect(health.loginProbe).toBe('failed')
    expect(health.authMode).toBe('unknown')
    expect(run.isError ?? false).toBe(false)
  })

  test('a non-zero probe with no recognizable answer reports unknown', async () => {
    // Arrange
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: CHATGPT_TEXT, stderr: 'boom', exitCode: 3, timedOut: false })
    const client = await connect(runFn as never)

    // Act
    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} }))

    // Assert
    expect(payload.loginProbe).toBe('failed')
    expect(payload.authMode).toBe('unknown')
  })
})

describe('codex_health redacts returned CLI text (C4)', () => {
  const SECRET = 'sk-live-abcdefghijklmnop0123456789'

  test('loginStatus is redacted and the count is reported', async () => {
    // Arrange
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({
        stdout: `Logged in using an API key ${SECRET}`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      })
    const client = await connect(runFn as never)

    // Act
    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} })) as {
      loginStatus: string
      authMode: string
      redactions?: number
    }

    // Assert
    expect(payload.loginStatus).not.toContain(SECRET)
    expect(payload.loginStatus).toContain('[REDACTED:openai-key]')
    expect(payload.authMode).toBe('apikey')
    expect(payload.redactions).toBe(1)
  })

  test('execProbeMessage is redacted too', async () => {
    // Arrange
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: `stream error: usage limit reached for ${SECRET}`,
        exitCode: 1,
        timedOut: false,
      })
    const client = await connect(runFn as never)

    // Act
    const payload = parse(await client.callTool({ name: 'codex_health', arguments: { deep: true } })) as {
      execProbeMessage?: string
      redactions?: number
    }

    // Assert
    expect(payload.execProbeMessage).not.toContain(SECRET)
    expect(payload.execProbeMessage).toContain('[REDACTED:openai-key]')
    expect(payload.redactions).toBe(1)
  })

  test('clean health text carries no redactions field', async () => {
    // Arrange
    const runFn = vi
      .fn()
      .mockResolvedValueOnce(versionOutcome)
      .mockResolvedValueOnce({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0, timedOut: false })
    const client = await connect(runFn as never)

    // Act
    const payload = parse(await client.callTool({ name: 'codex_health', arguments: {} })) as {
      redactions?: number
    }

    // Assert
    expect(payload.redactions).toBeUndefined()
  })
})
