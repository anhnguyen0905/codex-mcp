import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  checkNegatives,
  evaluateScenario,
  exitCodeFor,
  parseNegatives,
  runCli,
  runScenarios,
  renderReport,
  validateScenarios,
} from '../scripts/skill-eval.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseCatalog } from '../scripts/build-skills-index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenariosFile = path.join(here, 'fixtures', 'skill-scenarios.json')
const { scenarios } = JSON.parse(readFileSync(scenariosFile, 'utf8'))
const scenarios500File = path.join(here, 'fixtures', 'scenarios-500.json')
const { scenarios: scenarios500 } = JSON.parse(readFileSync(scenarios500File, 'utf8'))

const indexFile = path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

describe('validateScenarios', () => {
  test.each([
    ['empty expectAny', [{ id: 'S1', terms: [{ name: 'facet', terms: ['term'], expectAny: [] }] }]],
    ['non-object facet', [{ id: 'S2', terms: [{ name: 'facet', terms: ['term'] }, 'bad'] }]],
    ['empty facet terms', [{ id: 'S8', terms: [{ name: 'facet', terms: [], expectAny: ['skill'] }] }]],
    ['non-string facet term', [{ id: 'S9', terms: [{ name: 'facet', terms: [7], expectAny: ['skill'] }] }]],
    ['missing facet name', [{ id: 'S3', terms: [{ terms: ['term'], expectAny: ['skill'] }] }]],
    ['invalid expectAny', [{ id: 'S4', terms: [{ name: 'facet', terms: ['term'], expectAny: [7] }] }]],
    ['invalid rejectAny', [{
      id: 'S5', terms: [{ name: 'facet', terms: ['term'], expectAny: ['skill'] }], rejectAny: [''],
    }]],
    ['invalid facet rejectAny', [{
      id: 'S6', terms: [{ name: 'facet', terms: ['term'], expectAny: ['skill'], rejectAny: [''] }],
    }]],
  ])('rejects %s with scenario and facet context', (_case, scenarios) => {
    const expected = scenarios[0].rejectAny ? /scenario S\d+:/ : /scenario S\d+ facet/
    expect(() => validateScenarios(scenarios)).toThrow(expected)
  })

  test('accepts a valid supported and uncovered facet set', () => {
    expect(() => validateScenarios([
      { id: 'S7', terms: [
        { name: 'supported', terms: ['term'], expectAny: ['skill'] },
        { name: 'uncovered', terms: ['nothing'], note: 'expected uncovered' },
      ] },
    ])).not.toThrow()
  })
})

