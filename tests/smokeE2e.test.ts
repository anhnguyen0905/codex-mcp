import { describe, expect, test } from 'vitest'

import {
  AssertionFailure,
  PreconditionFailure,
  assertThat,
  parseToolPayload,
  toolText,
} from '../scripts/smoke-e2e.mjs'

describe('assertThat', () => {
  test('does nothing when condition is true', () => {
    expect(() => assertThat(true, 'should not throw')).not.toThrow()
  })

  test('throws AssertionFailure with message and payload when condition is false', () => {
    const payload = { sessionId: null }

    let caught: unknown
    try {
      assertThat(false, 'missing sessionId', payload)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AssertionFailure)
    expect((caught as AssertionFailure).message).toBe('missing sessionId')
    expect((caught as AssertionFailure & { payload: unknown }).payload).toBe(payload)
  })
})

describe('toolText', () => {
  test('returns the first text block of a tool result', () => {
    const result = { content: [{ type: 'text', text: 'hello' }] }

    expect(toolText(result, 'codex_health')).toBe('hello')
  })

  test('throws AssertionFailure when the result has no text content', () => {
    expect(() => toolText({ content: [] }, 'codex_health')).toThrow(AssertionFailure)
    expect(() => toolText(undefined, 'codex_health')).toThrow(/codex_health/)
  })
})

describe('parseToolPayload', () => {
  test('parses the text block as JSON', () => {
    const result = { content: [{ type: 'text', text: '{"loggedIn":true}' }] }

    expect(parseToolPayload(result, 'codex_health')).toEqual({ loggedIn: true })
  })

  test('throws AssertionFailure with the raw text when JSON is invalid', () => {
    const result = { content: [{ type: 'text', text: 'not json' }] }

    let caught: unknown
    try {
      parseToolPayload(result, 'codex_execute')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AssertionFailure)
    expect((caught as AssertionFailure & { payload: unknown }).payload).toBe('not json')
  })
})

describe('PreconditionFailure', () => {
  test('carries message and payload', () => {
    const failure = new PreconditionFailure('precondition failed: codex not logged in', { loggedIn: false })

    expect(failure.name).toBe('PreconditionFailure')
    expect(failure.message).toContain('not logged in')
    expect((failure as PreconditionFailure & { payload: unknown }).payload).toEqual({ loggedIn: false })
  })
})
