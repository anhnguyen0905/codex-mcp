// Runs the skill-selection scope scenarios against a skill index and evaluates
// whether the retrieval core surfaces the right skills within the ≤3 budget.
//
// Usage:
//   node scripts/skill-eval.mjs [--index <file>] [--scenarios <file>] [--report <file>]
//     [--negatives <file>] [--max-avg-selection <number>] [--max-noise <ratio>]
//     [--min-pass <ratio>]
//
// Defaults: index = ~/.claude/skill-library/INDEX.md,
//           scenarios = tests/fixtures/skill-scenarios.json,
//           report = printed to stdout (also --report <file> to write markdown).

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCatalog } from './build-skills-index.mjs'
import {
  deriveTerms,
  selectSkills,
  DEFAULT_TOKEN_BUDGET,
} from './skill-match.mjs'
export { tokensOf } from './skill-tokens.mjs'
import { tokensOf } from './skill-tokens.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultIndex = () => path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')
const defaultScenarios = () => path.join(here, '..', 'tests', 'fixtures', 'skill-scenarios.json')

/** Parse `<term> | <forbidden-top-1-skill>` precision guard rules. */
export function parseNegatives(content) {
  if (typeof content !== 'string') {
    throw new TypeError('negative rules content must be a string')
  }

  return content.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return []

    const fields = trimmed.split('|').map((field) => field.trim())
    if (fields.length !== 2 || fields.some((field) => !field)) {
      throw new Error(`invalid negative rule on line ${index + 1}: expected "<term> | <skill>"`)
    }
    return [{ term: fields[0], forbiddenTop1: fields[1] }]
  })
}

/** Return only rules whose forbidden skill is selected at rank 1. */
export function checkNegatives(rules, entries, options = {}) {
  if (!Array.isArray(rules)) throw new TypeError('negative rules must be an array')
  if (!Array.isArray(entries)) throw new TypeError('skill entries must be an array')
  const entryNames = new Set(entries.map((entry) => entry.name))

  return rules.flatMap((rule, index) => {
    const isValidRule = Boolean(
      rule &&
      typeof rule.term === 'string' &&
      rule.term.trim() &&
      typeof rule.forbiddenTop1 === 'string' &&
      rule.forbiddenTop1.trim(),
    )
    if (!isValidRule) {
      throw new TypeError(`negative rule ${index + 1} must have non-empty string fields`)
    }
    if (!entryNames.has(rule.forbiddenTop1)) {
      throw new Error(
        `negative rule ${index + 1} ("${rule.term}") names skill not present in catalog: "${rule.forbiddenTop1}"`,
      )
    }

    const selected = selectSkills(entries, [rule.term], options)
    const actualTop1 = selected[0]?.name
    if (!actualTop1 || actualTop1 !== rule.forbiddenTop1) return []
    return [{ term: rule.term, forbiddenTop1: rule.forbiddenTop1, actualTop1 }]
  })
}

