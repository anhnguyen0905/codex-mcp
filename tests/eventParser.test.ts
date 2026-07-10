import { describe, expect, test } from 'vitest'
import { parseEvents } from '../src/eventParser.js'

const line = (value: unknown): string => JSON.stringify(value)

describe('parseEvents', () => {
  test('extracts session id from thread.started event', () => {
    // Arrange
    const jsonl = line({ type: 'thread.started', thread_id: 'abc-123' })

    // Act
    const result = parseEvents(jsonl)

    // Assert
    expect(result.sessionId).toBe('abc-123')
  })

  test('extracts final agent message from item.completed events', () => {
    const jsonl = [
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.agentMessage).toBe('final answer')
  })

  test('collects file changes with path and kind', () => {
    const jsonl = line({
      type: 'item.completed',
      item: {
        type: 'file_change',
        changes: [
          { path: '/repo/a.ts', kind: 'add' },
          { path: '/repo/b.ts', kind: 'update' },
        ],
      },
    })

    const result = parseEvents(jsonl)

    expect(result.fileChanges).toEqual([
      { path: '/repo/a.ts', kind: 'add' },
      { path: '/repo/b.ts', kind: 'update' },
    ])
  })

  test('collects executed commands with exit codes', () => {
    const jsonl = line({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'npm test', exit_code: 0 },
    })

    const result = parseEvents(jsonl)

    expect(result.commands).toEqual([{ command: 'npm test', exitCode: 0 }])
  })

  test('extracts token usage from turn.completed event', () => {
    const jsonl = line({
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    })

    const result = parseEvents(jsonl)

    expect(result.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 5,
    })
  })

  test('records turn.failed events as errors', () => {
    const jsonl = line({ type: 'turn.failed', error: { message: 'model exploded' } })

    const result = parseEvents(jsonl)

    expect(result.errors).toEqual(['model exploded'])
  })

  test('records error items as errors', () => {
    const jsonl = line({
      type: 'item.completed',
      item: { type: 'error', message: 'sandbox denied' },
    })

    const result = parseEvents(jsonl)

    expect(result.errors).toEqual(['sandbox denied'])
  })

  test('skips non-JSON lines without throwing', () => {
    const jsonl = [
      'Reading additional input from stdin...',
      line({ type: 'thread.started', thread_id: 'xyz' }),
      'Shell cwd was reset to /somewhere',
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.sessionId).toBe('xyz')
    expect(result.errors).toEqual([])
  })

  test('returns empty result for empty input', () => {
    const result = parseEvents('')

    expect(result).toEqual({
      sessionId: null,
      agentMessage: null,
      fileChanges: [],
      commands: [],
      usage: null,
      errors: [],
    })
  })

  test('ignores unknown event and item types', () => {
    const jsonl = [
      line({ type: 'turn.started' }),
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } }),
      line({ type: 'some.future.event', payload: 1 }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.agentMessage).toBeNull()
    expect(result.errors).toEqual([])
  })
})
