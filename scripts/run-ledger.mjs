import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { foldVietnamese, translateVietnamese } from './skill-terms.mjs'
import { ENGLISH_STOP_WORDS, VIETNAMESE_STOP_WORDS } from './skill-match.mjs'

const DEFAULT_LEDGER = path.join(homedir(), '.codex-mcp', 'run-ledger.jsonl')
const LANES = ['full', 'fast-path-analysis', 'fast-path-small', 'brainstorm']
const PROFILES = ['code', 'data', 'design', 'plan', 'content', 'mixed']
const LANGUAGES = ['vi', 'en', 'mixed']
const OUTCOMES = ['accepted', 'rejected', 'parked', 'delivered', 'done', 'escalated', 'failed', 'abandoned']
const MODES = ['off', 'shadow', 'enforce']
const LANGUAGE_MODES = ['off', 'on']
const APPEND_FLAGS = new Set([
  'lane', 'project', 'run-id', 'profile', 'domain', 'request', 'request-file', 'language',
  'skills', 'fix-rounds', 'codex-tokens', 'started', 'owner-gates', 'bypasses', 'outcome',
  'profile-mode', 'evidence-mode', 'language-mode',
])
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const validStarted = (value, now = Date.now()) => ISO_DATE_TIME.test(value)
  && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 5 * 60 * 1000