/** Evaluate one scenario against the parsed index entries. Returns a verdict object. */
export function evaluateScenario(scenario, entries, options = {}) {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const sizer = options.tokensOf ?? tokensOf
  const terms = options.raw ? deriveTerms(scenario.request ?? '') : scenario.terms
  const selected = selectSkills(
    entries,
    options.raw ? [{ name: 'request', terms }] : terms,
    { tokenBudget, tokensOf: sizer },
  )
  const names = selected.map((s) => s.name)
  const usedTokens = selected.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  const precisionAt1 = scenario.expectAny ? scenario.expectAny.includes(names[0]) : null
  const firstHit = scenario.expectAny
    ? names.findIndex((name) => scenario.expectAny.includes(name))
    : -1
  const reciprocalRank = scenario.expectAny ? (firstHit >= 0 ? 1 / (firstHit + 1) : 0) : null
  const noise = scenario.rejectAny
    ? names.filter((name) => scenario.rejectAny.includes(name))
    : null
  const top3Hit = scenario.expectAny
    ? scenario.expectAny.some((name) => names.slice(0, 3).includes(name))
    : null
  const checks = []
  const isFacetScenario = !options.raw && Array.isArray(scenario.terms)
    && scenario.terms.every(
      (term) => term && typeof term === 'object' && Array.isArray(term.terms),
    )
  const facetCoverage = isFacetScenario
    ? scenario.terms.map((facet) => ({
      facet: facet.name,
      expected: Array.isArray(facet.expectAny),
      // `covered` is global by design; `selected` shows the facet attribution.
      covered: Array.isArray(facet.expectAny)
        ? facet.expectAny.some((name) => names.includes(name))
        : null,
      selected: selected.filter((entry) => entry.facet === facet.name).map((entry) => entry.name),
    }))
    : null

  if (scenario.expectEmpty) {
    checks.push({ kind: 'empty', pass: selected.length === 0 })
  }
  if (scenario.expectAny) {
    const hit = scenario.expectAny.some((n) => names.includes(n))
    checks.push({ kind: 'any', pass: hit, wanted: scenario.expectAny })
  }
  for (const coverage of facetCoverage ?? []) {
    if (coverage.expected && !coverage.covered) {
      checks.push({ kind: 'facet', facet: coverage.facet, pass: false })
    }
  }
  let fpViolated = null
  if (scenario.expectNone) {
    const leaked = scenario.expectNone.filter((n) => names.includes(n))
    fpViolated = leaked.length > 0
    checks.push({ kind: 'none', pass: leaked.length === 0, leaked })
  }
  // Context-budget invariant always holds.
  checks.push({ kind: 'budget', pass: usedTokens <= tokenBudget })

  return {
    id: scenario.id,
    scope: scenario.scope,
    facet: scenario.facet,
    request: scenario.request,
    terms,
    selected: names,
    scores: selected.map((s) => s.score),
    usedTokens,
    tokenBudget,
    precisionAt1,
    reciprocalRank,
    noise,
    top3Hit,
    fpViolated,
    pass: checks.every((c) => c.pass),
    checks,
    facetCoverage,
  }
}

/** Run all scenarios and aggregate verdict, precision@1, and selection-size metrics. */
export function runScenarios(scenarios, entries, options = {}) {
  const results = scenarios.map((s) => evaluateScenario(s, entries, options))
  const measuredPrecision = results.filter((result) => result.precisionAt1 !== null)
  const precisionAt1 = measuredPrecision.length
    ? measuredPrecision.filter((result) => result.precisionAt1).length / measuredPrecision.length
    : null
  const avgSelected = results.length
    ? results.reduce((sum, result) => sum + result.selected.length, 0) / results.length
    : 0
  // MRR over expectAny scenarios: reciprocal rank of the first expected skill
  // in the selection (0 on a miss) — exposes ranking quality that pass counts hide.
  const ranked = results.filter((result) => result.reciprocalRank !== null)
  const mrr = ranked.length
    ? ranked.reduce((sum, result) => sum + result.reciprocalRank, 0) / ranked.length
    : null
  // Per-scope recall: pass counts grouped by scenario scope, so a weak domain
  // cannot hide inside a strong aggregate.
  const perScope = results.reduce((acc, result) => {
    const scope = result.scope ?? 'unscoped'
    const bucket = acc[scope] ?? { passed: 0, total: 0 }
    return {
      ...acc,
      [scope]: { passed: bucket.passed + (result.pass ? 1 : 0), total: bucket.total + 1 },
    }
  }, {})
  // False-positive rate over expectNone scenarios (null when none carry one).
  const guarded = results.filter((result) => result.fpViolated !== null)
  const fpRate = guarded.length
    ? guarded.filter((result) => result.fpViolated).length / guarded.length
    : null
  const noiseScenarios = results.filter((result) => result.noise !== null)
  const noisyScenarios = noiseScenarios.filter((result) => result.noise.length > 0)
  const labelledSelections = noiseScenarios.reduce((sum, result) => sum + result.selected.length, 0)
  const noisySelections = noiseScenarios.reduce((sum, result) => sum + result.noise.length, 0)
  const top3Measured = results.filter((result) => result.top3Hit !== null)
  const facetChecks = results
    .flatMap((result) => result.facetCoverage ?? [])
    .filter((facet) => facet.expected)
  const facetCovered = facetChecks.filter((facet) => facet.covered).length
  return {
    results,
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    precisionAt1,
    avgSelected,
    mrr,
    perScope,
    fpRate,
    noiseRate: noiseScenarios.length ? noisyScenarios.length / noiseScenarios.length : null,
    noisySkillShare: labelledSelections ? noisySelections / labelledSelections : null,
    noiseNumerator: noisyScenarios.length,
    noiseDenominator: noiseScenarios.length,
    noisySelectionNumerator: noisySelections,
    noisySelectionDenominator: labelledSelections,
    top3HitRate: top3Measured.length
      ? top3Measured.filter((result) => result.top3Hit).length / top3Measured.length
      : null,
    top3HitNumerator: top3Measured.filter((result) => result.top3Hit).length,
    top3HitDenominator: top3Measured.length,
    facetCoverageRate: facetChecks.length ? facetCovered / facetChecks.length : null,
    facetCoverageNumerator: facetCovered,
    facetCoverageDenominator: facetChecks.length,
  }
}

