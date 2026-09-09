/**
 * Secret redaction for anything this server returns to the client or writes to disk.
 *
 * Every pattern here is deliberately *bounded*: no unbounded quantifier is ever nested inside
 * another, and every repetition carries an explicit upper limit. Codex stdout/stderr is untrusted,
 * arbitrarily long, attacker-influencable text, so a pattern with catastrophic backtracking would
 * be a denial-of-service vector rather than a redaction bug. When a construct has to span lines
 * (PEM blocks) it uses a lazy, length-capped `[\s\S]{0,N}?` instead of a greedy `[\s\S]*`.
 *
 * Recall is preferred over precision — a redacted non-secret costs readability, a missed secret
 * costs a credential — with one exception: the documented false-positive corpus in
 * `tests/redaction.test.ts` (URLs, git shas, UUIDs, numeric `*_COUNT` values, prose) must stay
 * byte-identical, because redacting those would make normal output unreadable.
 */

export interface RedactionPattern {
  /** Kind label that appears in the replacement token, e.g. `openai-key`. */
  readonly kind: string
  /**
   * Global, bounded matcher. The matched text is replaced by `[REDACTED:<kind>]`.
   *
   * Convention: if the pattern declares capture group 1, that group MUST be a *leading* prefix
   * (e.g. `Bearer `, `DB_PASSWORD="`) and is preserved verbatim in the output, so the line still
   * reads as an assignment or a header. Only the remainder of the match is replaced.
   */
  readonly pattern: RegExp
}

export interface RedactedText {
  readonly text: string
  readonly redactions: number
}

export interface RedactedJsonLine {
  readonly line: string
  readonly redactions: number
}

/** Deepest JSON nesting `redactJsonLine` will walk before giving up and redacting as plain text. */
const MAX_JSON_DEPTH = 64

/** A replacement token this module already produced; re-matching it must not inflate counts. */
const PLACEHOLDER_PATTERN = /^\[REDACTED:[a-z0-9-]{1,40}\]$/

/**
 * `KEY` … `=` / `:` prefix whose key name contains a secret-ish word (R5.1 says *contains*, so
 * `AWS_SECRET_ACCESS_KEY` and `db.password` both qualify). Every repetition is explicitly bounded
 * so a long line cannot make this expensive, and the whole prefix is capture group 1 — it is kept
 * in the output while only the value after it is replaced. `<q>` is substituted per quote style.
 */
const secretKeyPrefix = (openingQuote: string): string =>
  `([A-Za-z0-9_.-]{0,40}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_.-]{0,40}["']?\\s{0,10}[=:]\\s{0,10}${openingQuote})`

/**
 * A purely numeric value is never a credential (`TOKEN_COUNT=12`, `MAX_TOKENS=4096`), so the
 * unquoted key/value rule skips it.
 */
const NOT_A_BARE_NUMBER = '(?!\\d{1,20}(?![\\w-]))'

/**
 * Ordered redaction table. Order is load-bearing: multi-line and provider-specific shapes run
 * before the generic `KEY=value` rule so a match reports the most specific kind it qualifies for.
 */
export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = Object.freeze([
  {
    kind: 'pem-private-key',
    pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
  },
  // Requires the `eyJ` (`{"`) header prefix, which keeps 40-hex git shas and UUIDs out.
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,4000}\.[A-Za-z0-9_-]{4,4000}\.[A-Za-z0-9_-]{4,4000}/g },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,120}/g },
  {
    kind: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}|\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
  },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws-secret-access-key',
    pattern: /(aws_secret_access_key["']?\s{0,10}[=:]\s{0,10}["']?)[A-Za-z0-9/+=_-]{20,100}/gi,
  },
  { kind: 'slack-token', pattern: /\bxox[abopsr]-[A-Za-z0-9-]{10,255}/g },
  { kind: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}/g },
  // Group 1 keeps the `Bearer ` scheme visible so the line still reads as an auth header.
  { kind: 'bearer-token', pattern: /(\bBearer\s{1,4})[A-Za-z0-9._~+/=-]{8,4000}/gi },
  // Quoted values run first and consume up to the matching close quote, so a passphrase with
  // spaces (`PASSWORD="correct horse battery staple"`) is redacted whole, never just its first word.
  { kind: 'env-secret', pattern: new RegExp(`${secretKeyPrefix('"')}[^"\\n]{6,400}`, 'gi') },
  { kind: 'env-secret', pattern: new RegExp(`${secretKeyPrefix("'")}[^'\\n]{6,400}`, 'gi') },
  // Unquoted value: stops at whitespace or a list separator, and never fires on a quoted value
  // (already handled above) or a bare number.
  {
    kind: 'env-secret',
    pattern: new RegExp(`${secretKeyPrefix('')}(?!["'])${NOT_A_BARE_NUMBER}[^\\s,;]{6,400}`, 'gi'),
  },
])

