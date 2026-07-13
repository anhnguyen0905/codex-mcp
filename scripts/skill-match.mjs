#!/usr/bin/env node
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

const words = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
// Normalize separators (hyphen/underscore/slash) to spaces so "test-driven" == "test driven".
const normalizePhrase = (text) => text.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Match one entry against derived terms, returning a breakdown:
 *   { score, nameHits, phraseHits, descHits } — enough for both ranking and the
 *   relevance floor (a single generic description word must not qualify a skill).
 */
export function matchDetail(entry, terms) {
  const nameWords = new Set(words(entry.name))
  const descWords = new Set(words(entry.description))
  const descText = entry.description.toLowerCase()
  const nameNorm = normalizePhrase(entry.name)
  const descNorm = normalizePhrase(entry.description)

  let score = 0
  let nameHits = 0
  let phraseHits = 0
  let descHits = 0

  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase().trim()
    if (!term) continue

    if (/[-_/\s]/.test(term)) {
      const phrase = normalizePhrase(term)
      // Score phrases by specificity: a longer phrase hit outranks a single generic word.
      const phraseWords = phrase.split(' ').length
      if (nameNorm.includes(phrase)) {
        score += NAME_PHRASE + (phraseWords - 1) * DESC_PHRASE
        nameHits++
      } else if (descNorm.includes(phrase)) {
        score += DESC_PHRASE + (phraseWords - 1) * DESC_WORD
        phraseHits++
      }
      continue
    }
    if (term.length < MIN_TERM_LEN) {
      if (nameWords.has(term)) {
        score += NAME_WORD
        nameHits++
      } else if (descWords.has(term)) {
        score += DESC_WORD
        descHits++
      }
      continue
    }
    if (nameWords.has(term)) {
      score += NAME_WORD
      nameHits++
    } else if (descWords.has(term)) {
      score += DESC_WORD
      descHits++
    } else if (descText.includes(term)) {
      score += SUBSTRING
    }
  }
  return { score, nameHits, phraseHits, descHits }
}

/** Score one index entry against derived terms (higher = more relevant; 0 = no match). */
export function scoreEntry(entry, terms) {
  return matchDetail(entry, terms).score
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
export function rankCandidates(entries, terms) {
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, terms) }))
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
export function selectSkills(entries, terms, { tokenBudget, tokensOf } = {}) {
  const ranked = entries
    .map((entry) => ({ ...entry, ...matchDetail(entry, terms) }))
    .filter((entry) => entry.score > 0 && clearsFloor(entry))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return fitToBudget(ranked, { tokenBudget, tokensOf })
}
