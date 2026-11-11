import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseCatalog } from './build-skills-index.mjs'
import {
  deriveTerms,
  formatShortlist,
  selectSkills,
  DEFAULT_TOKEN_BUDGET,
} from './skill-match.mjs'
import { tokensOf } from './skill-tokens.mjs'

const USAGE = 'Usage: node scripts/skill-shortlist.mjs [--index <file>] '
  + '[--request "<text>"] [--facet <name>=<term,term,…>]… [--budget <tokens>] [--json] '
  + '(comma separates terms; terms cannot contain commas)'

class UsageError extends Error {}

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001F\u007F-\u009F]+/g
// ESC- and C1-introduced CSI and OSC sequences, removed whole so their payload does not survive.
const ANSI_ESCAPE = new RegExp(
  '(?:\\x1B\\[|\\x9B)[0-?]*[ -/]*[@-~]'
  + '|(?:\\x1B\\]|\\x9D)[^\\x07\\x1B\\x9C]*(?:\\x07|\\x1B\\\\|\\x9C)?',
  'g',
)
/** Best score below which a raw request is reported as weakly matched. */
export const WARNING_SCORE_THRESHOLD = 2
const ENGLISH_WORD = /^[A-Za-z][A-Za-z'’-]*$/
const WEAK_MATCH_WARNING = 'skill-shortlist: warning: only weak matches — '
  + 'derive English search terms and pass them with --facet'
const NON_ENGLISH_WARNING = 'skill-shortlist: warning: request does not look like English; '
  + 'pass --facet name=term,term'

/** Remove ANSI escapes and control characters from index-derived text before printing it. */
const cleanIndexText = (value) => value.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS_GLOBAL, ' ')

const defaultIndex = () => process.env.CODEX_FLOW_SKILLS_INDEX
  || path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

/** Parse and validate shortlist CLI arguments without mutating shared state. */
export function parseArgs(argv) {
  let result = { index: null, request: null, facets: [], budget: DEFAULT_TOKEN_BUDGET, json: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--json') {
      result = { ...result, json: true }
      continue
    }
    if (!['--index', '--request', '--facet', '--budget'].includes(flag)) {
      throw new UsageError(`unknown argument: ${flag}`)
    }
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
    if (CONTROL_CHARS.test(value)) throw new UsageError(`${flag} contains a control character`)
    if (flag === '--index') result = { ...result, index: value }
    else if (flag === '--request') result = { ...result, request: value }
    else if (flag === '--budget') {
      const budget = Number(value)
      if (!Number.isFinite(budget) || budget < 0) {
        throw new UsageError('--budget requires a non-negative number')
      }
      result = { ...result, budget }
    } else {
      const equals = value.indexOf('=')
      const name = equals >= 0 ? value.slice(0, equals).trim() : ''
      const terms = equals >= 0
        ? value.slice(equals + 1).split(',').map((term) => term.trim()).filter(Boolean)
        : []
      if (!name || !terms.length || /[=,]/.test(name)) {
        throw new UsageError('--facet requires <name>=<term,term,…>')
      }
      result = { ...result, facets: [...result.facets, { name, terms }] }
    }
  }
  if (result.request === null && !result.facets.length) throw new UsageError('provide --request or --facet')
  return result
}

function writeError(stderr, error, includeUsage) {
  stderr(`skill-shortlist: ${error instanceof Error ? error.message : String(error)}`)
  if (includeUsage) stderr(USAGE)
}

/** True when at least half of the request's words are plain ASCII-letter words. */
function looksEnglish(request) {
  const words = request.trim().split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
  if (words.length === 0) return false
  const english = words.filter((word) => ENGLISH_WORD.test(word)).length
  return english * 2 >= words.length
}

/** Warnings for a raw --request whose matches are weak or whose text is not English. */
function shortlistWarnings(request, selected) {
  if (request === null) return []
  const warnings = []
  if (!looksEnglish(request)) warnings.push(NON_ENGLISH_WARNING)
  if (!selected.length || selected[0].score < WARNING_SCORE_THRESHOLD) warnings.push(WEAK_MATCH_WARNING)
  return warnings
}

/** Run the shortlist CLI and return 0 on success or 2 on usage/I/O failure. */
export function runCli(argv, { stdout = console.log, stderr = console.error } = {}) {
  try {
    const options = parseArgs(argv)
    const indexFile = path.resolve(options.index || defaultIndex())
    let indexContent
    try {
      indexContent = readFileSync(indexFile, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`skill index missing; rebuild it with build-skills-index.mjs: ${indexFile}`)
      }
      throw error
    }
    const entries = parseCatalog(indexContent)
    const requestTerms = options.request === null ? null : deriveTerms(options.request)
    const facets = options.facets.length ? options.facets : [{ name: 'request', terms: requestTerms }]
    const selected = selectSkills(entries, facets, { tokenBudget: options.budget, tokensOf })
    // Warnings judge the raw request; with explicit facets the request is not what was matched.
    const warnings = options.facets.length
      ? []
      : shortlistWarnings(options.request, selected)
    const safeSelected = selected.map((entry) => ({
      ...entry,
      name: cleanIndexText(entry.name),
      description: cleanIndexText(entry.description),
      file: entry.file ? cleanIndexText(entry.file) : entry.file,
    }))
    for (const warning of warnings) stderr(warning)
    if (options.json) {
      stdout(JSON.stringify({
        facets: facets.map(({ name, terms }) => ({ name, terms })),
        warnings,
        selected: safeSelected.map(({ name, facet, score, tokens, file }) => ({
          name,
          facet: facet ?? (options.facets.length ? facets[0].name : undefined),
          score,
          tokens,
          file,
        })),
      }))
    } else {
      if (options.facets.length && requestTerms) stdout(`request terms: ${requestTerms.join(', ')}`)
      for (const facet of facets) stdout(`terms: ${facet.name} = ${facet.terms.join(', ')}`)
      stdout(safeSelected.length ? formatShortlist(safeSelected) : '(no candidates)')
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeError(stderr, error, error instanceof UsageError)
    return 2
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) process.exit(runCli(process.argv.slice(2)))
