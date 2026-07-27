// Deterministic retrieval core for skill-selection: score index entries against
// derived search terms, rank them, and apply the budget. This is the mechanically
// testable part of skills/skill-selection/SKILL.md (Steps 4-5) — the LLM handles
// role classification (Step 2) and final distillation/vetting.

const MIN_TERM_LEN = 3 // shorter terms are noise ("ts", "go" handled as explicit terms upstream)
const NAME_WORD = 5
const NAME_PHRASE = 5
const DESC_WORD = 2
const DESC_PHRASE = 3
const SUBSTRING = 1
// Missed phrases retain reduced constituent-word credit without rivaling exact phrases.
export const PARTIAL_FACTOR = 0.6

// Conservative morphological folding so a term matches the same concept written in
// another form ("project management" vs "project-manager", "analytics" vs "analysis").
// Deliberately small: over-stemming invents matches, which costs more than a miss.
const STEM_ALIASES = new Map([
  ['analysis', 'analy'],
  ['analyses', 'analy'],
  ['analytics', 'analy'],
  ['analytical', 'analy'],
  ['analyze', 'analy'],
  ['analyzing', 'analy'],
  ['management', 'manage'],
  ['manager', 'manage'],
  ['managing', 'manage'],
  ['optimization', 'optimiz'],
  ['optimisation', 'optimiz'],
  ['optimize', 'optimiz'],
  ['optimizing', 'optimiz'],
  ['visualisation', 'visualiz'],
  ['visualization', 'visualiz'],
  ['visualize', 'visualiz'],
  ['statistics', 'statistic'],
  ['statistical', 'statistic'],
  ['forecasting', 'forecast'],
  ['modeling', 'model'],
  ['modelling', 'model'],
  ['planning', 'plan'],
  ['pricing', 'price'],
  ['reporting', 'report'],
  ['testing', 'test'],
  ['writing', 'write'],
])

/** Fold one token: alias table first, then a plural strip. Tokens ≤4 chars stay as-is. */
export function stem(token) {
  const alias = STEM_ALIASES.get(token)
  if (alias) return alias
  const singular = depluralize(token)
  // Re-check the alias table after depluralizing so "visualizations" also folds to
  // the "visualisation/visualization" alias, not just to "visualization".
  return STEM_ALIASES.get(singular) ?? singular
}

function depluralize(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

const words = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem)
// Normalize separators (hyphen/underscore/slash) to spaces so "test-driven" == "test driven".
const normalizePhrase = (text) => text.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()
// Phrase comparisons run on stemmed tokens so "project management" hits "project-manager".
const stemPhrase = (text) => normalizePhrase(text).split(' ').map(stem).join(' ')

// IDF weighting: a term that only a few skills mention ("incrementality", "gacha")
// is far more diagnostic than one half the index uses ("data", "analysis"). Without
// it, generic skills outrank specialists on a flat name/desc score.
const IDF_PIVOT = 2.5 // a mid-frequency term lands near weight 1.0
const IDF_MIN = 0.5
const IDF_MAX = 3

