import { describe, expect, test } from 'vitest'
import { createIncrementalParser, parseEvents } from '../src/eventParser.js'

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
      parseErrors: 0,
      unknownEvents: 0,
      sawCompletion: false,
      warnings: [],
      turnCount: 0,
    })
  })

  test('survives malformed file_change items without crashing the whole parse', () => {
    const jsonl = [
      line({ type: 'thread.started', thread_id: 'sess-1' }),
      line({ type: 'item.completed', item: { type: 'file_change', changes: [null] } }),
      line({ type: 'item.completed', item: { type: 'file_change', changes: 'oops' } }),
      line({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'ok.ts', kind: 'edit' }] } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    // The bad items are skipped, but the good ones (and the rest of the run) still parse.
    expect(result.sessionId).toBe('sess-1')
    expect(result.agentMessage).toBe('done')
    expect(result.fileChanges).toEqual([{ path: 'ok.ts', kind: 'edit' }])
  })

  test('ignores unknown event and item types', () => {
    const jsonl = [
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } }),
      line({ type: 'some.future.event', payload: 1 }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.agentMessage).toBeNull()
    expect(result.errors).toEqual([])
  })

  test('handles turn.started as a known event (not counted as unknown)', () => {
    const jsonl = [
      line({ type: 'thread.started', thread_id: 'sess-1' }),
      line({ type: 'turn.started' }),
      line({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.unknownEvents).toBe(0)
    expect(result.sawCompletion).toBe(true)
  })

  test('counts one turn per turn.started event', () => {
    const jsonl = [
      line({ type: 'turn.started' }),
      line({ type: 'turn.completed', usage: { input_tokens: 1 } }),
      line({ type: 'turn.started' }),
      line({ type: 'turn.completed', usage: { input_tokens: 2 } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.turnCount).toBe(2)
  })
})

describe('parseEvents warnings plumbing', () => {
  test('exposes an empty warnings array (no protocol-level discriminator exists in 0.144.6)', () => {
    const result = parseEvents(line({ type: 'turn.completed', usage: { input_tokens: 1 } }))

    expect(result.warnings).toEqual([])
  })

  test('keeps every error item in errors[] (fail-closed: never reclassified as warning)', () => {
    const jsonl = [
      line({ type: 'item.completed', item: { type: 'error', message: 'MCP client for `x` failed to start' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.errors).toEqual(['MCP client for `x` failed to start'])
    expect(result.warnings).toEqual([])
  })
})

describe('parseEvents counters', () => {
  test('counts malformed JSON lines as parseErrors without aborting the parse', () => {
    const jsonl = [
      '{not json at all',
      line({ type: 'thread.started', thread_id: 'sess-1' }),
      'plain text noise',
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.parseErrors).toBe(2)
    expect(result.sessionId).toBe('sess-1')
  })

  test('does not count blank lines as parseErrors', () => {
    const jsonl = ['', '   ', line({ type: 'thread.started', thread_id: 'x' }), ''].join('\n')

    const result = parseEvents(jsonl)

    expect(result.parseErrors).toBe(0)
  })

  test('counts unhandled event types and item types as unknownEvents', () => {
    const jsonl = [
      line({ type: 'turn.started' }), // known since 0.144.6 canary — must NOT count as unknown
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } }),
      line({ type: 'some.future.event', payload: 1 }),
      line({ type: 'thread.started', thread_id: 'x' }),
    ].join('\n')

    const result = parseEvents(jsonl)

    expect(result.unknownEvents).toBe(2)
    expect(result.parseErrors).toBe(0)
  })

  test('sets sawCompletion when a turn.completed event is present', () => {
    const jsonl = line({ type: 'turn.completed', usage: { input_tokens: 1 } })

    const result = parseEvents(jsonl)

    expect(result.sawCompletion).toBe(true)
  })

  test('sets sawCompletion when a turn.failed event terminates the run', () => {
    const jsonl = line({ type: 'turn.failed', error: { message: 'boom' } })

    const result = parseEvents(jsonl)

    expect(result.sawCompletion).toBe(true)
  })

  test('leaves sawCompletion false when the stream ends without a terminal event', () => {
    const jsonl = line({ type: 'thread.started', thread_id: 'x' })

    const result = parseEvents(jsonl)

    expect(result.sawCompletion).toBe(false)
  })
})

describe('createIncrementalParser', () => {
  test('parses a JSON line split across two chunks as one event', () => {
    // Arrange
    const full = line({ type: 'thread.started', thread_id: 'split-session' }) + '\n'
    const parser = createIncrementalParser()

    // Act
    parser.push(full.slice(0, 15))
    parser.push(full.slice(15))
    parser.end()

    // Assert
    const result = parser.result()
    expect(result.sessionId).toBe('split-session')
    expect(result.parseErrors).toBe(0)
  })

  test('processes a final unterminated line on end()', () => {
    const parser = createIncrementalParser()

    parser.push(line({ type: 'turn.completed', usage: { input_tokens: 3 } })) // no trailing newline
    parser.end()

    const result = parser.result()
    expect(result.sawCompletion).toBe(true)
    expect(result.usage?.inputTokens).toBe(3)
  })

  test('accepts Buffer chunks and reassembles a multi-byte character split across chunks', () => {
    const payload = Buffer.from(line({ type: 'item.completed', item: { type: 'agent_message', text: 'héllo' } }) + '\n')
    const splitAt = payload.indexOf(Buffer.from('é')) + 1 // cut inside the 2-byte é
    const parser = createIncrementalParser()

    parser.push(payload.subarray(0, splitAt))
    parser.push(payload.subarray(splitAt))
    parser.end()

    expect(parser.result().agentMessage).toBe('héllo')
  })

  test('counts a malformed line as a parseError and keeps parsing later lines', () => {
    const parser = createIncrementalParser()

    parser.push('{broken\n')
    parser.push(line({ type: 'thread.started', thread_id: 'ok' }) + '\n')
    parser.end()

    const result = parser.result()
    expect(result.parseErrors).toBe(1)
    expect(result.sessionId).toBe('ok')
  })

  test('counts unknown event types as unknownEvents', () => {
    const parser = createIncrementalParser()

    parser.push(line({ type: 'mystery.event' }) + '\n')
    parser.end()

    expect(parser.result().unknownEvents).toBe(1)
  })

  test('matches the batch parseEvents result for the same input', () => {
    const jsonl = [
      line({ type: 'thread.started', thread_id: 's' }),
      'garbage line',
      line({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0 } }),
      line({ type: 'turn.completed', usage: { input_tokens: 9 } }),
    ].join('\n')
    const parser = createIncrementalParser()

    for (const char of jsonl) parser.push(char) // worst case: one-byte chunks
    parser.end()

    expect(parser.result()).toEqual(parseEvents(jsonl))
  })

  test('ignores pushes after end() so late pipe stragglers cannot corrupt the result', () => {
    const parser = createIncrementalParser()
    parser.push(line({ type: 'thread.started', thread_id: 'done' }) + '\n')
    parser.end()

    parser.push(line({ type: 'thread.started', thread_id: 'late' }) + '\n')

    expect(parser.result().sessionId).toBe('done')
  })
})
