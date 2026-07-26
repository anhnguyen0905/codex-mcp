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

/**
 * Match one entry against derived terms, returning a breakdown:
 *   { score, nameHits, phraseHits, descHits } — enough for both ranking and the
 *   relevance floor (a single generic description word must not qualify a skill).
 */
export function matchDetail(entry, terms, stats = null) {
  const nameWords = new Set(words(entry.name))
  const descWords = new Set(words(entry.description))
  const descText = entry.description.toLowerCase()
  const nameNorm = stemPhrase(entry.name)
  const descNorm = stemPhrase(entry.description)

  let score = 0
  let nameHits = 0
  let phraseHits = 0
  let descHits = 0

  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase().trim()
    if (!term) continue
    const stemmed = stem(term)

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
      }
      continue
    }
    const weight = idfWeight(term, stats)
    if (term.length < MIN_TERM_LEN) {
      if (nameWords.has(stemmed)) {
        score += NAME_WORD * weight
        nameHits++
      } else if (descWords.has(stemmed)) {
        score += DESC_WORD * weight
        descHits++
      }
      continue
    }
    if (nameWords.has(stemmed)) {
      score += NAME_WORD * weight
      nameHits++
    } else if (descWords.has(stemmed)) {
      score += DESC_WORD * weight
      descHits++
    } else if (descText.includes(term)) {
      score += SUBSTRING * weight
    }
  }
  return { score, nameHits, phraseHits, descHits }
}

/** Score one index entry against derived terms (higher = more relevant; 0 = no match). */
export function scoreEntry(entry, terms, stats = null) {
  return matchDetail(entry, terms, stats).score
}

// A skill clears the relevance floor only with a strong signal — a name hit, a
// phrase hit, or ≥2 distinct description terms. One generic desc word (e.g. "batch"
// leaking into an unrelated skill) is not enough to qualify an uncovered domain.
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
export function rankCandidates(entries, terms, stats = buildDocFrequency(entries)) {
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, terms, stats) }))
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
export function selectSkills(entries, termsOrFacets, { tokenBudget = DEFAULT_TOKEN_BUDGET, tokensOf } = {}) {
  const facets = normalizeFacets(termsOrFacets)
  const stats = buildDocFrequency(entries)
  const rankFor = (terms) =>
    entries
      .map((entry) => ({ ...entry, ...matchDetail(entry, terms, stats) }))
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

/** Accept either a flat term list (single facet) or [{ name, terms }] facet groups. */
function normalizeFacets(termsOrFacets) {
  const value = termsOrFacets ?? []
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
    return value.filter((facet) => Array.isArray(facet.terms) && facet.terms.length > 0)
  }
  return [{ name: 'all', terms: value }]
}
