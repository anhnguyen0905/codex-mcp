// Fail-closed parser for the /codex-flow:brainstorm debate contract.
// Usage: node scripts/debate-parse.mjs --kind map|round|feasibility [--round <1..3>] [--file <path>]
// --round is required for round and rejected for map and feasibility.
// Exit codes: 0 = parsed with zero dropped entries; 1 = unparsed or dropped entries
// (the result is still printed); 2 = usage or read failure.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXIT_OK = 0
export const EXIT_MALFORMED = 1
export const EXIT_FAILURE = 2
export const KINDS = Object.freeze(['map', 'round', 'feasibility'])
export const CHALLENGE_TYPES = Object.freeze(['LOGIC', 'SYSTEM', 'ASSUMPTION', 'EVIDENCE'])
export const SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR'])
export const STATUSES = Object.freeze(['NEW', 'HOLD', 'CONCEDE'])
export const VERDICTS = Object.freeze(['FEASIBLE', 'FEASIBLE-WITH-CONDITIONS', 'NOT-FEASIBLE'])
export const EFFORTS = Object.freeze(['S', 'M', 'L', 'XL'])
export const REVERSIBILITY = Object.freeze(['yes', 'partly', 'no'])
export const TOULMIN_TARGETS = Object.freeze(['claim', 'data', 'warrant', 'backing', 'qualifier', 'rebuttal'])
export const SCHEMES = Object.freeze({
  'cause-effect': 3, consequences: 3, analogy: 3, 'expert-opinion': 3,
  sign: 2, example: 3, 'sunk-cost': 2, 'slippery-slope': 3,
})
export const PD_RULES = Object.freeze(['PD1', 'PD2', 'PD3', 'PD4', 'PD5', 'PD6', 'PD7', 'PD8', 'PD9', 'PD10'])
export const MIN_ROUND = 1
export const MAX_ROUND = 3
const CLI_FLAGS = Object.freeze(['kind', 'round', 'file'])
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g
const USAGE = 'usage: node scripts/debate-parse.mjs --kind map|round|feasibility [--round <1..3>] [--file <path>]'
const ID_PATTERNS = Object.freeze({ stocks: /^S\d+$/, loops: /^L\d+$/, delays: /^D\d+$/, leverage: /^P\d+$/ })
class UsageError extends Error {}
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const isStringOrNull = (value) => value === null || typeof value === 'string'
const missingField = (value, fields) => fields.find((field) => !(field in value))
const failed = (result, parseError) => ({ ...result, parsed: false, parseError })
const validateRound = (round) => {
  if (!(Number.isInteger(round) && round >= MIN_ROUND && round <= MAX_ROUND)) {
    throw new UsageError(`--round <n> is required for --kind round and must be ${MIN_ROUND}-${MAX_ROUND}`)
  }
}

