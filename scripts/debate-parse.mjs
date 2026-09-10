// Fail-closed parser for the /codex-flow:brainstorm debate contract. Astra (Codex) ends every
// debate turn with ONE fenced json block; this helper is the trust boundary that turns that block
// into ledger entries — the same role reviewFindings plays for codex_review. Malformed entries are
// dropped with one ordered reason each, never reconstructed from prose.
//
// Usage: node scripts/debate-parse.mjs --kind round --round <n> [--file <path>]
//        node scripts/debate-parse.mjs --kind signoff [--file <path>]
//   Reads Astra's agentMessage from --file or stdin; prints the parsed result as JSON.
// Exit codes: 0 = parsed with zero dropped entries; 1 = missing/invalid block or dropped > 0
// (the result is still printed so the reasons are visible); 2 = usage or read failure.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXIT_OK = 0
export const EXIT_MALFORMED = 1
export const EXIT_FAILURE = 2

export const KINDS = Object.freeze(['round', 'signoff'])
export const SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR'])
export const STATUSES = Object.freeze(['NEW', 'HOLD', 'CONCEDE'])
export const MIN_ROUND = 1
export const MAX_ROUND = 3
const CLI_FLAGS = Object.freeze(['kind', 'round', 'file'])
const ROUND_FIELDS = Object.freeze(['round', 'challenges', 'alternative', 'dissent'])
const SIGNOFF_TOP_FIELDS = Object.freeze(['round', 'misattributions', 'dissent'])
const CHALLENGE_ID = /^C\d+$/
const SIGNOFF_FIELDS = Object.freeze(['id', 'expected', 'observed', 'evidence'])
export const PENDING_VERDICTS = Object.freeze(['CONFIRM', 'HOLD'])
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g
const TRAILING_TEXT = /```[ \t]*\r?\n?([\s\S]*)$/

const USAGE = 'usage: node scripts/debate-parse.mjs --kind round --round <n> [--file <path>] | --kind signoff [--file <path>]'

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const isStringOrNull = (value) => value === null || typeof value === 'string'

/** Pure: last fenced ```json block in `text`, how many such blocks exist, and whether
 * anything but whitespace follows the last one (the contract says "nothing after it"). */
export function extractLastJsonBlock(text) {
  const source = String(text)
  const matches = [...source.matchAll(JSON_FENCE)]
  if (matches.length === 0) return { raw: null, blockCount: 0, trailingText: false }
  const last = matches[matches.length - 1]
  const afterBlock = source.slice(last.index + last[0].length)
  return { raw: last[1].trim(), blockCount: matches.length, trailingText: afterBlock.trim().length > 0 }
}

const emptyResult = (kind, blockCount) => ({
  kind,
  parsed: false,
  parseError: null,
  blockCount,
  round: null,
  challenges: [],
  misattributions: [],
  pending: [],
  alternative: null,
  dissent: null,
  dropped: 0,
  droppedReasons: [],
})

const failed = (result, parseError) => ({ ...result, parsed: false, parseError })

