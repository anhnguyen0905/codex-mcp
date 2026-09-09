import { describe, expect, test } from 'vitest'
import { REDACTION_PATTERNS, redactJsonLine, redactSecrets } from '../src/redaction.js'

/**
 * Synthetic credentials only — every value below is invented for this test and matches the *shape*
 * of a real credential, never a live one.
 */
const SAMPLES: ReadonlyArray<{ readonly kind: string; readonly input: string; readonly secret: string }> = [
  {
    kind: 'openai-key',
    secret: 'sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2',
    input: 'export OPENAI_API_KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2',
  },
  {
    kind: 'github-token',
    secret: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    input: 'remote url https://ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com/o/r.git',
  },
  {
    kind: 'github-token',
    secret: 'gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    input: 'oauth token gho_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 acquired',
  },
  {
    kind: 'github-token',
    secret: 'github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefgh',
    input: 'gh auth: github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789abcdefgh',
  },
  {
    kind: 'aws-access-key-id',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    input: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
  },
  {
    kind: 'aws-secret-access-key',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    input: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  {
    kind: 'slack-token',
    // Assembled at runtime so no literal Slack-shaped token sits in the repository (push protection).
    secret: ['xoxb', '1234567890', '0987654321', 'AbCdEfGhIjKlMnOp'].join('-'),
    input: 'slack webhook auth ' + ['xoxb', '1234567890', '0987654321', 'AbCdEfGhIjKlMnOp'].join('-'),
  },
  {
    kind: 'google-api-key',
    secret: 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
    input: 'maps key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q in config',
  },
  {
    kind: 'bearer-token',
    secret: 'aBcDeF1234567890gHiJkLmN',
    input: 'Authorization: Bearer aBcDeF1234567890gHiJkLmN',
  },
  {
    kind: 'jwt',
    secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    input:
      'id_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  },
  {
    kind: 'pem-private-key',
    secret: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2C3d4E5f6\nG7h8I9j0K1l2M3n4O5p6Q7r8S9t0\n-----END RSA PRIVATE KEY-----',
    input:
      'key material:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2C3d4E5f6\nG7h8I9j0K1l2M3n4O5p6Q7r8S9t0\n-----END RSA PRIVATE KEY-----\ndone',
  },
  {
    kind: 'env-secret',
    secret: 'hunter2-correct-horse',
    input: 'DB_PASSWORD=hunter2-correct-horse',
  },
  {
    kind: 'env-secret',
    secret: 'sh-abcdefghijklmnop',
    input: 'CLIENT_SECRET: sh-abcdefghijklmnop',
  },
  {
    kind: 'env-secret',
    secret: 'quoted-secret-value',
    input: "PASSWD='quoted-secret-value'",
  },
  {
    kind: 'env-secret',
    secret: 'json-shaped-secret',
    input: '"private_key_password": "json-shaped-secret"',
  },
  {
    kind: 'env-secret',
    secret: 'correct horse battery staple',
    input: 'PASSWORD="correct horse battery staple"',
  },
  {
    kind: 'env-secret',
    secret: 'correct horse battery staple',
    input: "API_KEY='correct horse battery staple'",
  },
]

/** Every kind R5.1 requires, each of which must also be exercised behaviorally by SAMPLES. */
const REQUIRED_KINDS: ReadonlyArray<string> = [
  'openai-key',
  'github-token',
  'aws-access-key-id',
  'aws-secret-access-key',
  'slack-token',
  'google-api-key',
  'bearer-token',
  'jwt',
  'pem-private-key',
  'env-secret',
]

/**
 * Documented false-positive corpus (R5.1). These strings look credential-adjacent but carry no
 * secret; redacting them would make ordinary Codex output unreadable, so they must stay
 * byte-identical forever. Extend this list rather than relaxing it.
 */
const FALSE_POSITIVES: ReadonlyArray<{ readonly label: string; readonly input: string }> = [
  { label: 'https URL with a query token', input: 'https://example.com/watch?v=abc123&list=PL0aBcDeFgHiJkLmNoPqRs' },
  { label: '40-hex git sha', input: 'commit 9e107d9d372bb6826bd81d3542a419d6d1b7a2f7c0ffee1234567890abcdef12' },
  { label: 'short git sha in prose', input: 'reverted in 060a66c after review' },
  { label: 'uuid v4', input: 'session 01a08437-7300-7bd2-b153-298cd4d3294e finished' },
  { label: 'numeric TOKEN_COUNT', input: 'TOKEN_COUNT=12' },
  { label: 'numeric MAX_TOKENS with colon', input: 'MAX_TOKENS: 4096' },
  { label: 'password policy prose', input: 'Our password policy requires rotation every 90 days.' },
  { label: 'Authorization header name alone', input: 'Authorization' },
  { label: 'plain prose', input: 'The reviewer asked for a secret handshake but got a code review instead.' },
]

describe('REDACTION_PATTERNS', () => {
  test('every pattern is global so all occurrences on a line are replaced', () => {
    // Arrange / Act
    const nonGlobal = REDACTION_PATTERNS.filter((entry) => !entry.pattern.flags.includes('g'))

    // Assert
    expect(nonGlobal.map((entry) => entry.kind)).toEqual([])
  })

  test('covers every kind required by R5.1', () => {
    // Act
    const kinds = REDACTION_PATTERNS.map((entry) => entry.kind)

    // Assert
    for (const kind of REQUIRED_KINDS) expect(kinds).toContain(kind)
  })

  test('every required kind is proven by a behavioral sample, not just a label', () => {
    // Arrange
    const exercised = new Set(SAMPLES.map((sample) => sample.kind))

    // Act
    const unexercised = REQUIRED_KINDS.filter((kind) => !exercised.has(kind))

    // Assert
    expect(unexercised).toEqual([])
  })
})

describe('redactSecrets', () => {
  for (const sample of SAMPLES) {
    test(`redacts ${sample.kind}: ${sample.input.slice(0, 32)}…`, () => {
      // Act
      const result = redactSecrets(sample.input)

      // Assert
      expect(result.text).not.toContain(sample.secret)
      expect(result.text).toContain(`[REDACTED:${sample.kind}]`)
      expect(result.redactions).toBe(1)
    })
  }

  test('redacts a quoted passphrase whole, leaving the key and quotes readable', () => {
    // Arrange
    const input = 'DB_PASSWORD="correct horse battery staple"'

    // Act
    const result = redactSecrets(input)

    // Assert
    expect(result.text).toBe('DB_PASSWORD="[REDACTED:env-secret]"')
    expect(result.redactions).toBe(1)
  })

  test('keeps the Bearer scheme and the key name while replacing only the secret', () => {
    // Arrange
    const input = 'Authorization: Bearer aBcDeF1234567890gHiJkLmN'

    // Act
    const result = redactSecrets(input)

    // Assert
    expect(result.text).toBe('Authorization: Bearer [REDACTED:bearer-token]')
  })

  test('counts each occurrence separately', () => {
    // Arrange
    const input = 'first sk-A1b2C3d4E5f6G7h8I9j0K1l2 then sk-Z9y8X7w6V5u4T3s2R1q0P9o8'

    // Act
    const result = redactSecrets(input)

    // Assert
    expect(result.redactions).toBe(2)
    expect(result.text).toBe('first [REDACTED:openai-key] then [REDACTED:openai-key]')
  })

  test('is idempotent: a second pass changes nothing and reports zero redactions', () => {
    // Arrange
    const input = SAMPLES.map((sample) => sample.input).join('\n')

    // Act
    const first = redactSecrets(input)
    const second = redactSecrets(first.text)

    // Assert
    expect(second.text).toBe(first.text)
    expect(second.redactions).toBe(0)
  })

  test('returns clean text unchanged with zero redactions', () => {
    // Arrange
    const input = 'ran 12 tests, 0 failed'

    // Act
    const result = redactSecrets(input)

    // Assert
    expect(result).toEqual({ text: input, redactions: 0 })
  })

  test('handles empty input', () => {
    // Act / Assert
    expect(redactSecrets('')).toEqual({ text: '', redactions: 0 })
  })

  test('rejects a non-string input at the boundary', () => {
    // Act / Assert
    expect(() => redactSecrets(undefined as unknown as string)).toThrow(TypeError)
  })

  for (const item of FALSE_POSITIVES) {
    test(`leaves the false-positive corpus untouched: ${item.label}`, () => {
      // Act
      const result = redactSecrets(item.input)

      // Assert
      expect(result.text).toBe(item.input)
      expect(result.redactions).toBe(0)
    })
  }

  test('leaves the whole false-positive corpus untouched when concatenated', () => {
    // Arrange
    const corpus = FALSE_POSITIVES.map((item) => item.input).join('\n')

    // Act
    const result = redactSecrets(corpus)

    // Assert
    expect(result.text).toBe(corpus)
    expect(result.redactions).toBe(0)
  })

  test('completes quickly on a long adversarial line (no catastrophic backtracking)', () => {
    // Arrange: a long run of characters the token patterns partially accept, with no terminator.
    const hostile = `API_KEY="${'sk-'.repeat(4000)}`

    // Act
    const startedAt = Date.now()
    redactSecrets(hostile)
    const elapsedMs = Date.now() - startedAt

    // Assert
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('redactJsonLine', () => {
  test('redacts string leaves and still returns valid JSON', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'item',
      env: { OPENAI_API_KEY: 'sk-A1b2C3d4E5f6G7h8I9j0K1l2' },
      args: ['--header', 'Authorization: Bearer aBcDeF1234567890gHiJkLmN'],
      count: 12,
      ok: true,
      missing: null,
    })

    // Act
    const result = redactJsonLine(line)
    const parsed = JSON.parse(result.line) as {
      env: { OPENAI_API_KEY: string }
      args: string[]
      count: number
      ok: boolean
      missing: null
    }

    // Assert
    expect(result.redactions).toBe(2)
    expect(parsed.env.OPENAI_API_KEY).toBe('[REDACTED:openai-key]')
    expect(parsed.args[1]).toBe('Authorization: Bearer [REDACTED:bearer-token]')
    expect(parsed.count).toBe(12)
    expect(parsed.ok).toBe(true)
    expect(parsed.missing).toBeNull()
  })

  test('preserves object keys and does not mutate the parsed shape', () => {
    // Arrange
    const line = '{"nested":{"list":[{"token":"ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}]}}'

    // Act
    const result = redactJsonLine(line)

    // Assert
    expect(result.line).toBe('{"nested":{"list":[{"token":"[REDACTED:github-token]"}]}}')
    expect(result.redactions).toBe(1)
  })

  test('round-trips a clean JSON line with zero redactions', () => {
    // Arrange
    const line = '{"type":"turn.completed","tokens":4096}'

    // Act
    const result = redactJsonLine(line)

    // Assert
    expect(JSON.parse(result.line)).toEqual({ type: 'turn.completed', tokens: 4096 })
    expect(result.redactions).toBe(0)
  })

  test('falls back to text redaction on a truncated JSON line', () => {
    // Arrange
    const line = '{"env":{"OPENAI_API_KEY":"sk-A1b2C3d4E5f6G7h8I9j0K1l2"'

    // Act
    const result = redactJsonLine(line)

    // Assert
    expect(result.line).toBe('{"env":{"OPENAI_API_KEY":"[REDACTED:openai-key]"')
    expect(result.redactions).toBe(1)
    expect(() => JSON.parse(result.line)).toThrow()
  })

  test('falls back to text redaction on a non-JSON log line', () => {
    // Arrange
    const line = 'codex: using key sk-A1b2C3d4E5f6G7h8I9j0K1l2'

    // Act
    const result = redactJsonLine(line)

    // Assert
    expect(result.line).toBe('codex: using key [REDACTED:openai-key]')
    expect(result.redactions).toBe(1)
  })

  test('falls back to text redaction when JSON nesting is pathologically deep', () => {
    // Arrange
    const depth = 200
    const line = `${'['.repeat(depth)}"sk-A1b2C3d4E5f6G7h8I9j0K1l2"${']'.repeat(depth)}`

    // Act
    const result = redactJsonLine(line)

    // Assert
    expect(result.line).not.toContain('sk-A1b2C3d4E5f6G7h8I9j0K1l2')
    expect(result.redactions).toBe(1)
  })

  test('is idempotent over a JSON line', () => {
    // Arrange
    const line = '{"a":"sk-A1b2C3d4E5f6G7h8I9j0K1l2","b":"Bearer aBcDeF1234567890gHiJkLmN"}'

    // Act
    const first = redactJsonLine(line)
    const second = redactJsonLine(first.line)

    // Assert
    expect(second.line).toBe(first.line)
    expect(second.redactions).toBe(0)
  })

  test('rejects a non-string input at the boundary', () => {
    // Act / Assert
    expect(() => redactJsonLine(null as unknown as string)).toThrow(TypeError)
  })
})