/** Extract the sole permitted fenced JSON block and trailing-text status. */
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
  dropped: 0,
  droppedReasons: [],
  ...(kind === 'map'
    ? { stocks: [], loops: [], delays: [], archetype: null, leverage: [] }
    : kind === 'round'
      ? {
          round: null, steelman: null, counterThesis: null, challenges: [], contributions: [],
          violations: [], dissent: null,
        }
      : {
          verdict: null,
          effort: null,
          reversible: null,
          dependencies: [],
          risks: [],
          conditions: [],
          firstStep: null,
        }),
})
const partitionEntries = (entries, reasonFor) => entries.reduce((acc, entry, index) => {
  const reason = reasonFor(entry, index, acc.seen)
  if (reason) return { ...acc, droppedReasons: [...acc.droppedReasons, reason] }
  return { ...acc, kept: [...acc.kept, entry], seen: new Set([...acc.seen, entry.id]) }
}, { kept: [], droppedReasons: [], seen: new Set() })
const mapDropReason = (kind, entry, index, seen) => {
  const prefix = `${kind}[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !ID_PATTERNS[kind].test(entry.id)) return `${prefix}.id`
  if (seen.has(entry.id)) return `${prefix}.id (duplicate)`
  if (kind === 'loops' && !['R', 'B'].includes(entry.type)) return `${prefix}.type`
  if (kind === 'leverage' && !(Number.isInteger(entry.level) && entry.level >= 1 && entry.level <= 12)) {
    return `${prefix}.level`
  }
  const textField = { stocks: 'name', loops: 'chain', delays: 'where', leverage: 'point' }[kind]
  return isNonEmptyString(entry[textField]) ? null : `${prefix}.${textField}`
}
const challengeDropReason = (entry, index, seen) => {
  const prefix = `challenges[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !/^C\d+$/.test(entry.id)) return `${prefix}.id`
  if (seen.has(entry.id)) return `${prefix}.id (duplicate)`
  if (!CHALLENGE_TYPES.includes(entry.type)) return `${prefix}.type`
  if (!SEVERITIES.includes(entry.severity)) return `${prefix}.severity`
  if (!STATUSES.includes(entry.status)) return `${prefix}.status`
  if (!isNonEmptyString(entry.claim)) return `${prefix}.claim`
  if (!TOULMIN_TARGETS.includes(entry.target)) return `${prefix}.target`
  if (!(typeof entry.scheme === 'string' && Object.hasOwn(SCHEMES, entry.scheme))) {
    return `${prefix}.scheme`
  }
  const cqMatch = typeof entry.cq === 'string' ? entry.cq.match(/^CQ(\d+)$/) : null
  if (!cqMatch || Number(cqMatch[1]) < 1 || Number(cqMatch[1]) > SCHEMES[entry.scheme]) {
    return `${prefix}.cq`
  }
  return isNonEmptyString(entry.evidence) ? null : `${prefix}.evidence`
}
const violationDropReason = (entry, index, seen) => {
  const prefix = `violations[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !/^V\d+$/.test(entry.id)) return `${prefix}.id`
  if (seen.has(entry.id)) return `${prefix}.id (duplicate)`
  if (!PD_RULES.includes(entry.rule)) return `${prefix}.rule`
  return isNonEmptyString(entry.claim) ? null : `${prefix}.claim`
}
const contributionDropReason = (entry, index, seen) => {
  const prefix = `contributions[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !/^N\d+$/.test(entry.id)) return `${prefix}.id`
  if (seen.has(entry.id)) return `${prefix}.id (duplicate)`
  return isNonEmptyString(entry.claim) ? null : `${prefix}.claim`
}
const riskDropReason = (entry, index, seen) => {
  const prefix = `risks[${index}]`
  if (!isPlainObject(entry)) return `${prefix} (not an object)`
  if (typeof entry.id !== 'string' || !/^K\d+$/.test(entry.id)) return `${prefix}.id`
  if (seen.has(entry.id)) return `${prefix}.id (duplicate)`
  return isNonEmptyString(entry.risk) ? null : `${prefix}.risk`
}
const projectEntry = (kind, entry) => {
  const fields = {
    stocks: ['id', 'name'],
    loops: ['id', 'type', 'chain'],
    delays: ['id', 'where'],
    leverage: ['id', 'level', 'point'],
    challenges: ['id', 'type', 'severity', 'status', 'target', 'scheme', 'cq', 'claim', 'evidence'],
    contributions: ['id', 'claim'],
    violations: ['id', 'rule', 'claim'],
    risks: ['id', 'risk'],
  }[kind]
  return fields.reduce((projected, field) => ({
    ...projected,
    [field]: typeof entry[field] === 'string' ? entry[field].trim() : entry[field],
  }), {})
}

