// Runs the skill-selection scope scenarios against a skill index and evaluates
// whether the retrieval core surfaces the right skills within the ≤3 budget.
//
// Usage:
//   node scripts/skill-eval.mjs [--index <file>] [--scenarios <file>] [--report <file>]
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
    pass: checks.every((c) => c.pass),
    checks,
  }
}

/** Run all scenarios; returns { results, passed, total }. */
export function runScenarios(scenarios, entries, options = {}) {
  const results = scenarios.map((s) => evaluateScenario(s, entries, options))
  return { results, passed: results.filter((r) => r.pass).length, total: results.length }
}

function renderReport({ results, passed, total }, meta) {
  const pct = ((passed / total) * 100).toFixed(1)
  const lines = [
    '# Skill Selection — Scope Scenario Eval Report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Index: \`${meta.index}\` (${meta.indexCount} skills)`,
    `- Scenarios: ${total}`,
    `- Context budget per scenario: ~${DEFAULT_TOKEN_BUDGET.toLocaleString()} tokens (≈3% of a 200k window)`,
    `- **Passed: ${passed}/${total} (${pct}%)**`,
    '',
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

  lines.push(
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
  )

  const failures = results.filter((r) => !r.pass)
  if (failures.length) {
    lines.push('', '## Failure detail', '')
    for (const f of failures) {
      const bad = f.checks.filter((c) => !c.pass)
      lines.push(`- **${f.id}** (${f.scope}) — request: "${f.request}"`)
      lines.push(`  - selected: ${f.selected.join(', ') || '(none)'}`)
      for (const c of bad) {
        if (c.kind === 'any') lines.push(`  - expected any of: ${c.wanted.join(', ')}`)
        if (c.kind === 'none') lines.push(`  - leaked (should be absent): ${c.leaked.join(', ')}`)
        if (c.kind === 'empty') lines.push('  - expected empty selection (uncovered domain)')
        if (c.kind === 'budget') lines.push(`  - context budget exceeded (${f.usedTokens} > ${f.tokenBudget})`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

export async function runCli(argv) {
  let indexFile = null
  let scenariosFile = null
  let reportFile = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--index') indexFile = argv[++i]
    else if (a === '--scenarios') scenariosFile = argv[++i]
    else if (a === '--report') reportFile = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }

  const idx = path.resolve(indexFile ?? defaultIndex())
  const scen = path.resolve(scenariosFile ?? defaultScenarios())
  const entries = parseCatalog(await fs.readFile(idx, 'utf8'))
  const { scenarios } = JSON.parse(await fs.readFile(scen, 'utf8'))

  const summary = runScenarios(scenarios, entries)
  const report = renderReport(summary, { index: idx, indexCount: entries.length })

  if (reportFile) {
    const out = path.resolve(reportFile)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, report, 'utf8')
  }
  return { ...summary, report, reportFile }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then(({ report, passed, total, reportFile }) => {
      console.log(report)
      if (reportFile) console.error(`Report written → ${path.resolve(reportFile)}`)
      process.exit(passed === total ? 0 : 1)
    })
    .catch((error) => {
      console.error(`skill-eval: ${error.message}`)
      process.exit(2)
    })
}