/** Document frequency of every stemmed token across the index (names + descriptions). */
export function buildDocFrequency(entries) {
  const df = new Map()
  for (const entry of entries) {
    for (const token of new Set([...words(entry.name), ...words(entry.description ?? '')])) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  return { df, total: entries.length }
}

/** Weight one term by rarity, clamped so a typo can't dominate and a common word still counts. */
export function idfWeight(term, stats) {
  if (!stats?.total) return 1
  const raw = Math.log((stats.total + 1) / ((stats.df.get(stem(term)) ?? 0) + 1))
  return Math.min(Math.max(raw / IDF_PIVOT, IDF_MIN), IDF_MAX)
}

// A phrase is as diagnostic as its rarest word.
const phraseWeight = (phrase, stats) =>
  stats ? Math.max(...phrase.split(' ').map((word) => idfWeight(word, stats))) : 1

function scorePartialPhrase(phrase, nameWords, descWords, stats, partialFactor) {
  let score = 0
  let nameWordHits = 0
  let totalHits = 0

  for (const word of phrase.split(' ')) {
    if (word.length < MIN_TERM_LEN) continue
    const weight = idfWeight(word, stats)
    if (nameWords.has(word)) {
      score += NAME_WORD * weight * partialFactor
      nameWordHits++
      totalHits++
    } else if (descWords.has(word)) {
      score += DESC_WORD * weight * partialFactor
      totalHits++
    }
  }

  return { score, nameWordHits, totalHits }
}

function scoreWordTerm(term, stemmed, nameWords, descWords, descText, stats) {
  const weight = idfWeight(term, stats)
  if (nameWords.has(stemmed)) {
    return { score: NAME_WORD * weight, nameHits: 1, descHits: 0 }
  }
  if (descWords.has(stemmed)) {
    return { score: DESC_WORD * weight, nameHits: 0, descHits: 1 }
  }
  const score = term.length >= MIN_TERM_LEN && descText.includes(term) ? SUBSTRING * weight : 0
  return { score, nameHits: 0, descHits: 0 }
}

/**
 * Match one entry against derived terms, returning a breakdown:
 *   { score, nameHits, phraseHits, descHits, matchedTerms } — enough
 *   for ranking, the relevance floor, and downstream shortlist attribution.
 */
export function matchDetail(entry, terms, stats = null, tuning = {}) {
  const nameWords = new Set(words(entry.name))
  const descWords = new Set(words(entry.description))
  const descText = entry.description.toLowerCase()
  const nameNorm = stemPhrase(entry.name)
  const descNorm = stemPhrase(entry.description)
  const partialFactor = tuning.partialFactor ?? PARTIAL_FACTOR

  let score = 0
  let nameHits = 0
  let phraseHits = 0
  let descHits = 0
  const matchedTerms = []

  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase().trim()
    if (!term) continue
    const stemmed = stem(term)
    const scoreBeforeTerm = score

    if (/[-_/\s]/.test(term)) {
      const phrase = stemPhrase(term)
      // Score phrases by specificity: a longer phrase hit outranks a single generic word.
      const phraseWords = phrase.split(' ').length
      const weight = phraseWeight(phrase, stats)
      if (nameNorm.includes(phrase)) {
        score += (NAME_PHRASE + (phraseWords - 1) * DESC_PHRASE) * weight
        nameHits++
      } else if (descNorm.includes(phrase)) {
        score += (DESC_PHRASE + (phraseWords - 1) * DESC_WORD) * weight
        phraseHits++
      } else {
        const partial = scorePartialPhrase(phrase, nameWords, descWords, stats, partialFactor)
        score += partial.score
        if (partial.nameWordHits >= 2) nameHits++
        else if (partial.totalHits >= 2) phraseHits++
        else if (partial.totalHits === 1) descHits++
      }
    } else {
      const wordMatch = scoreWordTerm(term, stemmed, nameWords, descWords, descText, stats)
      score += wordMatch.score
      nameHits += wordMatch.nameHits
      descHits += wordMatch.descHits
    }

    if (score > scoreBeforeTerm) matchedTerms.push(rawTerm)
  }
  return { score, nameHits, phraseHits, descHits, matchedTerms }
}

/** Score one index entry against derived terms (higher = more relevant; 0 = no match). */
export function scoreEntry(entry, terms, stats = null, tuning = {}) {
  return matchDetail(entry, terms, stats, tuning).score
}

// A skill clears the relevance floor only with a name hit, phrase hit, or ≥2 description terms.
const clearsFloor = (d) => d.nameHits > 0 || d.phraseHits > 0 || d.descHits >= 2

// Selection is bounded by CONTEXT budget, not a fixed skill count: load every
// relevant skill that fits within ~3% of a 200k-token window.
export const CONTEXT_WINDOW_TOKENS = 200_000
export const DEFAULT_TOKEN_BUDGET = Math.round(CONTEXT_WINDOW_TOKENS * 0.03) // 6000
// A selected skill's real cost is its distilled ≤30-line block (Step 6), not the
// whole SKILL.md — cap per-skill cost so one large reference-heavy skill can't
// blow the budget or crowd out more relevant ones.
export const DISTILL_TOKENS_CAP = 600
const DEFAULT_SKILL_TOKENS = DISTILL_TOKENS_CAP // fallback when real size is unknown

/**
 * Greedily take ranked entries (highest relevance first) whose cumulative token
 * cost fits `tokenBudget`. Oversized entries are skipped, not blocking; each taken
 * entry is annotated with `tokens`. Returns the fitted subset.
 */
export function fitToBudget(ranked, { tokenBudget = DEFAULT_TOKEN_BUDGET, tokensOf } = {}) {
  const sizeOf = tokensOf ?? ((e) => e.tokens ?? DEFAULT_SKILL_TOKENS)
  const taken = []
  let used = 0
  for (const entry of ranked) {
    const tokens = sizeOf(entry)
    if (used + tokens > tokenBudget) continue
    used += tokens
    taken.push({ ...entry, tokens })
  }
  return taken
}

