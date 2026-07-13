import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { scoreEntry, rankCandidates, selectSkills, fitToBudget, DEFAULT_TOKEN_BUDGET } from '../scripts/skill-match.mjs'

const INDEX = [
  { name: 'exec-typescript', description: 'TypeScript/JavaScript execution idioms — type safety, async correctness, Node conventions.', file: '/a/exec-typescript/SKILL.md' },
  { name: 'exec-python', description: 'Python execution idioms — PEP 8, type hints, error handling, packaging.', file: '/a/exec-python/SKILL.md' },
  { name: 'polars', description: 'Fast DataFrame library for data analysis in Python; alternative to pandas.', file: '/a/polars/SKILL.md' },
  { name: 'd3-viz', description: 'Creating interactive data visualisations and custom charts using d3.js.', file: '/a/d3-viz/SKILL.md' },
  { name: 'market-research-reports', description: 'Produce market research reports, competitor analysis, and positioning.', file: '/a/market-research-reports/SKILL.md' },
  { name: 'pdf', description: 'PDF manipulation toolkit — extract text and tables, merge/split documents.', file: '/a/pdf/SKILL.md' },
]

describe('scoreEntry', () => {
  test('scores a whole-word name hit higher than a description-only hit', () => {
    // Arrange
    const terms = ['typescript']

    // Act
    const nameHit = scoreEntry(INDEX[0], terms) // "typescript" in name
    const descOnly = scoreEntry(INDEX[1], terms) // python skill, no ts

    // Assert
    expect(nameHit).toBeGreaterThan(0)
    expect(descOnly).toBe(0)
  })

  test('accumulates score across multiple matching terms', () => {
    const one = scoreEntry(INDEX[2], ['dataframe'])
    const two = scoreEntry(INDEX[2], ['dataframe', 'pandas'])

    expect(two).toBeGreaterThan(one)
  })

  test('matches a multi-word phrase in the description', () => {
    const phrase = scoreEntry(INDEX[3], ['data visualisation'])

    expect(phrase).toBeGreaterThan(0)
  })

  test('returns 0 when no term matches', () => {
    expect(scoreEntry(INDEX[5], ['kubernetes', 'helm'])).toBe(0)
  })

  test('ignores very short noise terms', () => {
    // 2-char terms must not substring-match everything
    expect(scoreEntry(INDEX[0], ['ts'])).toBe(0)
  })
})

describe('rankCandidates', () => {
  test('orders matching entries by descending score and drops zero-score entries', () => {
    // Arrange
    const terms = ['data', 'analysis', 'dataframe', 'pandas']

    // Act
    const ranked = rankCandidates(INDEX, terms)

    // Assert
    expect(ranked[0].name).toBe('polars')
    expect(ranked.every((r: { score: number }) => r.score > 0)).toBe(true)
    expect(ranked.map((r: { name: string }) => r.name)).not.toContain('pdf')
  })
})

describe('fitToBudget', () => {
  test('takes relevant skills until the token budget is exhausted, highest rank first', () => {
    // Arrange — three ranked skills, each 400 tokens, budget fits two.
    const ranked = [
      { name: 'a', score: 10 },
      { name: 'b', score: 8 },
      { name: 'c', score: 6 },
    ]

    // Act
    const taken = fitToBudget(ranked, { tokenBudget: 900, tokensOf: () => 400 })

    // Assert
    expect(taken.map((t: { name: string }) => t.name)).toEqual(['a', 'b'])
    expect(taken.every((t: { tokens: number }) => t.tokens === 400)).toBe(true)
  })

  test('skips an oversized skill but keeps taking smaller lower-ranked ones', () => {
    const ranked = [
      { name: 'huge', score: 10 },
      { name: 'small', score: 5 },
    ]
    const sizes: Record<string, number> = { huge: 9000, small: 300 }

    const taken = fitToBudget(ranked, { tokenBudget: 6000, tokensOf: (e: { name: string }) => sizes[e.name] })

    expect(taken.map((t: { name: string }) => t.name)).toEqual(['small'])
  })

  test('defaults to ~3% of a 200k window', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(6000)
  })
})

describe('selectSkills', () => {
  test('is bounded by context budget, not a fixed count — loads all that fit', () => {
    // 6 relevant skills at 200 tokens each; a 1000-token budget fits 5, not a hard 3.
    const many = Array.from({ length: 6 }, (_, i) => ({
      name: `python-tool-${i}`,
      description: 'Python data analysis helper.',
      file: `/x${i}/SKILL.md`,
    }))
    const selected = selectSkills(many, ['python', 'data', 'analysis'], {
      tokenBudget: 1000,
      tokensOf: () => 200,
    })

    expect(selected.length).toBe(5)
  })

  test('does not force-fill with irrelevant skills below the relevance floor', () => {
    // Only one term that matches exactly one skill; budget is 3 but only 1 is relevant.
    const selected = selectSkills(INDEX, ['pdf'], { budget: 3 })

    expect(selected.map((s: { name: string }) => s.name)).toEqual(['pdf'])
  })

  test('returns empty for an uncovered domain', () => {
    const selected = selectSkills(INDEX, ['cobol', 'mainframe'], { budget: 3 })

    expect(selected).toEqual([])
  })

  test('does not qualify a skill on a single generic description word', () => {
    // "toolkit" appears only in pdf's description; one generic word is below the floor.
    const selected = selectSkills(INDEX, ['toolkit'], { budget: 3 })

    expect(selected).toEqual([])
  })

  test('matches a hyphenated skill name against a spaced phrase term', () => {
    const tdd = [
      { name: 'test-driven-development', description: 'Write tests first, then implement.', file: '/a/tdd/SKILL.md' },
      { name: 'mutation-testing', description: 'Assess test suite quality by mutating code.', file: '/a/mut/SKILL.md' },
    ]

    const selected = selectSkills(tdd, ['test driven', 'testing'], { budget: 3 })

    expect(selected.map((s: { name: string }) => s.name)).toContain('test-driven-development')
  })
})
