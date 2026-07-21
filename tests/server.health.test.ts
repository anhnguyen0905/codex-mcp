import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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