/** Rank entries by descending score, dropping non-matches. Ties broken by name. */
export function rankCandidates(entries, terms, stats = buildDocFrequency(entries), tuning = {}) {
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, terms, stats, tuning) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/**
 * Select relevant skills ranked by score and bounded by a CONTEXT token budget
 * (default ~3% of a 200k window) rather than a fixed count. The relevance floor
 * decides what's in scope; the budget decides how many of those fit. Pass
 * `tokensOf(entry)` to size skills by their real SKILL.md; otherwise a per-skill
 * estimate is used. Returns [{ name, description, file, score, tokens }].
 */
export function selectSkills(
  entries,
  termsOrFacets,
  { tokenBudget = DEFAULT_TOKEN_BUDGET, tokensOf, tuning = {} } = {},
) {
  const facets = normalizeFacets(termsOrFacets)
  const stats = buildDocFrequency(entries)
  const rankFor = (terms) =>
    entries
      .map((entry) => ({ ...entry, ...matchDetail(entry, terms, stats, tuning) }))
      .filter((entry) => entry.score > 0 && clearsFloor(entry))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  // Each facet gets its own share of the budget: on a combined term list a strong
  // facet crowds the weak one out of the ranking entirely (the "build a dashboard
  // AND write the launch post" case), which is exactly what Step 2 forbids.
  const share = Math.floor(tokenBudget / facets.length)
  const taken = []
  const chosen = new Set()
  let used = 0

  for (const facet of facets) {
    const fitted = fitToBudget(
      rankFor(facet.terms).filter((entry) => !chosen.has(entry.name)),
      { tokenBudget: share, tokensOf },
    )
    for (const entry of fitted) {
      chosen.add(entry.name)
      used += entry.tokens
      taken.push(facets.length > 1 ? { ...entry, facet: facet.name } : entry)
    }
  }

  // Spend whatever the per-facet shares left over, so the budget stays a ceiling
  // rather than a quota: keep taking the best remaining candidates across facets.
  const remaining = tokenBudget - used
  if (remaining > 0 && facets.length > 1) {
    const rest = facets
      .flatMap((facet) => rankFor(facet.terms).map((entry) => ({ ...entry, facet: facet.name })))
      .filter((entry) => !chosen.has(entry.name))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    for (const entry of fitToBudget(rest, { tokenBudget: remaining, tokensOf })) {
      if (chosen.has(entry.name)) continue
      chosen.add(entry.name)
      taken.push(entry)
    }
  }

  return taken.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

const DEFAULT_SHORTLIST_MAX_TERMS = 4 // enough evidence for pruning without repeating the full query
const DEFAULT_SHORTLIST_DESC_CHARS = 120 // bounds per-candidate context while retaining a useful summary
const DEFAULT_SHORTLIST_MAX_ENTRIES = 30 // keeps the escalation payload within its prompt-level budget
const SHORTLIST_MAX_CHARS = 4_000 // ~1k tokens: the reranker's escalation-payload allowance
const SHORTLIST_NAME_CHARS = 64 // preserves distinctive skill slugs without letting one consume a line
const SHORTLIST_FACET_CHARS = 32 // facet labels stay recognizable without crowding out evidence
const SHORTLIST_TERM_CHARS = 48 // query evidence stays useful while pathological terms remain bounded
const SHORTLIST_PROVENANCE_CHARS = 72 // identifies origin without exposing long machine-specific paths
const SHORTLIST_SCORE_DECIMALS = 1 // stable score precision makes candidates compact and comparable

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

function assertShortlistEntry(entry, index) {
  if (!entry || typeof entry !== 'object') throw new TypeError(`selected[${index}] must be an object`)
  if (typeof entry.name !== 'string') throw new TypeError(`selected[${index}].name must be a string`)
  if (typeof entry.description !== 'string') {
    throw new TypeError(`selected[${index}].description must be a string`)
  }
  if (!Number.isFinite(entry.score)) throw new TypeError(`selected[${index}].score must be finite`)
  if (!Array.isArray(entry.matchedTerms) || !entry.matchedTerms.every((term) => typeof term === 'string')) {
    throw new TypeError(`selected[${index}].matchedTerms must be an array of strings`)
  }
  if (entry.facet !== undefined && typeof entry.facet !== 'string') {
    throw new TypeError(`selected[${index}].facet must be a string when provided`)
  }
  if (entry.vetted !== undefined && typeof entry.vetted !== 'boolean') {
    throw new TypeError(`selected[${index}].vetted must be a boolean when provided`)
  }
  if (entry.file !== undefined && (typeof entry.file !== 'string' || !entry.file.trim())) {
    throw new TypeError(`selected[${index}].file must be a non-empty string when provided`)
  }
}

const singleLine = (value) => value.replace(/\s+/g, ' ').trim()

function truncateInline(value, maxChars) {
  const normalized = singleLine(value)
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}…`
}

function truncateDescription(description, maxChars) {
  const normalized = singleLine(description)
  if (normalized.length <= maxChars) return normalized

  const clipped = normalized.slice(0, maxChars)
  const boundary = normalized[maxChars] === ' ' ? clipped.length : clipped.lastIndexOf(' ')
  if (boundary <= 0) return truncateInline(normalized, maxChars)
  return `${clipped.slice(0, boundary).trimEnd()}…`
}

function provenanceFromFile(file) {
  if (!file) return ''
  if (/^https?:\/\//i.test(file)) {
    const origin = new URL(file).origin
    return ` source=${truncateInline(`url:${origin}`, SHORTLIST_PROVENANCE_CHARS)}`
  }

  const segments = file.replaceAll('\\', '/').split('/').filter(Boolean)
  const skillDirectory = segments.at(-1)?.toLowerCase() === 'skill.md'
    ? segments.at(-2)
    : segments.at(-1)
  const remoteIndex = segments.findIndex((segment) => segment === 'remote')
  if (remoteIndex >= 0) {
    const repository = segments[remoteIndex + 1]
    const tail = [repository, skillDirectory].filter(Boolean).join('/')
    return ` source=${truncateInline(`remote:${tail}`, SHORTLIST_PROVENANCE_CHARS)}`
  }
  const kind = segments.includes('plugins') ? 'plugin' : 'local'
  return skillDirectory
    ? ` source=${truncateInline(`${kind}:${skillDirectory}`, SHORTLIST_PROVENANCE_CHARS)}`
    : ''
}

const trustMarker = (entry) => {
  if (entry.vetted === false) return 'UNVETTED'
  if (entry.vetted === true) return 'VETTED'
  return 'LOCAL'
}

function formatShortlistEntry(entry, index, maxTerms, descChars) {
  assertShortlistEntry(entry, index)
  const name = truncateInline(entry.name, SHORTLIST_NAME_CHARS)
  const facet = entry.facet ? ` [${truncateInline(entry.facet, SHORTLIST_FACET_CHARS)}]` : ''
  const terms = entry.matchedTerms
    .slice(0, maxTerms)
    .map((term) => truncateInline(term, SHORTLIST_TERM_CHARS))
    .join(', ')
  const description = truncateDescription(entry.description, descChars)
  const trust = trustMarker(entry)
  const provenance = provenanceFromFile(entry.file)
  return (
    `- ${name}${facet} score=${entry.score.toFixed(SHORTLIST_SCORE_DECIMALS)} via: ${terms} ` +
    `[${trust}${provenance}] — description(data)=${JSON.stringify(description)}`
  )
}

function renderShortlistLines(lines, totalEntries) {
  const omitted = totalEntries - lines.length
  const omittedLine = omitted > 0 ? `- (+${omitted} lower-ranked candidates omitted)` : null
  return omittedLine ? [...lines, omittedLine].join('\n') : lines.join('\n')
}

/**
 * Render the compact, confidence-bearing candidate block consumed by the prompt-level reranker.
 * Total output stays within the reranker's ~1k-token escalation-payload allowance.
 */
export function formatShortlist(
  selected,
  {
    maxTerms = DEFAULT_SHORTLIST_MAX_TERMS,
    descChars = DEFAULT_SHORTLIST_DESC_CHARS,
    maxEntries = DEFAULT_SHORTLIST_MAX_ENTRIES,
  } = {},
) {
  if (!Array.isArray(selected)) throw new TypeError('selected must be an array')
  assertNonNegativeInteger(maxTerms, 'maxTerms')
  assertNonNegativeInteger(descChars, 'descChars')
  assertNonNegativeInteger(maxEntries, 'maxEntries')
  if (selected.length === 0) return ''

  const candidateLimit = Math.min(selected.length, maxEntries)
  const lines = []
  for (let index = 0; index < candidateLimit; index++) {
    const line = formatShortlistEntry(selected[index], index, maxTerms, descChars)
    const nextLines = [...lines, line]
    if (renderShortlistLines(nextLines, selected.length).length >= SHORTLIST_MAX_CHARS) break
    lines.push(line)
  }
  return renderShortlistLines(lines, selected.length)
}

/** Accept either a flat term list (single facet) or [{ name, terms }] facet groups. */
function normalizeFacets(termsOrFacets) {
  const value = termsOrFacets ?? []
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
    return value.filter((facet) => Array.isArray(facet.terms) && facet.terms.length > 0)
  }
  return [{ name: 'all', terms: value }]
}
