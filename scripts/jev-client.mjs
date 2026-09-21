// Calls TypeSafe Jev and records optional shadow-mode comparisons.
// Usage: node scripts/jev-client.mjs ask --point <name> --json '<JevAskParams JSON>'
//        node scripts/jev-client.mjs log --point <name> --jev '<json>' --claude '<json>'

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const LOG_PATH = path.join('.codex-flow', 'notes', 'jev-shadow.log')
const RETRYABLE_STATUS = new Set([429, 529])

/** @typedef {'off'|'shadow'|'enforce'} JevMode */

/** @param {NodeJS.ProcessEnv} [env] @returns {JevMode} */
export function getJevMode(env = process.env) {
  const configured = env.CODEX_FLOW_JEV_MODE
  if (configured === 'off' || configured === 'shadow' || configured === 'enforce') return configured
  return env.TYPESAFE_API_KEY ? 'shadow' : 'off'
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

/** @param {number} milliseconds */
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * @param {{state: string|object|unknown[], questions: Record<string, object>, model?: string}} params
 * @param {{mode?: JevMode, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv}} [opts]
 */
export async function askJev(params, opts = {}) {
  const mode = opts.mode ?? getJevMode()
  const apiKey = opts.env?.TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY
  if (mode === 'off') return { available: false, mode, reason: 'off' }
  if (!apiKey) return { available: false, mode, reason: 'no-api-key' }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  try {
    let lastRetryableStatus = 429
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: params.state, questions: params.questions, model: params.model ?? 'jev-latest' }),
      })
      if (response.ok) {
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers) || (payload.usage !== undefined && (!payload.usage || typeof payload.usage !== 'object' || Array.isArray(payload.usage)))) {
          return { available: false, mode, reason: 'network-error', detail: 'malformed response' }
        }
        return { available: true, mode, answers: payload.answers, usage: payload.usage }
      }
      const detail = await response.text().catch(() => `HTTP ${response.status}`)
      if (response.status === 401 || response.status === 422) {
        return { available: false, mode, reason: 'client-error', detail }
      }
      if (!RETRYABLE_STATUS.has(response.status)) {
        return { available: false, mode, reason: response.status >= 500 ? 'server-error' : 'network-error', detail }
      }
      lastRetryableStatus = response.status
      if (attempt < 2) await wait(2 ** attempt * 100)
    }
    return { available: false, mode, reason: lastRetryableStatus === 529 ? 'server-error' : 'rate-limited' }
  } catch (error) {
    return { available: false, mode, reason: 'network-error', detail: errorMessage(error) }
  }
}

/** @param {string} point @param {unknown} jevAnswer @param {unknown} claudeDecision @param {{mode?: JevMode}} [opts] */
export function logShadowDecision(point, jevAnswer, claudeDecision, opts = {}) {
  const mode = opts.mode ?? getJevMode()
  if (mode !== 'shadow') return { logged: false }
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), point, jevAnswer, claudeDecision })}\n`)
    return { logged: true }
  } catch {
    return { logged: false }
  }
}

const argumentValue = (argv, flag) => {
  const index = argv.indexOf(flag)
  if (index < 0 || !argv[index + 1]) throw new Error(`${flag} requires a value`)
  return argv[index + 1]
}

/** @param {string[]} argv */
async function runCli(argv) {
  const command = argv[0]
  if (command === 'ask') {
    argumentValue(argv, '--point')
    const result = await askJev(JSON.parse(argumentValue(argv, '--json')))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  if (command === 'log') {
    const result = logShadowDecision(
      argumentValue(argv, '--point'),
      JSON.parse(argumentValue(argv, '--jev')),
      JSON.parse(argumentValue(argv, '--claude')),
    )
    process.stdout.write(`${JSON.stringify(result.logged ? result : { logged: false, reason: `mode=${getJevMode()}` })}\n`)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ available: false, mode: getJevMode(), reason: 'client-error', detail: errorMessage(error) })}\n`)
  })
}