const nonNegativeInt = (value) => Number.isInteger(value) && value >= 0
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = (value) => typeof value === 'string'
const VIETNAMESE_LETTER_PATTERN = new RegExp([
  '[đăâêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồ',
  'ốổỗộ',
  'ờớởỡợùúủũụừứửữựỳýỷỹỵ]',
].join(''), 'i')
const redactPatterns = [
  ['pem-private-key', /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{4,4000}\.[A-Za-z0-9_-]{4,4000}\.[A-Za-z0-9_-]{4,4000}/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{16,120}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}|\bgithub_pat_[A-Za-z0-9_]{20,255}/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['aws-secret-access-key', /(aws_secret_access_key["']?\s{0,10}[=:]\s{0,10}["']?)[A-Za-z0-9/+=_-]{20,100}/gi],
  ['slack-token', /\bxox[abopsr]-[A-Za-z0-9-]{10,255}/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}/g],
  ['bearer-token', /(\bBearer\s{1,4})[A-Za-z0-9._~+/=-]{8,4000}/gi],
  ['env-secret', new RegExp([
    '([A-Za-z0-9_.-]{0,40}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)',
    '[A-Za-z0-9_.-]{0,40}["\']?\\s{0,10}[=:]\\s{0,10}")[^"\\n]{6,400}',
  ].join(''), 'gi')],
  ['env-secret', new RegExp([
    '([A-Za-z0-9_.-]{0,40}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)',
    '[A-Za-z0-9_.-]{0,40}["\']?\\s{0,10}[=:]\\s{0,10}\')[^\'\\n]{6,400}',
  ].join(''), 'gi')],
  ['env-secret', new RegExp([
    '([A-Za-z0-9_.-]{0,40}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)',
    '[A-Za-z0-9_.-]{0,40}["\']?\\s{0,10}[=:]\\s{0,10})',
    '(?!["\'])(?!\\d{1,20}(?![\\w-]))[^\\s,;]{6,400}',
  ].join(''), 'gi')],
]

/** Parse append arguments into validated values. */
export function parseAppendArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument: ${flag ?? ''}`)
    const name = flag.slice(2)
    if (!APPEND_FLAGS.has(name)) throw new Error(`unknown argument: ${flag}`)
    const rawValue = argv[i + 1]
    if (typeof rawValue !== 'string' || rawValue.startsWith('--')) throw new Error(`${flag} requires a value`)
    i += 1
    const key = name.replaceAll('-', '')
    values[key] = ['skills', 'bypasses'].includes(name) ? rawValue.split(',').filter(Boolean) : rawValue
  }
  if ((values.request === undefined) === (values.requestfile === undefined)) {
    throw new Error('provide exactly one request input')
  }
  if (!LANES.includes(values.lane) || !PROFILES.includes(values.profile) || !OUTCOMES.includes(values.outcome)) {
    throw new Error('invalid enum value')
  }
  if (!values.project || !path.isAbsolute(values.project) || !values.runid || !values.domain
    || values.domain.length > 80) {
    throw new Error('missing or invalid required field')
  }
  if (!nonNegativeInt(Number(values.fixrounds)) || !nonNegativeInt(Number(values.ownergates))) {
    throw new Error('counts must be non-negative integers')
  }
  if (values.codextokens !== undefined && !nonNegativeInt(Number(values.codextokens))) {
    throw new Error('codex tokens must be non-negative')
  }
  if (!validStarted(values.started)) throw new Error('--started must be a recent ISO date-time')
  if (values.language !== undefined && !LANGUAGES.includes(values.language)) throw new Error('invalid language')
  if (values.profilemode !== undefined && !MODES.includes(values.profilemode)) throw new Error('invalid profile mode')
  if (values.evidencemode !== undefined && !MODES.includes(values.evidencemode)) {
    throw new Error('invalid evidence mode')
  }
  if (values.languagemode !== undefined && !LANGUAGE_MODES.includes(values.languagemode)) {
    throw new Error('invalid language mode')
  }
  return {
    ...values,
    fixRounds: Number(values.fixrounds),
    ownerGates: Number(values.ownergates),
    codexTokens: values.codextokens === undefined ? null : Number(values.codextokens),
    runId: values.runid,
    profileMode: values.profilemode,
    evidenceMode: values.evidencemode,
    languageMode: values.languagemode,
  }
}

/** Detect Vietnamese, English, or mixed language from alphabetic words. */
export function detectLanguage(text) {
  const tokens = [...text.matchAll(/\p{L}+/gu)].map((match) => ({
    original: match[0], folded: foldVietnamese(match[0]),
  }))
  const folded = tokens.map(({ folded: token }) => token).join(' ')
  const { consumed } = translateVietnamese(folded)
  const offsets = []
  let offset = 0
  for (const token of tokens) {
    const start = offset
    offset += token.folded.length
    offsets.push([start, offset])
    offset += 1
  }
  const coveredByGlossary = (index) => consumed.some(([start, end]) => (
    offsets[index][0] >= start && offsets[index][1] <= end
  ))
  const isVietnameseStopWord = (token) => VIETNAMESE_STOP_WORDS.has(token.folded)
    && !ENGLISH_STOP_WORDS.has(token.folded)
    && !(token.original.length >= 2 && token.original === token.original.toUpperCase())
  const stopSignals = tokens.filter(isVietnameseStopWord).length
  const signalIndexes = tokens.map((token, index) => (
    VIETNAMESE_LETTER_PATTERN.test(token.original) || isVietnameseStopWord(token) || coveredByGlossary(index)
      ? index : -1
  )).filter((index) => index >= 0)
  const hasAccentedVietnamese = tokens.some(({ original }) => VIETNAMESE_LETTER_PATTERN.test(original))
  const signals = hasAccentedVietnamese || signalIndexes.length >= 2 ? signalIndexes : []
  const vietnamese = stopSignals >= 1 && signals.length >= 2 ? tokens.length : signals.length
  const share = tokens.length === 0 ? 0 : vietnamese / tokens.length
  return share === 0 ? 'en' : share >= 0.3 ? 'vi' : 'mixed'
}

/** Redact secrets using the same ordered bounded patterns as src/redaction.ts. */
export function redactRequest(text) {
  return redactPatterns.reduce((value, [kind, pattern]) => value.replace(pattern, (match, ...groups) => {
    const prefix = typeof groups[0] === 'string' ? groups[0] : ''
    const rest = match.slice(prefix.length)
    return /^\[REDACTED:[a-z0-9-]{1,40}\]$/.test(rest) ? match : `${prefix}[REDACTED:${kind}]`
  }), text)
}

/** Build one validated ledger JSON line. */
export function buildLine(input, now = new Date()) {
  const request = redactRequest(input.request).slice(0, 4000)
  const minutes = Math.max(0, (now.getTime() - Date.parse(input.started)) / 60000)
  return {
    schemaVersion: 1,
    ts: now.toISOString(),
    lane: input.lane,
    project: input.project,
    runId: input.runId,
    profile: input.profile,
    domain: input.domain,
    language: input.language ?? detectLanguage(input.request),
    languageSource: input.language ? 'override' : 'detected',
    request,
    skills: input.skills ?? [],
    fixRounds: input.fixRounds,
    codexTokens: input.codexTokens,
    wallClockMinutes: Math.round(minutes * 10) / 10,
    ownerGates: input.ownerGates,
    bypasses: input.bypasses ?? [],
    outcome: input.outcome,
    ...(input.profileMode === undefined ? {} : { profileMode: input.profileMode }),
    ...(input.evidenceMode === undefined ? {} : { evidenceMode: input.evidenceMode }),
    ...(input.languageMode === undefined ? {} : { languageMode: input.languageMode }),
  }
}

/** Append exactly one JSON object to the ledger, creating its parent directory. */
export function appendLine(line, ledgerPath = process.env.CODEX_MCP_RUN_LEDGER ?? DEFAULT_LEDGER) {
  mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 })
  appendFileSync(ledgerPath, `${JSON.stringify(line)}\n`, { flag: 'a', mode: 0o600 })
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const validLine = (line) => isRecord(line) && line.schemaVersion === 1 && ISO(line.ts)
  && LANES.includes(line.lane) && typeof line.project === 'string' && path.isAbsolute(line.project)
  && typeof line.runId === 'string' && line.runId.length > 0 && PROFILES.includes(line.profile)
  && typeof line.domain === 'string' && line.domain.length > 0 && line.domain.length <= 80
  && LANGUAGES.includes(line.language) && ['detected', 'override'].includes(line.languageSource)
  && typeof line.request === 'string' && line.request.length <= 4000 && Array.isArray(line.skills)
  && line.skills.every(isString)
  && nonNegativeInt(line.fixRounds)
  && (line.codexTokens === null || nonNegativeInt(line.codexTokens))
  && typeof line.wallClockMinutes === 'number' && Number.isFinite(line.wallClockMinutes)
  && line.wallClockMinutes >= 0
  && nonNegativeInt(line.ownerGates) && Array.isArray(line.bypasses)
  && line.bypasses.every((value) => typeof value === 'string') && OUTCOMES.includes(line.outcome)
  && (line.profileMode === undefined || MODES.includes(line.profileMode))
  && (line.evidenceMode === undefined || MODES.includes(line.evidenceMode))
  && (line.languageMode === undefined || LANGUAGE_MODES.includes(line.languageMode))

const emptySummary = () => ({
  total: 0,
  counts: {},
  medians: { fixRounds: null, codexTokens: null, wallClockMinutes: null, ownerGates: null },
  bypassRate: 0,
  malformed: 0,
})

const FILTER_ENUMS = {
  lane: LANES,
  profile: PROFILES,
  language: LANGUAGES,
  outcome: OUTCOMES,
  profileMode: MODES,
  evidenceMode: MODES,
  languageMode: LANGUAGE_MODES,
}

const validateFilters = (filters) => filters.map((filter) => {
  const [key, value, ...extra] = filter.split('=')
  if (extra.length || !Object.hasOwn(FILTER_ENUMS, key)) throw new Error(`invalid filter key: ${key || ''}`)
  if (!FILTER_ENUMS[key].includes(value)) throw new Error(`invalid filter value for ${key}: ${value ?? ''}`)
  return { key, value }
})

/** Summarize valid ledger lines and count malformed lines. */
export function summarize(
  ledgerPath = process.env.CODEX_MCP_RUN_LEDGER ?? DEFAULT_LEDGER,
  project,
  filters = [],
) {
  const parsedFilters = validateFilters(filters)
  let content
  try {
    content = readFileSync(ledgerPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySummary()
    throw error
  }
  const lines = content.split(/\r?\n/).filter(Boolean)
  const parsed = lines.map((line) => { try { return JSON.parse(line) } catch { return null } })
  const valid = parsed.filter((line) => validLine(line))
  const malformed = parsed.length - valid.length
  const filtered = valid.filter((line) => {
    if (project && line.project !== project) return false
    return parsedFilters.every(({ key, value }) => (line[key] ?? 'off') === value)
  })
  const counts = {}
  for (const line of filtered) {
    const key = `${line.profile} × ${line.language} × ${line.outcome}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return {
    total: filtered.length,
    counts,
    medians: {
      fixRounds: median(filtered.map((x) => x.fixRounds)),
      codexTokens: median(filtered.map((x) => x.codexTokens).filter((x) => x !== null)),
      wallClockMinutes: median(filtered.map((x) => x.wallClockMinutes)),
      ownerGates: median(filtered.map((x) => x.ownerGates)),
    },
    bypassRate: filtered.length ? filtered.filter((x) => x.bypasses.length > 0).length / filtered.length : 0,
    malformed,
  }
}

const formatSummary = (result) => [
  `total runs: ${result.total}`,
  ...Object.entries(result.counts).map(([key, count]) => `${key}: ${count}`),
  `median fixRounds: ${result.medians.fixRounds ?? 'n/a'}`,
  `median codexTokens: ${result.medians.codexTokens ?? 'n/a'}`,
  `median wallClockMinutes: ${result.medians.wallClockMinutes ?? 'n/a'}`,
  `median ownerGates: ${result.medians.ownerGates ?? 'n/a'}`,
  `bypass rate: ${result.bypassRate}`,
  `skipped malformed: ${result.malformed}`,
].join('\n') + '\n'

const readRequestFile = (requestPath) => {
  const descriptor = openSync(requestPath, 'r')
  const buffer = Buffer.alloc(64 * 1024)
  try {
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytes)
  } finally {
    closeSync(descriptor)
  }
}

/** Run the command-line interface and return its contract exit code. */
export function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === 'append') {
      const args = parseAppendArgs(argv.slice(1))
      const request = args.requestfile ? readRequestFile(args.requestfile) : args.request
      appendLine(buildLine({ ...args, request }))
      return 0
    }
    if (argv[0] === 'summary') {
      const json = argv.includes('--json')
      let project
      const filters = []
      for (let index = 1; index < argv.length; index += 1) {
        const flag = argv[index]
        if (flag === '--json') continue
        if (flag === '--project') {
          project = argv[++index]
          if (!project || !path.isAbsolute(project)) throw new Error('--project requires an absolute path')
          continue
        }
        if (flag === '--filter') {
          const filter = argv[++index]
          if (!filter || filter.startsWith('--')) throw new Error('--filter requires key=value')
          filters.push(filter)
          continue
        }
        throw new Error(`unknown summary argument: ${flag}`)
      }
      const result = summarize(undefined, project, filters)
      const output = json
        ? JSON.stringify(result) + '\n'
        : result.total ? formatSummary(result) : 'run-ledger: no runs recorded\n'
      process.stdout.write(output)
      return 0
    }
    throw new Error('usage: append or summary')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`)
    return error?.code ? 1 : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