const parseMap = (result, value) => {
  const absent = missingField(value, ['kind', 'stocks', 'loops', 'delays', 'archetype', 'leverage'])
  if (absent) return failed(result, `missing required field: ${absent}`)
  if (value.kind !== 'map') return failed(result, `expected kind "map", got ${JSON.stringify(value.kind)}`)
  if (!isStringOrNull(value.archetype)) return failed(result, 'archetype must be a string or null')
  const parsed = ['stocks', 'loops', 'delays', 'leverage'].reduce((acc, kind) => {
    if (!Array.isArray(value[kind])) return { ...acc, error: `${kind} must be an array` }
    const partition = partitionEntries(
      value[kind],
      (entry, index, seen) => mapDropReason(kind, entry, index, seen),
    )
    return {
      ...acc,
      [kind]: partition.kept.map((entry) => projectEntry(kind, entry)),
      droppedReasons: [...acc.droppedReasons, ...partition.droppedReasons],
    }
  }, { droppedReasons: [], error: null })
  if (parsed.error) return failed(result, parsed.error)
  return {
    ...result,
    parsed: true,
    stocks: parsed.stocks,
    loops: parsed.loops,
    delays: parsed.delays,
    archetype: value.archetype,
    leverage: parsed.leverage,
    dropped: parsed.droppedReasons.length,
    droppedReasons: parsed.droppedReasons,
  }
}
const parseRound = (result, value, round) => {
  const absent = missingField(value, [
    'round', 'steelman', 'counterThesis', 'challenges', 'contributions', 'violations', 'dissent',
  ])
  if (absent) return failed(result, `missing required field: ${absent}`)
  if (value.round !== round) {
    return failed(result, `round mismatch: expected ${round}, got ${JSON.stringify(value.round)}`)
  }
  if (!isNonEmptyString(value.steelman)) return failed(result, 'steelman must be a non-empty string')
  if (round === 1 && !isNonEmptyString(value.counterThesis)) {
    return failed(result, 'counterThesis must be a non-empty string for round 1')
  }
  if (round >= 2 && !(value.counterThesis === null || isNonEmptyString(value.counterThesis))) {
    return failed(result, 'counterThesis must be null or a non-empty string for round 2 or later')
  }
  if (![value.challenges, value.contributions, value.violations].every(Array.isArray)) {
    return failed(result, 'challenges, contributions and violations must be arrays')
  }
  if (!isStringOrNull(value.dissent)) return failed(result, 'dissent must be a string or null')
  const challenges = partitionEntries(value.challenges, challengeDropReason)
  const contributions = partitionEntries(value.contributions, contributionDropReason)
  const violations = partitionEntries(value.violations, violationDropReason)
  const droppedReasons = [
    ...challenges.droppedReasons, ...contributions.droppedReasons, ...violations.droppedReasons,
  ]
  return {
    ...result,
    parsed: true,
    round,
    steelman: value.steelman.trim(),
    counterThesis: typeof value.counterThesis === 'string' ? value.counterThesis.trim() : null,
    challenges: challenges.kept.map((entry) => projectEntry('challenges', entry)),
    contributions: contributions.kept.map((entry) => projectEntry('contributions', entry)),
    violations: violations.kept.map((entry) => projectEntry('violations', entry)),
    dissent: value.dissent,
    dropped: droppedReasons.length,
    droppedReasons,
  }
}
const parseFeasibility = (result, value) => {
  const absent = missingField(value, [
    'kind', 'verdict', 'effort', 'reversible', 'dependencies', 'risks', 'conditions', 'firstStep',
  ])
  if (absent) return failed(result, `missing required field: ${absent}`)
  if (value.kind !== 'feasibility') {
    return failed(result, `expected kind "feasibility", got ${JSON.stringify(value.kind)}`)
  }
  if (!VERDICTS.includes(value.verdict)) return failed(result, 'invalid verdict')
  if (!EFFORTS.includes(value.effort)) return failed(result, 'invalid effort')
  if (!REVERSIBILITY.includes(value.reversible)) return failed(result, 'invalid reversible')
  if (!isNonEmptyString(value.firstStep)) return failed(result, 'firstStep must be a non-empty string')
  if (![value.dependencies, value.risks, value.conditions].every(Array.isArray)) {
    return failed(result, 'dependencies, risks and conditions must be arrays')
  }
  const risks = partitionEntries(value.risks, riskDropReason)
  const lists = ['dependencies', 'conditions'].reduce((acc, name) => ({
    ...acc,
    [name]: value[name].filter(isNonEmptyString).map((item) => item.trim()),
    droppedReasons: [
      ...acc.droppedReasons,
      ...value[name].flatMap((item, index) => isNonEmptyString(item) ? [] : [`${name}[${index}]`]),
    ],
  }), { dependencies: [], conditions: [], droppedReasons: risks.droppedReasons })
  return {
    ...result,
    parsed: true,
    verdict: value.verdict,
    effort: value.effort,
    reversible: value.reversible,
    dependencies: lists.dependencies,
    conditions: lists.conditions,
    risks: risks.kept.map((entry) => projectEntry('risks', entry)),
    firstStep: value.firstStep.trim(),
    dropped: lists.droppedReasons.length,
    droppedReasons: lists.droppedReasons,
  }
}

/** Parse one fenced debate response according to its selected kind. */
export function parseDebateOutput(text, options) {
  const { kind, round } = options ?? {}
  if (!KINDS.includes(kind)) throw new UsageError(`kind must be one of ${KINDS.join('|')}`)
  if (kind === 'round') validateRound(round)
  const { raw, blockCount, trailingText } = extractLastJsonBlock(text)
  const base = emptyResult(kind, blockCount)
  if (raw === null) return failed(base, 'no fenced json block found')
  if (blockCount !== 1) return failed(base, `expected exactly one fenced json block, found ${blockCount}`)
  if (trailingText) return failed(base, 'text follows the fenced json block; the block must be last')
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return failed(base, `invalid json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainObject(value)) return failed(base, 'top level must be an object')
  if (kind === 'map') return parseMap(base, value)
  if (kind === 'round') return parseRound(base, value, round)
  return parseFeasibility(base, value)
}
/** Parse and validate command-line flags. */
export function parseCliArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith('--') || value === undefined) throw new UsageError(USAGE)
    const name = key.slice(2)
    if (!CLI_FLAGS.includes(name)) throw new UsageError(`unknown flag ${key}. ${USAGE}`)
    flags[name] = value
  }
  if (!KINDS.includes(flags.kind)) throw new UsageError(`--kind must be one of ${KINDS.join('|')}`)
  const parsedRound = flags.round === undefined ? undefined : Number(flags.round)
  if (flags.kind === 'round') validateRound(parsedRound)
  if (flags.kind !== 'round' && flags.round !== undefined) {
    throw new UsageError('--round is only accepted with --kind round')
  }
  return { kind: flags.kind, round: parsedRound, file: flags.file }
}
const readInput = (file) => (file ? readFileSync(path.resolve(file), 'utf8') : readFileSync(0, 'utf8'))
/** Run the parser CLI and return its documented exit code. */
export function main(argv = process.argv.slice(2), io = { stdout: console.log, stderr: console.error }) {
  let args
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return EXIT_FAILURE
  }
  let text
  try {
    text = readInput(args.file)
  } catch (error) {
    io.stderr(`debate-parse: cannot read input: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_FAILURE
  }
  const result = parseDebateOutput(text, args)
  io.stdout(JSON.stringify(result, null, 2))
  return result.parsed && result.dropped === 0 ? EXIT_OK : EXIT_MALFORMED
}
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) process.exit(main())