/**
 * Apply one pattern, preserving capture group 1 as a leading prefix and counting only matches that
 * were not already a replacement token (which is what makes the whole module idempotent).
 */
const applyPattern = (text: string, { kind, pattern }: RedactionPattern): RedactedText => {
  let redactions = 0
  const replaced = text.replace(pattern, (match, ...groups: ReadonlyArray<unknown>) => {
    const prefix = typeof groups[0] === 'string' ? groups[0] : ''
    if (PLACEHOLDER_PATTERN.test(match.slice(prefix.length))) return match
    redactions += 1
    return `${prefix}[REDACTED:${kind}]`
  })
  return { text: replaced, redactions }
}

/**
 * Replace every known secret shape in `text` with `[REDACTED:<kind>]`.
 *
 * Pure and idempotent: re-running it over its own output returns the same text and reports
 * `redactions: 0`, because an existing replacement token is recognised and left alone.
 */
export const redactSecrets = (text: string): RedactedText => {
  if (typeof text !== 'string') {
    throw new TypeError(`redactSecrets expects a string, received ${typeof text}`)
  }
  return REDACTION_PATTERNS.reduce<RedactedText>(
    (accumulator, entry) => {
      const step = applyPattern(accumulator.text, entry)
      return { text: step.text, redactions: accumulator.redactions + step.redactions }
    },
    { text, redactions: 0 },
  )
}

interface RedactedJsonValue {
  readonly value: unknown
  readonly redactions: number
}

const sumRedactions = (parts: ReadonlyArray<RedactedJsonValue>): number =>
  parts.reduce((total, part) => total + part.redactions, 0)

/** Recursively rebuild a parsed JSON value with every string leaf redacted. Never mutates input. */
const redactJsonValue = (value: unknown, depth: number): RedactedJsonValue => {
  if (depth > MAX_JSON_DEPTH) {
    throw new RangeError(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels`)
  }
  if (typeof value === 'string') {
    const redacted = redactSecrets(value)
    return { value: redacted.text, redactions: redacted.redactions }
  }
  if (Array.isArray(value)) {
    const redactedItems = (value as ReadonlyArray<unknown>).map((item) => redactJsonValue(item, depth + 1))
    return {
      value: redactedItems.map((item) => item.value),
      redactions: sumRedactions(redactedItems),
    }
  }
  if (value !== null && typeof value === 'object') {
    const redactedEntries = Object.entries(value).map(
      ([key, item]): readonly [string, RedactedJsonValue] => [key, redactJsonValue(item, depth + 1)],
    )
    return {
      value: Object.fromEntries(redactedEntries.map(([key, item]) => [key, item.value])),
      redactions: sumRedactions(redactedEntries.map(([, item]) => item)),
    }
  }
  return { value, redactions: 0 }
}

/**
 * Redact a single line that is expected to be JSON (a live-log or JSONL record).
 *
 * On success the line round-trips through `JSON.parse` → leaf redaction → `JSON.stringify`, so the
 * output is always still valid JSON. Anything that is not parsable JSON — or is nested past
 * `MAX_JSON_DEPTH` — is redacted as plain text instead; that fallback is the defined behaviour for
 * partial or non-JSON lines, not a swallowed error, and it never returns unredacted content.
 */
export const redactJsonLine = (line: string): RedactedJsonLine => {
  if (typeof line !== 'string') {
    throw new TypeError(`redactJsonLine expects a string, received ${typeof line}`)
  }
  try {
    const parsed: unknown = JSON.parse(line)
    const redacted = redactJsonValue(parsed, 0)
    const serialized = JSON.stringify(redacted.value)
    if (serialized === undefined) throw new TypeError('parsed JSON is not re-serializable')
    return { line: serialized, redactions: redacted.redactions }
  } catch {
    const redacted = redactSecrets(line)
    return { line: redacted.text, redactions: redacted.redactions }
  }
}
