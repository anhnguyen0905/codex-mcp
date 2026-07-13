import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { runScenarios, evaluateScenario } from '../scripts/skill-eval.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseCatalog } from '../scripts/build-skills-index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenariosFile = path.join(here, 'fixtures', 'skill-scenarios.json')
const { scenarios } = JSON.parse(readFileSync(scenariosFile, 'utf8'))

const indexFile = path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

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
  })

  test('fails an expectAny scenario when the skill is absent', () => {
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['rust'], expectAny: ['rust-review'] },
      miniIndex,
    )
    expect(r.pass).toBe(false)
  })

  test('passes an expectEmpty scenario for an uncovered domain', () => {
    const r = evaluateScenario(
      { id: 'X', scope: 's', facet: 'f', request: '', terms: ['cobol'], expectEmpty: true },
      miniIndex,
    )
    expect(r.pass).toBe(true)
    expect(r.selected).toEqual([])
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