/** Pure: validate one round challenge entry; returns the drop reason or null when valid. */
const challengeDropReason = (entry, index, seenIds) => {
  const prefix = `challenges[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !CHALLENGE_ID.test(entry.id)) return `${prefix}.id`
  if (seenIds.has(entry.id)) return `${prefix}.id (duplicate)`
  if (!SEVERITIES.includes(entry.severity)) return `${prefix}.severity`
  if (!STATUSES.includes(entry.status)) return `${prefix}.status`
  if (!isNonEmptyString(entry.claim)) return `${prefix}.claim`
  return null
}

/** Pure: validate one signoff misattribution entry; returns the drop reason or null. */
const misattributionDropReason = (entry, index) => {
  const prefix = `misattributions[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  const missing = SIGNOFF_FIELDS.find((field) => !isNonEmptyString(entry[field]))
  if (missing) return `${prefix}.${missing}`
  return CHALLENGE_ID.test(entry.id) ? null : `${prefix}.id`
}

/** Pure: validate one signoff pending-verdict entry (a round-cap ACCEPT the sign-off confirms or holds). */
const pendingDropReason = (entry, index) => {
  const prefix = `pending[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !CHALLENGE_ID.test(entry.id)) return `${prefix}.id`
  if (!PENDING_VERDICTS.includes(entry.verdict)) return `${prefix}.verdict`
  if (!isNonEmptyString(entry.evidence)) return `${prefix}.evidence`
  return null
}

/** Pure: split entries into kept and dropped using a per-entry reason function. */
const partitionEntries = (entries, reasonFor) => entries.reduce(
  (acc, entry, index) => {
    const reason = reasonFor(entry, index, acc.seen)
    if (reason) return { ...acc, droppedReasons: [...acc.droppedReasons, reason] }
    return { ...acc, kept: [...acc.kept, entry], seen: new Set([...acc.seen, entry.id]) }
  },
  { kept: [], droppedReasons: [], seen: new Set() },
)

const missingField = (value, fields) => fields.find((field) => !(field in value))

const parseRound = (result, value, round) => {
  const absent = missingField(value, ROUND_FIELDS)
  if (absent) return failed(result, `missing required field: ${absent}`)
  if (value.round !== round) return failed(result, `round mismatch: expected ${round}, got ${JSON.stringify(value.round)}`)
  if (!Array.isArray(value.challenges)) return failed(result, 'challenges must be an array')
  if (!isStringOrNull(value.alternative)) return failed(result, 'alternative must be a string or null')
  if (!isStringOrNull(value.dissent)) return failed(result, 'dissent must be a string or null')
  const { kept, droppedReasons } = partitionEntries(value.challenges, challengeDropReason)
  return {
    ...result,
    parsed: true,
    round,
    challenges: kept.map(({ id, severity, status, claim }) => ({ id, severity, status, claim: claim.trim() })),
    alternative: value.alternative,
    dissent: value.dissent,
    dropped: droppedReasons.length,
    droppedReasons,
  }
}

const parseSignoff = (result, value) => {
  const absent = missingField(value, SIGNOFF_TOP_FIELDS)
  if (absent) return failed(result, `missing required field: ${absent}`)
  if (value.round !== 'signoff') return failed(result, `expected round "signoff", got ${JSON.stringify(value.round)}`)
  if (!Array.isArray(value.misattributions)) return failed(result, 'misattributions must be an array')
  if (!isStringOrNull(value.dissent)) return failed(result, 'dissent must be a string or null')
  const pendingRaw = value.pending ?? []
  if (!Array.isArray(pendingRaw)) return failed(result, 'pending must be an array')
  const { kept, droppedReasons } = partitionEntries(value.misattributions, misattributionDropReason)
  const pending = partitionEntries(pendingRaw, pendingDropReason)
  const allDropped = [...droppedReasons, ...pending.droppedReasons]
  return {
    ...result,
    parsed: true,
    round: 'signoff',
    misattributions: kept.map(({ id, expected, observed, evidence }) => ({ id, expected, observed, evidence })),
    pending: pending.kept.map(({ id, verdict, evidence }) => ({ id, verdict, evidence })),
    dissent: value.dissent,
    dropped: allDropped.length,
    droppedReasons: allDropped,
  }
}

/**
 * Pure: parse Astra's agentMessage into the debate contract.
 * @param {string} text  full agentMessage
 * @param {{kind: 'round'|'signoff', round?: number}} options
 */
export function parseDebateOutput(text, options) {
  const { kind, round } = options ?? {}
  if (!KINDS.includes(kind)) throw new UsageError(`kind must be one of ${KINDS.join('|')}`)
  const { raw, blockCount, trailingText } = extractLastJsonBlock(text)
  const base = emptyResult(kind, blockCount)
  if (raw === null) return failed(base, 'no fenced json block found')
  if (blockCount !== 1) return failed(base, `expected exactly one fenced json block, found ${blockCount}`)
  if (trailingText) return failed(base, 'text follows the fenced json block; the block must be last')
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return failed(base, `invalid json: ${error.message}`)
  }
  if (!isPlainObject(value)) return failed(base, 'top level must be an object')
  return kind === 'round' ? parseRound(base, value, round) : parseSignoff(base, value)
}

/** Pure: parse CLI flags. Throws UsageError on bad input. */
export function parseCliArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key.startsWith('--') || value === undefined) throw new UsageError(USAGE)
    const name = key.slice(2)
    if (!CLI_FLAGS.includes(name)) throw new UsageError(`unknown flag ${key}. ${USAGE}`)
    flags[name] = value
  }
  if (!KINDS.includes(flags.kind)) throw new UsageError(`--kind must be one of ${KINDS.join('|')}`)
  const parsedRound = flags.round === undefined ? undefined : Number(flags.round)
  if (flags.kind === 'round' && !(Number.isInteger(parsedRound) && parsedRound >= MIN_ROUND && parsedRound <= MAX_ROUND)) {
    throw new UsageError(`--round <n> is required for --kind round and must be ${MIN_ROUND}-${MAX_ROUND}`)
  }
  if (flags.kind === 'signoff' && flags.round !== undefined) throw new UsageError('--round is not accepted with --kind signoff')
  return { kind: flags.kind, round: parsedRound, file: flags.file }
}

const readInput = (file) => (file ? readFileSync(path.resolve(file), 'utf8') : readFileSync(0, 'utf8'))

export function main(argv = process.argv.slice(2), io = { stdout: console.log, stderr: console.error }) {
  let args
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    io.stderr(error.message)
    return EXIT_FAILURE
  }
  let text
  try {
    text = readInput(args.file)
  } catch (error) {
    io.stderr(`debate-parse: cannot read input: ${error.message}`)
    return EXIT_FAILURE
  }
  const result = parseDebateOutput(text, args)
  io.stdout(JSON.stringify(result, null, 2))
  return result.parsed && result.dropped === 0 ? EXIT_OK : EXIT_MALFORMED
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) process.exit(main())