function renderHeader(summary, meta) {
  const { results, passed, total, precisionAt1, avgSelected, mrr, fpRate } = summary
  const pct = total ? ((passed / total) * 100).toFixed(1) : '0.0'
  const precisionPassed = results.filter((result) => result.precisionAt1 === true).length
  const precisionTotal = results.filter((result) => result.precisionAt1 !== null).length
  const precisionPct = precisionAt1 === null ? 'n/a' : `${(precisionAt1 * 100).toFixed(1)}%`
  const precisionSummary = precisionTotal
    ? `${precisionPassed}/${precisionTotal} (${precisionPct})`
    : 'n/a (no expectAny scenarios)'

  const guardedTotal = results.filter((result) => result.fpViolated !== null).length
  const fpSummary = fpRate === null
    ? 'n/a (no expectNone scenarios)'
    : `${Math.round(fpRate * guardedTotal)}/${guardedTotal} (${(fpRate * 100).toFixed(1)}%)`
  const top3Summary = summary.top3HitRate === null
    ? 'n/a'
    : `${summary.top3HitNumerator}/${summary.top3HitDenominator} (${(summary.top3HitRate * 100).toFixed(1)}%)`
  const noiseSummary = summary.noiseRate === null
    ? 'n/a (no rejectAny labels)'
    : `${summary.noiseNumerator}/${summary.noiseDenominator} (${(summary.noiseRate * 100).toFixed(1)}%)`
  const noisySummary = summary.noisySkillShare === null
    ? 'n/a (no rejectAny labels)'
    : `${summary.noisySelectionNumerator}/${summary.noisySelectionDenominator}`
      + ` (${(summary.noisySkillShare * 100).toFixed(1)}%)`

  return [
    '# Skill Selection — Scope Scenario Eval Report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Index: \`${meta.index}\` (${meta.indexCount} skills)`,
    ...(meta.indexSha256 ? [`- Index sha256: \`${meta.indexSha256}\``] : []),
    `- Scenarios: ${total}`,
    `- Terms: ${meta.raw ? 'raw (derived from request)' : 'oracle'}`,
    `- Context budget per scenario: ~${DEFAULT_TOKEN_BUDGET.toLocaleString()} tokens (≈3% of a 200k window)`,
    `- **Passed: ${passed}/${total} (${pct}%)**`,
    `- **Precision@1 (Hit@1): ${precisionSummary}**`,
    `- **MRR: ${mrr === null ? 'n/a' : mrr.toFixed(3)}**`,
    `- **expectNone FP rate: ${fpSummary}**`,
    `- **Average selection size: ${avgSelected.toFixed(2)}**`,
    `- **Top-3 hit rate: ${top3Summary}**`,
    `- **Per-facet coverage: ${formatFacetCoverage(summary)}**`,
    `- **Noise rate: ${noiseSummary}** (scenarios selecting a rejected skill)`,
    `- **Noisy selections: ${noisySummary}**`,
    '',
  ]
}

function formatFacetCoverage(summary) {
  if (summary.facetCoverageRate === null) return 'n/a (no facet expectations)'
  return `${summary.facetCoverageNumerator}/${summary.facetCoverageDenominator}`
    + ` (${(summary.facetCoverageRate * 100).toFixed(1)}%)`
}

function renderNoiseDetail(results) {
  const noisy = results.filter((result) => result.noise?.length)
  if (!noisy.length) return []
  return [
    '## Noise detail', '',
    ...noisy.flatMap((result) => [
      `- **${result.id}** — request: "${result.request}"; noisy skills: ${result.noise.join(', ')}`,
    ]),
    '',
  ]
}

