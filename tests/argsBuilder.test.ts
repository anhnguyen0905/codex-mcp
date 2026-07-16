import { describe, expect, test } from 'vitest'
import { buildContinueArgs, buildExecuteArgs } from '../src/argsBuilder.js'

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
