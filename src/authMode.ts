/**
 * Codex auth mode (R3.1, R3.3). Derived from the `codex login status` text the health probe
 * already collects — no extra process is spawned for it. The mode gates the `model` override
 * (C2): a ChatGPT-auth host rejects `--model` with an API 400, so the guard must fail closed on
 * `chatgpt` and stay out of the way for everything else.
 */
export type AuthMode = 'chatgpt' | 'apikey' | 'unknown'

/** Mode a fresh holder starts at, and the value `reset()` restores. */
export const INITIAL_AUTH_MODE: AuthMode = 'unknown'

const AUTH_MODES: readonly AuthMode[] = ['chatgpt', 'apikey', 'unknown']

// Checked in this order: a ChatGPT session that merely *mentions* an API key must still classify
// as chatgpt, never the other way round.
const CHATGPT_PATTERN = /logged in using chatgpt/i
const API_KEY_PATTERN = /api key/i

/**
 * Classify `codex login status` output. CRLF-safe and whitespace-tolerant; never throws.
 * Untrusted input (CLI stdout, possibly from a future CLI version): anything unrecognised —
 * including a non-string from an untyped caller — yields `unknown`, which blocks nothing.
 */
export const deriveAuthMode = (loginText: string): AuthMode => {
  if (typeof loginText !== 'string') return INITIAL_AUTH_MODE
  const normalized = loginText.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) return INITIAL_AUTH_MODE
  if (CHATGPT_PATTERN.test(normalized)) return 'chatgpt'
  if (API_KEY_PATTERN.test(normalized)) return 'apikey'
  return INITIAL_AUTH_MODE
}

/** Per-server-instance store for the detected auth mode. */
export interface AuthModeHolder {
  get(): AuthMode
  set(mode: AuthMode): void
  reset(): void
}

/**
 * Create an auth-mode holder. One per server instance (created in `createServer`, never at module
 * level) so concurrent servers and tests cannot see each other's mode. An unrecognised mode is
 * ignored rather than stored, so a bad write can never widen the model guard.
 */
export const createAuthModeHolder = (): AuthModeHolder => {
  let current: AuthMode = INITIAL_AUTH_MODE
  return {
    get: (): AuthMode => current,
    set: (mode: AuthMode): void => {
      if (!AUTH_MODES.includes(mode)) return
      current = mode
    },
    reset: (): void => {
      current = INITIAL_AUTH_MODE
    },
  }
}
