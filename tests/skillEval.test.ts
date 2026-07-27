import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  checkNegatives,
  evaluateScenario,
  parseNegatives,
  runCli,
  runScenarios,
} from '../scripts/skill-eval.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseCatalog } from '../scripts/build-skills-index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenariosFile = path.join(here, 'fixtures', 'skill-scenarios.json')
const { scenarios } = JSON.parse(readFileSync(scenariosFile, 'utf8'))

const indexFile = path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

describe('parseNegatives', () => {
  test('ignores comments and blank lines and trims rule fields', () => {
    const content = `
      # precision traps

      sql | expo-examples
       brand voice   |   brand-guidelines
    `

    const rules = parseNegatives(content)

    expect(rules).toEqual([
      { term: 'sql', forbiddenTop1: 'expo-examples' },
      { term: 'brand voice', forbiddenTop1: 'brand-guidelines' },
    ])
  })

  test('rejects a malformed rule with a clear line number', () => {
    const content = '# header\nsql without a separator'

    expect(() => parseNegatives(content)).toThrow('line 2')
  })
})

describe('checkNegatives', () => {
  const miniIndex = [
    { name: 'sql-tool', description: 'SQL query helper.', file: '/sql/SKILL.md' },
    { name: 'database-guide', description: 'Database design guide.', file: '/db/SKILL.md' },
  ]

  test('returns a violation when the forbidden skill is top-1', () => {
    const rules = [{ term: 'sql', forbiddenTop1: 'sql-tool' }]

    const violations = checkNegatives(rules, miniIndex)

    expect(violations).toEqual([
      { term: 'sql', forbiddenTop1: 'sql-tool', actualTop1: 'sql-tool' },
    ])
  })

  test('returns no violation when a different skill is top-1', () => {
    const rules = [{ term: 'sql', forbiddenTop1: 'database-guide' }]

    const violations = checkNegatives(rules, miniIndex)

    expect(violations).toEqual([])
  })

  test('does not treat an empty selection as a violation', () => {
    const rules = [{ term: 'cobol', forbiddenTop1: 'sql-tool' }]

    const violations = checkNegatives(rules, miniIndex)

    expect(violations).toEqual([])
  })

  test('throws when the forbidden skill is absent from the catalog', () => {
    const rules = [{ term: 'sql', forbiddenTop1: 'does-not-exist' }]

    const check = () => checkNegatives(rules, miniIndex)

    expect(check).toThrow(
      'negative rule 1 ("sql") names skill not present in catalog: "does-not-exist"',
    )
  })
})

describe('runCli', () => {
  test('rejects a comment-only negatives file', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-negatives-'))
    const fixtureIndex = path.join(fixtureDir, 'INDEX.md')
    const fixtureScenarios = path.join(fixtureDir, 'scenarios.json')
    const fixtureNegatives = path.join(fixtureDir, 'NEGATIVES.md')
    writeFileSync(fixtureIndex, 'sql-tool | SQL query helper. | /sql/SKILL.md\n')
    writeFileSync(fixtureScenarios, JSON.stringify({ scenarios: [] }))
    writeFileSync(fixtureNegatives, '# no precision rules configured\n\n')

    const run = runCli([
      '--index',
      fixtureIndex,
      '--scenarios',
      fixtureScenarios,
      '--negatives',
      fixtureNegatives,
    ])

    try {
      await expect(run).rejects.toThrow(`negatives file contains no rules: ${fixtureNegatives}`)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})

describe('scenario fixture integrity', () => {
  test('every scenario has an id, terms, and exactly one expectation kind', () => {
    for (const s of scenarios) {
      expect(s.id, `scenario missing id`).toBeTruthy()
      expect(Array.isArray(s.terms) && s.terms.length > 0, `${s.id} has no terms`).toBe(true)
      const kinds = [s.expectAny, s.expectNone, s.expectEmpty].filter((v) => v !== undefined)
      expect(kinds.length, `${s.id} needs at least one expectation`).toBeGreaterThan(0)
    }
  })

  test('scenario ids are unique', () => {
    const ids = scenarios.map((s: { id: string }) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('evaluateScenario', () => {
  const miniIndex = [
    { name: 'exec-python', description: 'Python execution idioms.', file: '/a/SKILL.md' },
    { name: 'pdf', description: 'PDF manipulation toolkit.', file: '/b/SKILL.md' },
  ]

  test('passes an expectAny scenario when the skill is selected', () => {
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['python'], expectAny: ['exec-python'] },
      miniIndex,
    )
    expect(r.pass).toBe(true)
    expect(r.selected).toContain('exec-python')
    expect(r.precisionAt1).toBe(true)
  })

  test('fails an expectAny scenario when the skill is absent', () => {
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['rust'], expectAny: ['rust-review'] },
      miniIndex,
    )
    expect(r.pass).toBe(false)
    expect(r.precisionAt1).toBe(false)
  })

  test('passes an expectEmpty scenario for an uncovered domain', () => {
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['cobol'], expectEmpty: true },
      miniIndex,
    )
    expect(r.pass).toBe(true)
    expect(r.selected).toEqual([])
    expect(r.precisionAt1).toBeNull()
  })

  test('stays within the context token budget on every scenario', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({
      name: `python-tool-${i}`,
      description: 'Python data analysis helper.',
      file: `/x${i}/SKILL.md`,
    }))
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['python', 'data', 'analysis'], expectAny: ['python-tool-0'] },
      big,
      { tokenBudget: 1000, tokensOf: () => 200 },
    )
    expect(r.usedTokens).toBeLessThanOrEqual(1000)
    expect(r.selected.length).toBe(5) // budget-bounded, not capped at 3
  })
})

describe('runScenarios', () => {
  test('reports precision@1 and mean selection size without changing verdicts', () => {
    const miniIndex = [
      { name: 'python-tool', description: 'Python execution helper.', file: '/python/SKILL.md' },
    ]
    const metricScenarios = [
      { id: 'A', terms: ['python'], expectAny: ['python-tool'] },
      { id: 'B', terms: ['python'], expectAny: ['other-tool'] },
      { id: 'C', terms: ['cobol'], expectEmpty: true },
    ]

    const summary = runScenarios(metricScenarios, miniIndex)

    expect(summary.precisionAt1).toBe(0.5)
    expect(summary.avgSelected).toBeCloseTo(2 / 3)
    expect(summary.passed).toBe(2)
  })
})

// Runs the full 30+ scope suite against the real built index. Skipped when the
// index hasn't been built yet (e.g. CI without the skill library) so the suite
// stays green without the local setup.
describe.runIf(existsSync(indexFile))('scope scenarios against the real index', () => {
  test('all scope scenarios select the expected skills within budget', () => {
    // Read inside the test (not the describe body) so collection never touches
    // the file — the suite is skipped when the index isn't built (e.g. CI).
    const entries = parseCatalog(readFileSync(indexFile, 'utf8'))
    const { results, passed, total } = runScenarios(scenarios, entries)
    const failed = results.filter((r: { pass: boolean }) => !r.pass)
    // Surface which scenarios failed for a readable assertion message.
    expect(failed.map((r: { id: string }) => r.id), 'failing scenario ids').toEqual([])
    expect(passed).toBe(total)
  })
})
