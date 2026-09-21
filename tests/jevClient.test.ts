import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { askJev, getJevMode, loadDotEnv, logShadowDecision } from '../scripts/jev-client.mjs'

const originalKey = process.env.TYPESAFE_API_KEY
const originalMode = process.env.CODEX_FLOW_JEV_MODE

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = originalKey
  if (originalMode === undefined) delete process.env.CODEX_FLOW_JEV_MODE
  else process.env.CODEX_FLOW_JEV_MODE = originalMode
  vi.restoreAllMocks()
})

describe('getJevMode', () => {
  test('defaults to off without an API key and shadow with one', () => {
    expect(getJevMode({})).toBe('off')
    expect(getJevMode({ TYPESAFE_API_KEY: 'secret' })).toBe('shadow')
  })

  test('loads an API key from .env in the current working directory', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    const originalCwd = process.cwd()
    delete process.env.TYPESAFE_API_KEY
    await writeFile(path.join(tempDir, '.env'), 'TYPESAFE_API_KEY="from-dotenv"\n')
    process.chdir(tempDir)
    try {
      loadDotEnv()
      expect(getJevMode()).toBe('shadow')
      expect(process.env.TYPESAFE_API_KEY).toBe('from-dotenv')
    } finally {
      process.chdir(originalCwd)
    }
  })

  test('does not override an existing API key with .env', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    const originalCwd = process.cwd()
    process.env.TYPESAFE_API_KEY = 'from-environment'
    await writeFile(path.join(tempDir, '.env'), 'TYPESAFE_API_KEY=from-dotenv\n')
    process.chdir(tempDir)
    try {
      loadDotEnv()
      expect(process.env.TYPESAFE_API_KEY).toBe('from-environment')
    } finally {
      process.chdir(originalCwd)
    }
  })

  test('silently ignores a missing .env file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    const originalCwd = process.cwd()
    delete process.env.TYPESAFE_API_KEY
    process.chdir(tempDir)
    try {
      expect(() => loadDotEnv()).not.toThrow()
      expect(getJevMode()).toBe('off')
    } finally {
      process.chdir(originalCwd)
    }
  })
})

describe('askJev', () => {
  test('returns unavailable without a key and does not call fetch', async () => {
    delete process.env.TYPESAFE_API_KEY
    const fetchImpl = vi.fn()

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow' })

    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'no-api-key' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('sends a Choice request with the expected headers and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { lane: { type: 'choice', choice: 'fast', confidence: 0.9, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 2 } }),
    })
    const params = { state: { task: 'x' }, questions: { lane: { type: 'choice', instructions: 'Choose', criteria: { fast: 'yes' } } } }

    const result = await askJev(params, { fetchImpl, mode: 'shadow', env: { TYPESAFE_API_KEY: 'secret' } })
    const [url, request] = fetchImpl.mock.calls[0]

    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(request).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } })
    expect(JSON.parse(request.body)).toEqual({ ...params, model: 'jev-latest' })
    expect(result).toMatchObject({ available: true, mode: 'shadow' })
  })

  test('retries three times on 429 and returns the eventual success', async () => {
    process.env.TYPESAFE_API_KEY = 'secret'
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'busy' })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'busy' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) })

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow' })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ available: true })
  }, 10000)

  test('returns client error immediately for 401', async () => {
    process.env.TYPESAFE_API_KEY = 'secret'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid key' })

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'client-error', detail: 'invalid key' })
  })

  test('returns client error immediately for 422 without retrying', async () => {
    process.env.TYPESAFE_API_KEY = 'secret'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid request' })

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'client-error', detail: 'invalid request' })
  })

  test('returns server error after exhausting 529 retries', async () => {
    process.env.TYPESAFE_API_KEY = 'secret'
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 529, text: async () => 'overloaded' })

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow' })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'server-error' })
  }, 10000)

  test('returns network error for a malformed response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ usage: {} }) })

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow', env: { TYPESAFE_API_KEY: 'secret' } })

    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'network-error', detail: 'malformed response' })
  })

  test('returns network error when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection failed'))

    const result = await askJev({ state: 'state', questions: {} }, { fetchImpl, mode: 'shadow', env: { TYPESAFE_API_KEY: 'secret' } })

    expect(result).toEqual({ available: false, mode: 'shadow', reason: 'network-error', detail: 'connection failed' })
  })

  test('labels malformed CLI JSON as a client error', () => {
    const output = execFileSync(process.execPath, ['scripts/jev-client.mjs', 'ask', '--point', 'test', '--json', '{'], { encoding: 'utf8' })

    expect(JSON.parse(output)).toMatchObject({ available: false, reason: 'client-error' })
  })

  test('returns a client error when the ask point is missing', () => {
    const output = execFileSync(process.execPath, ['scripts/jev-client.mjs', 'ask', '--json', '{}'], { encoding: 'utf8' })

    expect(JSON.parse(output)).toMatchObject({ available: false, reason: 'client-error' })
  })

  test('does not write the API key in client-error output', () => {
    const key = 'jev-test-key-that-must-not-leak'
    const output = execFileSync(process.execPath, ['scripts/jev-client.mjs', 'ask', '--point', 'test', '--json', '{'], {
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: key },
    })

    expect(output).not.toContain(key)
  })

  test('does not write the API key in log CLI output', () => {
    const key = 'jev-log-test-key-that-must-not-leak'
    const output = execFileSync(process.execPath, ['scripts/jev-client.mjs', 'log', '--point', 'test', '--jev', '{}', '--claude', '{}'], {
      encoding: 'utf8',
      env: { ...process.env, TYPESAFE_API_KEY: key },
    })

    expect(output).not.toContain(key)
  })
})

describe('logShadowDecision', () => {
  test('writes exactly one JSONL line in shadow mode and none in off mode', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    const originalCwd = process.cwd()
    process.chdir(tempDir)
    try {
      expect(logShadowDecision('point', { choice: 'fast' }, { lane: 'fast' }, { mode: 'shadow' })).toEqual({ logged: true })
      expect(logShadowDecision('ignored', {}, {}, { mode: 'off' })).toEqual({ logged: false })
      const lines = (await readFile(path.join(tempDir, '.codex-flow/notes/jev-shadow.log'), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ point: 'point', jevAnswer: { choice: 'fast' }, claudeDecision: { lane: 'fast' } })
    } finally {
      process.chdir(originalCwd)
    }
  })

  test('never writes the API key to the shadow log', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    const key = 'jev-shadow-secret-that-must-not-leak'
    const originalCwd = process.cwd()
    process.env.TYPESAFE_API_KEY = key
    process.chdir(tempDir)
    try {
      expect(logShadowDecision('point', { choice: 'fast' }, { lane: 'fast' }, { mode: 'shadow' })).toEqual({ logged: true })
      const content = await readFile(path.join(tempDir, '.codex-flow/notes/jev-shadow.log'), 'utf8')
      expect(content).not.toContain(key)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test('returns logged false when writing the shadow log fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jev-client-'))
    await writeFile(path.join(tempDir, '.codex-flow'), 'not a directory')
    const originalCwd = process.cwd()
    process.chdir(tempDir)
    try {
      expect(logShadowDecision('point', {}, {}, { mode: 'shadow' })).toEqual({ logged: false })
    } finally {
      process.chdir(originalCwd)
    }
  })
})