describe('split selection', () => {
  test('prints the selected split in the report header', () => {
    const report = renderReport(runScenarios([], [], {}), { index: 'memory', indexCount: 0, raw: true, split: 'dev' })
    expect(report).toContain('Split: dev')
  })

  test('evaluates exactly the scenarios of the requested split', async () => {
    // Arrange: a temporary index, so the test does not depend on a skill library on this machine.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-split-'))
    try {
      const index = path.join(dir, 'INDEX.md')
      const file = path.join(dir, 'scenarios.json')
      writeFileSync(index, 'term-skill | term helper | /x/SKILL.md\n')
      writeFileSync(file, JSON.stringify({ scenarios: [
        { id: 'dev', split: 'dev', request: 'term', terms: ['term'] },
        { id: 'holdout', split: 'holdout', request: 'other', terms: ['other'] },
      ] }))

      // Act
      const result = await runCli(['--index', index, '--scenarios', file, '--split', 'dev'])

      // Assert
      expect(result.total).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects a split that no scenario carries', async () => {
    // Arrange
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-split-'))
    try {
      const index = path.join(dir, 'INDEX.md')
      const file = path.join(dir, 'scenarios.json')
      writeFileSync(index, 'term-skill | term helper | /x/SKILL.md\n')
      writeFileSync(file, JSON.stringify({ scenarios: [{ id: 'dev', split: 'dev', request: 'term', terms: ['term'] }] }))

      // Act
      const run = runCli(['--index', index, '--scenarios', file, '--split', 'missing'])

      // Assert
      await expect(run).rejects.toThrow('unknown split: missing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderReport', () => {
  test('prints every summary metric from the computed summary', () => {
    // Arrange
    const scenarios = [
      { id: 'S1', scope: 'demo', facet: 'demo', request: 'term', terms: ['term'], expectAny: ['term-skill'] },
      {
        id: 'S2', scope: 'demo', facet: 'demo', request: 'none', terms: ['none'],
        expectAny: ['term-skill'], rejectAny: ['none-noise'],
      },
    ]
    const entries = [
      { name: 'term-skill', description: 'term', file: '/skill' },
      { name: 'none-noise', description: 'none', file: '/noise' },
    ]
    const summary = runScenarios(scenarios, entries, { tokenBudget: 6000, tokensOf: () => 100 })
    const report = renderReport(summary, { index: 'memory', indexCount: entries.length, raw: false })

    // Act
    const passLine = `Passed: ${summary.passed}/${summary.total} `
      + `(${(summary.passed / summary.total * 100).toFixed(1)}%)`

    // Assert
    expect(report).toContain(passLine)
    expect(report).toContain(
      `Precision@1 (Hit@1): ${summary.results.filter((r) => r.precisionAt1).length}/`
        + `${summary.results.filter((r) => r.precisionAt1 !== null).length} `
        + `(${(summary.precisionAt1 * 100).toFixed(1)}%)`,
    )
    expect(report).toContain(
      `Top-3 hit rate: ${summary.top3HitNumerator}/${summary.top3HitDenominator}`
        + ` (${(summary.top3HitRate * 100).toFixed(1)}%)`,
    )
    expect(report).toContain(`Average selection size: ${summary.avgSelected.toFixed(2)}`)
    expect(report).toContain(
      `Noise rate: ${summary.noiseNumerator}/${summary.noiseDenominator}`
        + ` (${(summary.noiseRate * 100).toFixed(1)}%)`,
    )
    expect(report).toContain(
      `Noisy selections: ${summary.noisySelectionNumerator}/${summary.noisySelectionDenominator}`
        + ` (${(summary.noisySkillShare * 100).toFixed(1)}%)`,
    )
    expect(report).toContain('Per-facet coverage: n/a (no facet expectations)')
  })

  test('prints numeric per-facet coverage and details facets missed by their own picks', () => {
    // Arrange
    const scenarios = [{
      id: 'F1', scope: 'demo', facet: 'a+b', request: 'alpha beta',
      terms: [
        { name: 'a', terms: ['alpha'], expectAny: ['beta-wanted'] },
        { name: 'b', terms: ['beta'], expectAny: ['missing-skill'] },
      ],
    }]
    // beta-wanted only matches facet b's term, so facet a is covered through another facet.
    const entries = [
      { name: 'alpha-helper', description: 'alpha helper', file: '/other' },
      { name: 'beta-wanted', description: 'beta helper', file: '/wanted' },
    ]
    const summary = runScenarios(scenarios, entries, { tokenBudget: 6000, tokensOf: () => 100 })

    // Act
    const report = renderReport(summary, { index: 'memory', indexCount: entries.length, raw: false })

    // Assert
    expect(report).toContain('Per-facet coverage: 1/2 (50.0%)')
    const detail = report.split('\n').filter((line: string) => line.startsWith('- **F1 / '))
    expect(detail).toHaveLength(2)
    expect(detail[0]).toContain('F1 / a')
    expect(detail[0]).toContain('covered under another facet: yes')
    expect(detail[1]).toContain('F1 / b')
    expect(detail[1]).toContain('covered under another facet: no')
  })
})

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

  test('rejectAny labels cover enough scopes without duplicates or expectAny overlap', () => {
    const labelled = scenarios500.filter((s) => s.rejectAny !== undefined)
    expect(labelled.length).toBeGreaterThanOrEqual(45)
    expect(new Set(labelled.map((s) => s.scope)).size).toBeGreaterThanOrEqual(12)
    for (const scenario of labelled) {
      expect(new Set(scenario.rejectAny).size, `${scenario.id} duplicate rejectAny`).toBe(
        scenario.rejectAny.length,
      )
      expect(
        scenario.rejectAny.some((name) => (scenario.expectAny ?? []).includes(name)),
        `${scenario.id} rejectAny overlaps expectAny`,
      ).toBe(false)
    }
  })
})

describe('evaluateScenario', () => {
  const miniIndex = [
    { name: 'exec-python', description: 'Python execution idioms.', file: '/a/SKILL.md' },
    { name: 'pdf', description: 'PDF manipulation toolkit.', file: '/b/SKILL.md' },
  ]

  test('raw mode derives terms from request instead of oracle terms', () => {
    const result = evaluateScenario(
      { id: 'RAW', request: 'write python code', terms: ['rust'], expectAny: ['exec-python'] },
      miniIndex,
      { raw: true },
    )
    expect(result.pass).toBe(true)
    expect(result.terms).toContain('python')
  })

  test('raw mode fails when oracle terms pass but request lacks their vocabulary', () => {
    const result = evaluateScenario(
      { id: 'RAW-MISS', request: 'write a document', terms: ['python'], expectAny: ['exec-python'] },
      miniIndex,
      { raw: true },
    )
    expect(result.pass).toBe(false)
    expect(result.selected).not.toContain('exec-python')
  })

  test('raw mode treats a multi-facet scenario as one request facet', () => {
    const result = evaluateScenario({
      id: 'RAW-FACETS',
      request: 'write python code',
      terms: [{ name: 'code', terms: ['python'], expectAny: ['exec-python'] }],
      expectAny: ['exec-python'],
    }, miniIndex, { raw: true })
    expect(result.pass).toBe(true)
    expect(result.facetCoverage).toBeNull()
  })

  test('runCli report states raw and oracle term modes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-mode-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarios = path.join(dir, 'scenarios.json')
    writeFileSync(index, 'exec-python | Python execution idioms. | /a/SKILL.md\n')
    writeFileSync(scenarios, JSON.stringify({ scenarios: [{
      id: 'MODE', request: 'write python code', terms: ['python'], expectAny: ['exec-python'],
    }] }))
    try {
      const raw = await runCli(['--index', index, '--scenarios', scenarios, '--raw'])
      const oracle = await runCli(['--index', index, '--scenarios', scenarios])
      expect(raw.report).toContain('- Terms: raw (derived from request)')
      expect(oracle.report).toContain('- Terms: oracle')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

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
      {
        id: 'X',
        scope: 's',
        facet: 'f',
        request: '',
        terms: ['python', 'data', 'analysis'],
        expectAny: ['python-tool-0'],
      },
      big,
      { tokenBudget: 1000, tokensOf: () => 200 },
    )
    expect(r.usedTokens).toBeLessThanOrEqual(1000)
    expect(r.selected.length).toBe(5) // budget-bounded, not capped at 3
  })

  test('reports noise and top-three hits without changing pass', () => {
    const index = [
      { name: 'python-tool', description: 'Python execution helper.', file: '/a/SKILL.md' },
      { name: 'wrong-python', description: 'Python execution helper.', file: '/b/SKILL.md' },
    ]
    const noisy = evaluateScenario(
      { id: 'N', terms: ['python'], expectAny: ['python-tool'], rejectAny: ['python-tool'] },
      index,
    )
    expect(noisy.noise).toEqual(['python-tool'])
    expect(noisy.top3Hit).toBe(true)
    expect(noisy.pass).toBe(true)
    expect(evaluateScenario({ id: 'C', terms: ['python'], rejectAny: [] }, index).noise).toEqual([])
    expect(evaluateScenario({ id: 'U', terms: ['python'] }, index).noise).toBeNull()
    expect(evaluateScenario({ id: 'M', terms: ['rust'], expectAny: ['rust-skill'] }, index).top3Hit).toBe(false)
    expect(evaluateScenario({ id: 'E', terms: ['rust'] }, index).top3Hit).toBeNull()
  })

  test('reports per-facet coverage, attribution, and uncovered facet failures', () => {
    const index = [
      { name: 'alpha-skill', description: 'Alpha beta workflow.', file: '/a/SKILL.md' },
      { name: 'beta-skill', description: 'Beta workflow.', file: '/b/SKILL.md' },
    ]
    const result = evaluateScenario({
      id: 'FACET',
      terms: [
        { name: 'alpha', terms: ['alpha'], expectAny: ['alpha-skill'] },
        { name: 'beta', terms: ['beta'], expectAny: ['missing'] },
        { name: 'none', terms: ['cobol'] },
      ],
    }, index)
    expect(result.facetCoverage).toEqual([
      { facet: 'alpha', expected: true, covered: true, selected: ['alpha-skill'] },
      { facet: 'beta', expected: true, covered: false, selected: ['beta-skill'] },
      { facet: 'none', expected: false, covered: null, selected: [] },
    ])
    expect(result.checks).toContainEqual({ kind: 'facet', facet: 'beta', pass: false })
    expect(result.pass).toBe(false)
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

  test('reports generic-only picks among expected and rejected labels', () => {
    const index = [
      { name: 'expected', description: 'Common workflow guidance.', file: '/e/SKILL.md' },
      { name: 'noise', description: 'Common workflow notes.', file: '/n/SKILL.md' },
      { name: 'other', description: 'Common workflow examples.', file: '/o/SKILL.md' },
    ]
    const summary = runScenarios([
      { id: 'A', terms: ['common', 'workflow'], expectAny: ['expected'], rejectAny: ['noise'] },
    ], index)
    const report = renderReport(summary, { index: 'memory', indexCount: index.length, raw: false })
    expect(summary.genericOnlyPicks).toBe(3)
    expect(summary.genericOnlyExpectedPicks).toBe(1)
    expect(summary.genericOnlyNoisePicks).toBe(1)
    expect(report).toContain('Generic-only picks: 3/3 (100.0%)')
    expect(report).toContain('Generic-only among expected picks: 1/1 (100.0%)')
  })

  test('reports MRR, per-scope recall, and expectNone false-positive rate', () => {
    // dual-review IMP-C: one aggregate pass count hides ranking quality and
    // per-domain gaps — the summary must expose MRR, per-scope recall, FP rate.
    const miniIndex = [
      { name: 'excel-helper', description: 'Excel spreadsheet processing toolkit.', file: '/x/SKILL.md' },
      { name: 'sql-guide', description: 'SQL query and excel export patterns.', file: '/s/SKILL.md' },
    ]
    const metricScenarios = [
      // hit at rank 1 → reciprocal rank 1
      { id: 'A', scope: 'data', terms: ['excel', 'spreadsheet'], expectAny: ['excel-helper'] },
      // hit at rank 2 → reciprocal rank 0.5 (sql-guide outranks on the sql term)
      { id: 'B', scope: 'data', terms: ['sql', 'excel'], expectAny: ['excel-helper'] },
      // miss → reciprocal rank 0, and scope "ops" recall 0/1
      { id: 'C', scope: 'ops', terms: ['cobol mainframe'], expectAny: ['excel-helper'] },
      // expectNone violated → counts into fpRate
      { id: 'D', scope: 'ops', terms: ['excel', 'spreadsheet'], expectNone: ['excel-helper'] },
      // expectNone respected
      { id: 'E', scope: 'ops', terms: ['excel', 'spreadsheet'], expectNone: ['sql-guide'] },
    ]

    const summary = runScenarios(metricScenarios, miniIndex)

    expect(summary.mrr).toBeCloseTo((1 + 0.5 + 0) / 3)
    expect(summary.perScope).toEqual({
      data: { passed: 2, total: 2 },
      ops: { passed: 1, total: 3 },
    })
    expect(summary.fpRate).toBeCloseTo(1 / 2)
  })

  test('fpRate is null when no scenario carries expectNone', () => {
    const miniIndex = [
      { name: 'excel-helper', description: 'Excel spreadsheet processing toolkit.', file: '/x/SKILL.md' },
    ]
    const summary = runScenarios(
      [{ id: 'A', scope: 'data', terms: ['excel', 'spreadsheet'], expectAny: ['excel-helper'] }],
      miniIndex,
    )

    expect(summary.fpRate).toBeNull()
  })

  test('aggregates noise and top-three rates, including the no-label case', () => {
    const index = [{ name: 'python-tool', description: 'Python execution helper.', file: '/x/SKILL.md' }]
    const summary = runScenarios([
      { id: 'A', terms: ['python'], expectAny: ['python-tool'], rejectAny: ['other'] },
      { id: 'B', terms: ['python'], expectAny: ['other'], rejectAny: ['python-tool'] },
    ], index)
    expect(summary.noiseRate).toBe(0.5)
    expect(summary.noisySkillShare).toBe(0.5)
    expect(summary.top3HitRate).toBe(0.5)
    const empty = runScenarios([{ id: 'E', terms: ['rust'], expectEmpty: true }], index)
    expect(empty.noiseRate).toBeNull()
    expect(empty.noisySkillShare).toBeNull()
    expect(empty.top3HitRate).toBeNull()
  })

  test('aggregates facet coverage and reports n/a without facet expectations', () => {
    const index = [{ name: 'alpha-skill', description: 'Alpha workflow.', file: '/a/SKILL.md' }]
    const summary = runScenarios([
      { id: 'A', terms: [{ name: 'alpha', terms: ['alpha'], expectAny: ['alpha-skill'] }] },
      { id: 'B', terms: [{ name: 'beta', terms: ['beta'] }] },
    ], index)
    expect(summary.facetCoverageRate).toBe(1)
    expect(summary.facetCoverageNumerator).toBe(1)
    expect(summary.facetCoverageDenominator).toBe(1)
    expect(runScenarios([{ id: 'C', terms: ['cobol'] }], index).facetCoverageRate).toBeNull()
  })
})

describe('scenario validation and CLI gates', () => {
  test.each([
    [{ passed: 499, total: 500 }, {}, 1],
    [{ passed: 499, total: 500 }, { minPass: 0.99 }, 0],
    [{ passed: 499, total: 500 }, { minPass: 1 }, 1],
    [{ passed: 500, total: 500, negativeViolations: [{}] }, { minPass: 0.99 }, 1],
    [{ passed: 500, total: 500, gates: [['max-noise', 0.9, 0.5]] }, { minPass: 0.99 }, 1],
    [{ passed: 0, total: 0 }, { minPass: 0.99 }, 1],
    [{ passed: 1, total: 1, facetCoverageRate: 1, gates: [] }, { minFacetCoverage: 0.85 }, 0],
    [{ passed: 1, total: 1, facetCoverageRate: 0.5, gates: [['min-facet-coverage', 0.5, 0.85]] }, { minFacetCoverage: 0.85 }, 1],
    [{ passed: 1, total: 1, facetCoverageRate: null, gates: [['min-facet-coverage', 0, 0.85]] }, { minFacetCoverage: 0.85 }, 1],
  ])('returns the expected process code for %j', (summary, options, expected) => {
    expect(exitCodeFor(summary, options)).toBe(expected)
  })

  test('rejects invalid rejectAny with the scenario id', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-invalid-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, [
      'python-tool | Python execution helper. | /x/SKILL.md',
      'wrong-python | Python execution helper. | /y/SKILL.md',
    ].join('\n') + '\n')
    writeFileSync(scenarioFile, JSON.stringify({ scenarios: [{ id: 'BAD7', terms: ['python'], rejectAny: [''] }] }))
    try {
      await expect(runCli(['--index', index, '--scenarios', scenarioFile])).rejects.toThrow('BAD7')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects invalid facet expectAny with scenario id and facet', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-invalid-facet-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, 'alpha-skill | Alpha workflow. | /a/SKILL.md\n')
    writeFileSync(scenarioFile, JSON.stringify({ scenarios: [{
      id: 'BAD-FACET', terms: [{ name: 'analysis', terms: ['alpha'], expectAny: [''] }],
    }] }))
    try {
      await expect(runCli(['--index', index, '--scenarios', scenarioFile]))
        .rejects.toThrow('BAD-FACET facet analysis')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects rejectAny overlap with expectAny and names the skill', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-overlap-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, 'python-tool | Python execution helper. | /x/SKILL.md\n')
    writeFileSync(scenarioFile, JSON.stringify({ scenarios: [{
      id: 'OVERLAP1',
      terms: ['python'],
      expectAny: ['python-tool'],
      rejectAny: ['python-tool'],
    }] }))
    try {
      await expect(runCli(['--index', index, '--scenarios', scenarioFile]))
        .rejects.toThrow('OVERLAP1')
      await expect(runCli(['--index', index, '--scenarios', scenarioFile]))
        .rejects.toThrow('python-tool')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['--max-avg-selection', '-1'],
    ['--max-noise', 'NaN'],
    ['--max-noise', '2'],
    ['--min-pass', '-0.1'],
    ['--min-pass', '1.1'],
    ['--min-facet-coverage', 'NaN'],
    ['--min-facet-coverage', '1.1'],
  ])('rejects invalid gate value %s %s', async (flag, value) => {
    await expect(runCli([flag, value])).rejects.toThrow(flag)
  })

  test('returns one failed gate per breached limit and passes satisfied gates', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-gates-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, 'python-tool | Python execution helper. | /x/SKILL.md\n')
    writeFileSync(scenarioFile, JSON.stringify({
      scenarios: [{
        id: 'G',
        terms: ['python'],
        expectAny: ['python-tool'],
        rejectAny: ['wrong-python'],
      }],
    }))
    try {
      const failed = await runCli([
        '--index', index,
        '--scenarios', scenarioFile,
        '--max-avg-selection', '0',
        '--max-noise', '0',
        '--min-pass', '1',
      ])
      expect(failed.gates.map((gate: [string]) => gate[0])).toEqual(['max-avg-selection'])
      const passed = await runCli([
        '--index', index,
        '--scenarios', scenarioFile,
        '--max-avg-selection', '2',
        '--max-noise', '1',
        '--min-pass', '1',
      ])
      expect(passed.gates).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports child-process gate failures, success, and usage errors', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-process-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, [
      'python-tool | Python execution helper. | /x/SKILL.md',
      'wrong-python | Python execution helper. | /y/SKILL.md',
    ].join('\n') + '\n')
    writeFileSync(scenarioFile, JSON.stringify({
      scenarios: [{ id: 'P', terms: ['python'], expectAny: ['python-tool'], rejectAny: ['wrong-python'] }],
    }))
    const script = path.join(here, '..', 'scripts', 'skill-eval.mjs')
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    try {
      const failed = run(['--index', index, '--scenarios', scenarioFile, '--max-noise', '0.5'])
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain('skill-eval: gate failed: max-noise 1.000 vs 0.500')
      const passed = run(['--index', index, '--scenarios', scenarioFile, '--min-pass', '1'])
      expect(passed.status).toBe(0)
      const invalid = run(['--min-pass', 'NaN'])
      expect(invalid.status).not.toBe(0)
      expect(invalid.stderr).toContain('--min-pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reports the per-facet gate and report sections in a child process', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-eval-facet-gate-'))
    const index = path.join(dir, 'INDEX.md')
    const scenarioFile = path.join(dir, 'scenarios.json')
    writeFileSync(index, 'alpha-skill | Alpha workflow. | /a/SKILL.md\n')
    writeFileSync(scenarioFile, JSON.stringify({ scenarios: [{
      id: 'P-FACET', terms: [{ name: 'alpha', terms: ['alpha'], expectAny: ['missing'] }],
    }] }))
    const script = path.join(here, '..', 'scripts', 'skill-eval.mjs')
    try {
      const run = spawnSync(process.execPath, [script, '--index', index, '--scenarios', scenarioFile, '--min-facet-coverage', '0.85'], { encoding: 'utf8' })
      expect(run.status).toBe(1)
      expect(run.stdout).toContain('Per-facet coverage: 0/1 (0.0%)')
      expect(run.stdout).toContain('## Facet detail')
      expect(run.stderr).toContain('skill-eval: gate failed: min-facet-coverage')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    const entryNames = new Set(entries.map((entry: { name: string }) => entry.name))
    for (const scenario of scenarios500) {
      for (const rejected of scenario.rejectAny ?? []) {
        expect(entryNames.has(rejected), `${scenario.id} missing rejected skill ${rejected}`).toBe(true)
      }
    }
    const failed = results.filter((r: { pass: boolean }) => !r.pass)
    // Surface which scenarios failed for a readable assertion message.
    expect(failed.map((r: { id: string }) => r.id), 'failing scenario ids').toEqual([])
    expect(passed).toBe(total)
  })
})