function renderPerScope(perScope) {
  const scopes = Object.keys(perScope ?? {})
  if (scopes.length < 2) return []
  const lines = ['## Per-scope recall', '', '| Scope | Passed | Recall |', '|---|---|---|']
  for (const scope of scopes.sort()) {
    const { passed, total } = perScope[scope]
    lines.push(`| ${scope} | ${passed}/${total} | ${((passed / total) * 100).toFixed(1)}% |`)
  }
  return [...lines, '']
}

/** List expected facets whose own picks miss every wanted skill, and whether another facet covered them. */
function renderFacetDetail(results) {
  const lines = results.flatMap((result) => (result.facetCoverage ?? []).flatMap((facet) => {
    if (!facet.expected) return []
    const wantedNames = result.terms.find((term) => term.name === facet.facet).expectAny
    if (facet.selected.some((name) => wantedNames.includes(name))) return []
    const own = facet.selected.join(', ') || '(none)'
    const elsewhere = wantedNames.some((name) => result.selected.includes(name))
    return [
      `- **${result.id} / ${facet.facet}** — wanted: ${wantedNames.join(', ')}; own picks: ${own}; `
        + `covered under another facet: ${elsewhere ? 'yes' : 'no'}`,
    ]
  }))
  return lines.length ? ['', '## Facet detail', '', ...lines, ''] : []
}

function renderResults(results) {
  const lines = [
    '## Results',
    '',
    '| # | Scope | Facet | Selected skills (relevance-ranked) | ~Tokens | Verdict |',
    '|---|-------|-------|-------------------------------------|---------|---------|',
  ]
  for (const r of results) {
    const sel = r.selected.length ? r.selected.join(', ') : '_(none)_'
    lines.push(
      `| ${r.id} | ${r.scope} | ${r.facet} | ${sel} | `
        + `${r.usedTokens.toLocaleString()} | ${r.pass ? '✅ PASS' : '❌ FAIL'} |`,
    )
  }
  return lines
}

function renderMethod() {
  return [
    '',
    '## Method & scope of this eval',
    '',
    'This harness tests the **deterministic retrieval core** of skill-selection',
    '(`scripts/skill-match.mjs`, Steps 4–5 of the skill): given the search terms a role facet',
    'produces, does the index surface the right skill(s) within the context budget (~3% of a 200k',
    'window, sized from each skill\'s real SKILL.md), and stay empty for uncovered domains? Selection',
    'is bounded by that token budget, not a fixed skill count. Each scenario supplies the `terms` a',
    'competent classifier would derive, then asserts on the selected set (`expectAny` / `expectNone`',
    '/ `expectEmpty`).',
    '',
    'What it does **not** test (these are LLM-judgment steps, verified in review, not unit tests):',
    '',
    '- **Step 2 role classification** — turning a free-text request into facets + terms.',
    '- **Per-facet selection for multi-facet requests** — Hit@1, MRR, and top-3 remain whole-scenario',
    '  comparators; per-facet coverage is the meaningful metric for multi-facet scenarios.',
    '- **Step 5 vetting and distillation** of skill content into Codex prompt blocks.',
    '',
  ]
}

function renderFailures(results) {
  const failures = results.filter((r) => !r.pass)
  if (!failures.length) return []

  const lines = ['', '## Failure detail', '']
  for (const failure of failures) {
    const failedChecks = failure.checks.filter((check) => !check.pass)
    lines.push(`- **${failure.id}** (${failure.scope}) — request: "${failure.request}"`)
    lines.push(`  - selected: ${failure.selected.join(', ') || '(none)'}`)
    for (const check of failedChecks) {
      if (check.kind === 'any') lines.push(`  - expected any of: ${check.wanted.join(', ')}`)
      if (check.kind === 'none') lines.push(`  - leaked (should be absent): ${check.leaked.join(', ')}`)
      if (check.kind === 'empty') lines.push('  - expected empty selection (uncovered domain)')
      if (check.kind === 'budget') {
        lines.push(`  - context budget exceeded (${failure.usedTokens} > ${failure.tokenBudget})`)
      }
    }
  }
  return lines
}

