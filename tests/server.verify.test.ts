import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test, vi } from 'vitest'
import { createServer } from '../src/server.js'
import type { RunOutcome } from '../src/types.js'
import type { VerifyFn } from '../src/verification.js'

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
