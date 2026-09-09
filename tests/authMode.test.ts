import { describe, expect, test } from 'vitest'
import { createAuthModeHolder, deriveAuthMode, INITIAL_AUTH_MODE, type AuthMode } from '../src/authMode.js'

/** Real `codex login status` output for a ChatGPT session (multi-line, CRLF as Windows emits it). */
const CHATGPT_STATUS_CRLF = 'Logged in using ChatGPT\r\n  Account: owner@example.com\r\n'
const API_KEY_STATUS = 'Logged in using an API key\n  Key: sk-***\n'

describe('deriveAuthMode', () => {
  test('classifies a real ChatGPT login status as chatgpt', () => {
    // Arrange
    const loginText = 'Logged in using ChatGPT'

    // Act
    const mode = deriveAuthMode(loginText)

    // Assert
    expect(mode).toBe('chatgpt')
  })

  test('classifies a multi-line CRLF ChatGPT status as chatgpt', () => {
    // Arrange / Act
    const mode = deriveAuthMode(CHATGPT_STATUS_CRLF)

    // Assert
    expect(mode).toBe('chatgpt')
  })

  test('classifies mixed-case and padded ChatGPT text as chatgpt', () => {
    // Arrange / Act
    const mode = deriveAuthMode('   lOgGeD In UsInG cHaTgPt   \n')

    // Assert
    expect(mode).toBe('chatgpt')
  })

  test('classifies an API key login status as apikey', () => {
    // Arrange / Act
    const mode = deriveAuthMode(API_KEY_STATUS)

    // Assert
    expect(mode).toBe('apikey')
  })

  test('classifies mixed-case API key text as apikey', () => {
    // Arrange / Act
    const mode = deriveAuthMode('Authenticated with an API Key\r\n')

    // Assert
    expect(mode).toBe('apikey')
  })

  test('prefers chatgpt when both markers appear, so an API-key mention cannot unlock model overrides', () => {
    // Arrange
    const loginText = 'Logged in using ChatGPT\nNo API key configured\n'

    // Act
    const mode = deriveAuthMode(loginText)

    // Assert
    expect(mode).toBe('chatgpt')
  })

  test('returns unknown for unrecognised status text', () => {
    // Arrange / Act
    const mode = deriveAuthMode('Not logged in\n')

    // Assert
    expect(mode).toBe('unknown')
  })

  test('returns unknown for empty or whitespace-only text', () => {
    // Arrange / Act / Assert
    expect(deriveAuthMode('')).toBe('unknown')
    expect(deriveAuthMode('  \r\n\t ')).toBe('unknown')
  })

  test('returns unknown for a non-string value from an untyped caller', () => {
    // Arrange
    const notText = undefined as unknown as string

    // Act
    const mode = deriveAuthMode(notText)

    // Assert
    expect(mode).toBe('unknown')
  })
})

describe('createAuthModeHolder', () => {
  test('starts at unknown so a failed detection never blocks a run', () => {
    // Arrange
    const holder = createAuthModeHolder()

    // Act
    const mode = holder.get()

    // Assert
    expect(mode).toBe('unknown')
    expect(INITIAL_AUTH_MODE).toBe('unknown')
  })

  test('returns the last mode written by set', () => {
    // Arrange
    const holder = createAuthModeHolder()

    // Act
    holder.set('chatgpt')
    holder.set('apikey')

    // Assert
    expect(holder.get()).toBe('apikey')
  })

  test('reset restores unknown', () => {
    // Arrange
    const holder = createAuthModeHolder()
    holder.set('chatgpt')

    // Act
    holder.reset()

    // Assert
    expect(holder.get()).toBe('unknown')
  })

  test('two holders are isolated, so there is no module-level state', () => {
    // Arrange
    const first = createAuthModeHolder()
    const second = createAuthModeHolder()

    // Act
    first.set('chatgpt')

    // Assert
    expect(first.get()).toBe('chatgpt')
    expect(second.get()).toBe('unknown')
  })

  test('ignores an invalid mode from an untyped caller and keeps the current value', () => {
    // Arrange
    const holder = createAuthModeHolder()
    holder.set('apikey')

    // Act
    holder.set('bogus' as AuthMode)

    // Assert
    expect(holder.get()).toBe('apikey')
  })
})
