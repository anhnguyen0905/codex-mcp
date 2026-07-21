import { describe, expect, test } from 'vitest'
import {
  MAX_PROMPT_BYTES,
  buildContinueArgs,
  buildContinueInvocation,
  buildExecuteArgs,
  buildExecuteInvocation,
} from '../src/argsBuilder.js'

describe('buildExecuteArgs', () => {
  test('builds args for a new execution with cwd and sandbox', () => {
    const args = buildExecuteArgs({
      prompt: 'implement the plan',
      cwd: '/repo',
      sandbox: 'workspace-write',
    })

    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/repo',
      '--sandbox',
      'workspace-write',
      '--',
      'implement the plan',
    ])
  })

  test('includes model flag when model is provided', () => {
    const args = buildExecuteArgs({
      prompt: 'do it',
      cwd: '/repo',
      sandbox: 'read-only',
      model: 'gpt-5.1-codex',
    })

    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.1-codex')
  })

  test('separates a dash-prefixed prompt with `--` so it is not parsed as a flag', () => {
    const args = buildExecuteArgs({ prompt: '--help me', cwd: '/repo', sandbox: 'read-only' })
    // prompt is the last element, immediately preceded by the end-of-options marker
    expect(args[args.length - 1]).toBe('--help me')
    expect(args[args.length - 2]).toBe('--')
  })

  test('throws when prompt is empty', () => {
    expect(() =>
      buildExecuteArgs({ prompt: '   ', cwd: '/repo', sandbox: 'read-only' }),
    ).toThrow(/prompt/i)
  })

  test('throws when model starts with a dash', () => {
    expect(() =>
      buildExecuteArgs({ prompt: 'go', cwd: '/repo', sandbox: 'read-only', model: '-weird' }),
    ).toThrow(/model/i)
  })

  test('throws when cwd is not an absolute path', () => {
    expect(() =>
      buildExecuteArgs({ prompt: 'go', cwd: 'relative/path', sandbox: 'read-only' }),
    ).toThrow(/absolute/i)
  })
})

describe('buildContinueArgs', () => {
  test('builds resume args with sandbox passed as config override', () => {
    const args = buildContinueArgs({
      sessionId: 'abc-123',
      prompt: 'fix the review findings',
      sandbox: 'workspace-write',
    })

    expect(args).toEqual([
      'exec',
      'resume',
      'abc-123',
      '--json',
      '--skip-git-repo-check',
      '--config',
      'sandbox_mode="workspace-write"',
      '--',
      'fix the review findings',
    ])
  })

  test('includes model flag when model is provided', () => {
    const args = buildContinueArgs({
      sessionId: 'abc-123',
      prompt: 'continue',
      sandbox: 'read-only',
      model: 'gpt-5.1-codex',
    })

    expect(args).toContain('--model')
  })

  test('throws when session id is empty', () => {
    expect(() =>
      buildContinueArgs({ sessionId: '', prompt: 'go', sandbox: 'read-only' }),
    ).toThrow(/session/i)
  })

  test('throws when session id starts with a dash (would be parsed as a flag)', () => {
    expect(() =>
      buildContinueArgs({ sessionId: '-abc123', prompt: 'go', sandbox: 'read-only' }),
    ).toThrow(/session/i)
  })

  test('throws when prompt is empty', () => {
    expect(() =>
      buildContinueArgs({ sessionId: 'abc', prompt: '', sandbox: 'read-only' }),
    ).toThrow(/prompt/i)
  })
})

describe('buildExecuteInvocation', () => {
  test('passes `-` as the prompt positional and returns the prompt for stdin', () => {
    // Arrange / Act
    const invocation = buildExecuteInvocation({
      prompt: 'implement the plan',
      cwd: '/repo',
      sandbox: 'workspace-write',
    })

    // Assert: prompt never appears in argv (process listings, E2BIG)
    expect(invocation.args[invocation.args.length - 1]).toBe('-')
    expect(invocation.args[invocation.args.length - 2]).toBe('--')
    expect(invocation.args).not.toContain('implement the plan')
    expect(invocation.stdinInput).toBe('implement the plan')
  })

  test('keeps the same leading args as buildExecuteArgs', () => {
    const input = { prompt: 'go', cwd: '/repo', sandbox: 'read-only' as const, model: 'gpt-5.1-codex' }

    const invocation = buildExecuteInvocation(input)
    const legacy = buildExecuteArgs(input)

    expect(invocation.args.slice(0, -1)).toEqual(legacy.slice(0, -1))
  })

  test('still rejects an empty prompt and a relative cwd', () => {
    expect(() =>
      buildExecuteInvocation({ prompt: '  ', cwd: '/repo', sandbox: 'read-only' }),
    ).toThrow(/prompt/i)
    expect(() =>
      buildExecuteInvocation({ prompt: 'go', cwd: 'rel/path', sandbox: 'read-only' }),
    ).toThrow(/absolute/i)
  })

  test('accepts a 2MB prompt', () => {
    const prompt = 'a'.repeat(2 * 1024 * 1024)

    const invocation = buildExecuteInvocation({ prompt, cwd: '/repo', sandbox: 'read-only' })

    expect(invocation.stdinInput).toBe(prompt)
  })

  test('rejects a prompt over MAX_PROMPT_BYTES with a clear message', () => {
    const prompt = 'a'.repeat(MAX_PROMPT_BYTES + 1)

    expect(() =>
      buildExecuteInvocation({ prompt, cwd: '/repo', sandbox: 'read-only' }),
    ).toThrow(/prompt.*exceeds.*5MB/i)
  })
})

describe('buildContinueInvocation', () => {
  test('passes `-` as the prompt positional and returns the prompt for stdin', () => {
    const invocation = buildContinueInvocation({
      sessionId: 'abc-123',
      prompt: 'fix the review findings',
      sandbox: 'workspace-write',
    })

    expect(invocation.args[invocation.args.length - 1]).toBe('-')
    expect(invocation.args[invocation.args.length - 2]).toBe('--')
    expect(invocation.args).not.toContain('fix the review findings')
    expect(invocation.stdinInput).toBe('fix the review findings')
  })

  test('keeps sessionId validation from buildContinueArgs', () => {
    expect(() =>
      buildContinueInvocation({ sessionId: '-abc', prompt: 'go', sandbox: 'read-only' }),
    ).toThrow(/session/i)
  })

  test('rejects a prompt over MAX_PROMPT_BYTES with a clear message', () => {
    const prompt = 'a'.repeat(MAX_PROMPT_BYTES + 1)

    expect(() =>
      buildContinueInvocation({ sessionId: 'abc', prompt, sandbox: 'read-only' }),
    ).toThrow(/prompt.*exceeds.*5MB/i)
  })
})
