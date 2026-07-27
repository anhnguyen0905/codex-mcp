// Runs the skill-selection scope scenarios against a skill index and evaluates
// whether the retrieval core surfaces the right skills within the ≤3 budget.
//
// Usage:
//   node scripts/skill-eval.mjs [--index <file>] [--scenarios <file>] [--report <file>]
//     [--negatives <file>]
//
// Defaults: index = ~/.claude/skill-library/INDEX.md,
//           scenarios = tests/fixtures/skill-scenarios.json,
//           report = printed to stdout (also --report <file> to write markdown).

import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCatalog } from './build-skills-index.mjs'
import { selectSkills, DEFAULT_TOKEN_BUDGET, DISTILL_TOKENS_CAP } from './skill-match.mjs'

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

// Estimate a skill's context cost from its real SKILL.md (~4 chars/token); remote
// URL entries (not yet local) fall back to the matcher's per-skill estimate.
const sizeCache = new Map()
function tokensOf(entry) {
  if (!entry.file || /^https?:\/\//.test(entry.file)) return DISTILL_TOKENS_CAP
  if (sizeCache.has(entry.file)) return sizeCache.get(entry.file)
  let tokens = DISTILL_TOKENS_CAP
  try {
    // Cost = the distilled block Claude embeds, capped — not the whole SKILL.md.
    tokens = Math.min(Math.ceil(readFileSync(entry.file, 'utf8').length / 4), DISTILL_TOKENS_CAP)
  } catch {
    /* keep fallback */
  }
  sizeCache.set(entry.file, tokens)
  return tokens
}

/** Evaluate one scenario against the parsed index entries. Returns a verdict object. */
export function evaluateScenario(scenario, entries, options = {}) {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const sizer = options.tokensOf ?? tokensOf
  const selected = selectSkills(entries, scenario.terms, { tokenBudget, tokensOf: sizer })
  const names = selected.map((s) => s.name)
  const usedTokens = selected.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
  const precisionAt1 = scenario.expectAny ? scenario.expectAny.includes(names[0]) : null
  const checks = []

  if (scenario.expectEmpty) {
    checks.push({ kind: 'empty', pass: selected.length === 0 })
  }
  if (scenario.expectAny) {
    const hit = scenario.expectAny.some((n) => names.includes(n))
    checks.push({ kind: 'any', pass: hit, wanted: scenario.expectAny })
  }
  if (scenario.expectNone) {
    const leaked = scenario.expectNone.filter((n) => names.includes(n))
    checks.push({ kind: 'none', pass: leaked.length === 0, leaked })
  }
  // Context-budget invariant always holds.
  checks.push({ kind: 'budget', pass: usedTokens <= tokenBudget })

  return {
    id: scenario.id,
    scope: scenario.scope,
    facet: scenario.facet,
    request: scenario.request,
    selected: names,
    scores: selected.map((s) => s.score),
    usedTokens,
    tokenBudget,
    precisionAt1,
    pass: checks.every((c) => c.pass),
    checks,
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
  return {
    results,
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    precisionAt1,
    avgSelected,
  }
}

function renderHeader({ results, passed, total, precisionAt1, avgSelected }, meta) {
  const pct = total ? ((passed / total) * 100).toFixed(1) : '0.0'
  const precisionPassed = results.filter((result) => result.precisionAt1 === true).length
  const precisionTotal = results.filter((result) => result.precisionAt1 !== null).length
  const precisionPct = precisionAt1 === null ? 'n/a' : `${(precisionAt1 * 100).toFixed(1)}%`
  const precisionSummary = precisionTotal
    ? `${precisionPassed}/${precisionTotal} (${precisionPct})`
    : 'n/a (no expectAny scenarios)'

  return [
    '# Skill Selection — Scope Scenario Eval Report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Index: \`${meta.index}\` (${meta.indexCount} skills)`,
    `- Scenarios: ${total}`,
    `- Context budget per scenario: ~${DEFAULT_TOKEN_BUDGET.toLocaleString()} tokens (≈3% of a 200k window)`,
    `- **Passed: ${passed}/${total} (${pct}%)**`,
    `- **Precision@1: ${precisionSummary}**`,
    `- **Average selection size: ${avgSelected.toFixed(2)}**`,
    '',
  ]
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
      `| ${r.id} | ${r.scope} | ${r.facet} | ${sel} | ${r.usedTokens.toLocaleString()} | ${r.pass ? '✅ PASS' : '❌ FAIL'} |`,
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
    '- **Per-facet selection for multi-facet requests** — the mechanical run scores one combined',
    '  term list, so a strong facet can crowd out a weak one (see S31: only the marketing skill',
    '  surfaces from a combined list; the skill instructs the model to select per-facet instead).',
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
        `- ❌ \`${violation.term}\`: \`${violation.actualTop1}\` ranked top-1 (forbidden: \`${violation.forbiddenTop1}\`).`,
    ),
  ]
}

function renderReport(summary, meta, negativeViolations = null) {
  return [
    ...renderHeader(summary, meta),
    ...renderResults(summary.results),
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

function parseCliArgs(argv) {
  let parsed = { indexFile: null, scenariosFile: null, reportFile: null, negativesFile: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const key = CLI_FILE_FLAGS.get(flag)
    if (!key) throw new Error(`unknown argument: ${flag}`)

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file`)
    parsed = { ...parsed, [key]: value }
    index++
  }
  return parsed
}

export async function runCli(argv) {
  const { indexFile, scenariosFile, reportFile, negativesFile } = parseCliArgs(argv)
  const idx = path.resolve(indexFile ?? defaultIndex())
  const scen = path.resolve(scenariosFile ?? defaultScenarios())
  const entries = parseCatalog(await fs.readFile(idx, 'utf8'))
  const { scenarios } = JSON.parse(await fs.readFile(scen, 'utf8'))

  const summary = runScenarios(scenarios, entries)
  let negativeViolations = null
  if (negativesFile) {
    const negativesPath = path.resolve(negativesFile)
    const negativeRules = parseNegatives(await fs.readFile(negativesPath, 'utf8'))
    if (!negativeRules.length) throw new Error(`negatives file contains no rules: ${negativesPath}`)
    negativeViolations = checkNegatives(negativeRules, entries)
  }
  const report = renderReport(summary, { index: idx, indexCount: entries.length }, negativeViolations)

  if (reportFile) {
    const out = path.resolve(reportFile)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, report, 'utf8')
  }
  return { ...summary, negativeViolations, report, reportFile }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then(({ report, passed, total, negativeViolations, reportFile }) => {
      console.log(report)
      if (reportFile) console.error(`Report written → ${path.resolve(reportFile)}`)
      const hasNegativeViolations = (negativeViolations?.length ?? 0) > 0
      process.exit(passed === total && !hasNegativeViolations ? 0 : 1)
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`skill-eval: ${message}`)
      process.exit(2)
    })
}