function renderPrecisionGuard(violations) {
  if (violations === null) return []
  const lines = ['', '## Precision guard', '']
  if (!violations.length) return [...lines, '✅ Precision regression net passed.']

  return [
    ...lines,
    ...violations.map(
      (violation) =>
        `- ❌ \`${violation.term}\`: \`${violation.actualTop1}\` ranked top-1 `
          + `(forbidden: \`${violation.forbiddenTop1}\`).`,
    ),
  ]
}

export function renderReport(summary, meta, negativeViolations = null) {
  return [
    ...renderHeader(summary, meta),
    ...renderPerScope(summary.perScope),
    ...renderNoiseDetail(summary.results),
    ...renderResults(summary.results),
    ...renderFacetDetail(summary.results),
    ...renderPrecisionGuard(negativeViolations),
    ...renderMethod(),
    ...renderFailures(summary.results),
    '',
  ].join('\n')
}

const CLI_FILE_FLAGS = new Map([
  ['--index', 'indexFile'],
  ['--scenarios', 'scenariosFile'],
  ['--report', 'reportFile'],
  ['--negatives', 'negativesFile'],
])
const CLI_NUMBER_FLAGS = new Map([
  ['--max-avg-selection', 'maxAvgSelection'],
  ['--max-noise', 'maxNoise'],
  ['--min-pass', 'minPass'],
  ['--min-facet-coverage', 'minFacetCoverage'],
])

/** Validate one facet object of a multi-facet scenario. */
function validateFacet(scenario, facet) {
  const id = scenario.id ?? '<unknown>'
  const label = facet && typeof facet === 'object' ? facet.name ?? '<unknown>' : '<unknown>'
  if (!facet || typeof facet !== 'object' || Array.isArray(facet)) {
    throw new Error(`scenario ${id} facet ${label}: facet must be an object`)
  }
  if (typeof facet.name !== 'string' || !facet.name.trim()) {
    throw new Error(`scenario ${id} facet ${label}: name must be a non-empty string`)
  }
  if (!Array.isArray(facet.terms) || facet.terms.length === 0
    || facet.terms.some((term) => typeof term !== 'string' || !term.trim())) {
    throw new Error(`scenario ${id} facet ${facet.name}: terms must be a non-empty array of strings`)
  }
  if (facet.expectAny !== undefined && (
    !Array.isArray(facet.expectAny)
    || facet.expectAny.length === 0
    || facet.expectAny.some((name) => typeof name !== 'string' || !name.trim())
  )) {
    throw new Error(`scenario ${id} facet ${facet.name}: expectAny must be an array of non-empty strings`)
  }
  if (facet.rejectAny !== undefined && (
    !Array.isArray(facet.rejectAny)
    || facet.rejectAny.some((name) => typeof name !== 'string' || !name.trim())
  )) {
    throw new Error(`scenario ${id} facet ${facet.name}: rejectAny must be an array of non-empty strings`)
  }
}

/** Validate scenario fields at the file boundary. */
export function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios)) throw new Error('scenarios must be an array')
  for (const scenario of scenarios) {
    if (Array.isArray(scenario.terms) && scenario.terms.some((term) => typeof term !== 'string')) {
      for (const facet of scenario.terms) validateFacet(scenario, facet)
    }
    if (scenario.rejectAny === undefined) continue
    const invalid = !Array.isArray(scenario.rejectAny) || scenario.rejectAny.some(
      (name) => typeof name !== 'string' || !name.trim(),
    )
    if (invalid) {
      throw new Error(`scenario ${scenario.id ?? '<unknown>'}: rejectAny must be an array of non-empty strings`)
    }
    const overlap = scenario.rejectAny.find((name) => (scenario.expectAny ?? []).includes(name))
    if (overlap) {
      throw new Error(`scenario ${scenario.id ?? '<unknown>'}: rejectAny overlaps expectAny: "${overlap}"`)
    }
  }
}

function parseCliArgs(argv) {
  let parsed = {
    indexFile: null,
    scenariosFile: null,
    reportFile: null,
    negativesFile: null,
    maxAvgSelection: null,
    maxNoise: null,
    minPass: null,
    minFacetCoverage: null,
    raw: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--raw') {
      parsed = { ...parsed, raw: true }
      continue
    }
    const key = CLI_FILE_FLAGS.get(flag) ?? CLI_NUMBER_FLAGS.get(flag)
    if (!key) throw new Error(`unknown argument: ${flag}`)

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (CLI_NUMBER_FLAGS.has(flag)) {
      const number = Number(value)
      const valid = Number.isFinite(number) && (flag === '--max-avg-selection'
        ? number >= 0
        : number >= 0 && number <= 1)
      if (!valid) {
        const kind = flag === '--max-avg-selection' ? 'non-negative number' : 'ratio from 0 to 1'
        throw new Error(`${flag} requires a valid ${kind}`)
      }
      parsed = { ...parsed, [key]: number }
    } else parsed = { ...parsed, [key]: value }
    index++
  }
  return parsed
}

