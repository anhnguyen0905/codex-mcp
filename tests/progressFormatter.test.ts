import { describe, expect, test } from 'vitest'
import { formatEvent, LIVE_RUN_FINISHED_TYPE } from '../src/progressFormatter.js'

const line = (value: unknown): string => JSON.stringify(value)
const BENIGN_NOTICE =
  '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.'

describe('formatEvent', () => {
  test('formats thread.started with session id', () => {
    expect(formatEvent(line({ type: 'thread.started', thread_id: 'sess-1' }))).toContain('sess-1')
  })

  test('formats an agent message', () => {
    const out = formatEvent(line({ type: 'item.completed', item: { type: 'agent_message', text: 'hi there' } }))
    expect(out).toContain('hi there')
  })

  test('formats a command execution with exit code', () => {
    const out = formatEvent(
      line({ type: 'item.completed', item: { type: 'command_execution', command: 'pytest', exit_code: 0 } }),
    )
    expect(out).toContain('pytest')
    expect(out).toContain('0')
  })

  test('formats a file change with count and paths', () => {
    const out = formatEvent(
      line({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.py', kind: 'add' }, { path: 'b.py', kind: 'update' }] },
      }),
    )
    expect(out).toContain('a.py')
    expect(out).toContain('b.py')
  })

  test('formats an error item', () => {
    const out = formatEvent(line({ type: 'item.completed', item: { type: 'error', message: 'boom' } }))
    expect(out).toContain('boom')
  })

  test('formats an allowlisted error item as a warning', () => {
    const out = formatEvent(
      line({ type: 'item.completed', item: { type: 'error', message: BENIGN_NOTICE } }),
    )

    expect(out).toContain(`⚠ ${BENIGN_NOTICE}`)
    expect(out).not.toContain('✗')
  })

  test('formats turn.completed with token usage', () => {
    const out = formatEvent(
      line({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
    )
    expect(out).toContain('100')
    expect(out).toContain('20')
  })

  test('formats turn.failed with error message', () => {
    const out = formatEvent(line({ type: 'turn.failed', error: { message: 'model died' } }))
    expect(out).toContain('model died')
  })

  test('formats an allowlisted turn.failed notice without a failure marker', () => {
    const out = formatEvent(
      line({ type: 'turn.failed', error: { message: BENIGN_NOTICE } }),
    )

    expect(out).toContain(`⚠ ${BENIGN_NOTICE}`)
    expect(out).not.toContain('turn failed')
    expect(out).not.toContain('✗')
  })

  test('returns null for non-JSON lines', () => {
    expect(formatEvent('Reading additional input from stdin...')).toBeNull()
  })

  test('returns null for skipped event types', () => {
    expect(formatEvent(line({ type: 'turn.started' }))).toBeNull()
    expect(formatEvent(line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }))).toBeNull()
  })

  test('returns null for empty input', () => {
    expect(formatEvent('')).toBeNull()
    expect(formatEvent('   ')).toBeNull()
  })

  test('formats the live end-of-run marker with session id and status', () => {
    const out = formatEvent(line({ type: LIVE_RUN_FINISHED_TYPE, status: 'completed', sessionId: 'sess-9' }))
    expect(out).toContain('=== run sess-9 finished: completed ===')
  })
})