export async function runCli(argv) {
  const parsed = parseCliArgs(argv)
  const {
    indexFile,
    scenariosFile,
    reportFile,
    negativesFile,
    maxAvgSelection,
    maxNoise,
    minPass,
    minFacetCoverage,
    raw,
  } = parsed
  const idx = path.resolve(indexFile ?? defaultIndex())
  const scen = path.resolve(scenariosFile ?? defaultScenarios())
  const indexContent = await fs.readFile(idx, 'utf8')
  const entries = parseCatalog(indexContent)
  // Pin the exact index the numbers were measured against (dual-review IMP-D):
  // the file is mutable, so a report without its hash is not reproducible.
  const indexSha256 = createHash('sha256').update(indexContent).digest('hex')
  const { scenarios } = JSON.parse(await fs.readFile(scen, 'utf8'))
  validateScenarios(scenarios)

  const summary = runScenarios(scenarios, entries, { raw })
  let negativeViolations = null
  if (negativesFile) {
    const negativesPath = path.resolve(negativesFile)
    const negativeRules = parseNegatives(await fs.readFile(negativesPath, 'utf8'))
    if (!negativeRules.length) throw new Error(`negatives file contains no rules: ${negativesPath}`)
    negativeViolations = checkNegatives(negativeRules, entries)
  }
  const report = renderReport(
    summary,
    { index: idx, indexCount: entries.length, indexSha256, raw },
    negativeViolations,
  )

  if (reportFile) {
    const out = path.resolve(reportFile)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, report, 'utf8')
  }
  const gates = []
  if (maxAvgSelection !== null && summary.avgSelected > maxAvgSelection) {
    gates.push(['max-avg-selection', summary.avgSelected, maxAvgSelection])
  }
  if (maxNoise !== null && summary.noiseRate !== null && summary.noiseRate > maxNoise) {
    gates.push(['max-noise', summary.noiseRate, maxNoise])
  }
  if (minPass !== null && (summary.total === 0 || summary.passed / summary.total < minPass)) {
    gates.push(['min-pass', summary.total ? summary.passed / summary.total : 0, minPass])
  }
  if (
    minFacetCoverage !== null
    && (summary.facetCoverageRate === null || summary.facetCoverageRate < minFacetCoverage)
  ) {
    gates.push([
      'min-facet-coverage',
      summary.facetCoverageRate ?? 0,
      minFacetCoverage,
    ])
  }
  return { ...summary, negativeViolations, report, reportFile, gates, minPass }
}

/** Format a gate value according to the metric it represents. */
function formatGateValue(name, value) {
  return name === 'max-avg-selection' ? value.toFixed(2) : value.toFixed(3)
}

/** Return the process exit code for an evaluation summary and CLI options. */
export function exitCodeFor(summary, options = {}) {
  const hasNegativeViolations = (summary.negativeViolations?.length ?? 0) > 0
  const hasBreachedGate = (summary.gates?.length ?? 0) > 0
  const minPass = options.minPass ?? null
  const passRequirement = minPass === null
    ? summary.total > 0 && summary.passed === summary.total
    : summary.total > 0 && summary.passed / summary.total >= minPass
  return passRequirement && !hasNegativeViolations && !hasBreachedGate ? 0 : 1
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then(({ report, passed, total, negativeViolations, reportFile, gates, minPass }) => {
      console.log(report)
      if (reportFile) console.error(`Report written → ${path.resolve(reportFile)}`)
      for (const [name, actual, limit] of gates) {
        console.error(
          `skill-eval: gate failed: ${name} ${formatGateValue(name, actual)} vs ${formatGateValue(name, limit)}`,
        )
      }
      process.exit(exitCodeFor({ passed, total, negativeViolations, gates }, { minPass }))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`skill-eval: ${message}`)
      process.exit(2)
    })
}
