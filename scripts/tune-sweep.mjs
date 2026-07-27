// Sweep the remaining retrieval tuning constant against every maintained scenario suite.
//
// Usage:
//   node scripts/tune-sweep.mjs [--index <file>] --out <file>

import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCatalog } from './build-skills-index.mjs'
import {
  DEFAULT_TOKEN_BUDGET,
  DISTILL_TOKENS_CAP,
  PARTIAL_FACTOR,
  selectSkills,
} from './skill-match.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(here, '..')
const PARTIAL_FACTORS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]
const MIN_INDEX_ENTRIES = 600
const MIN_ECC_ENTRIES = 250
const SCENARIO_SUITES = [
  { key: 'gate', label: '32-case', file: 'tests/fixtures/skill-scenarios.json' },
  { key: 'cases100', label: '100-case', file: 'tests/fixtures/scenarios-100.json' },
  { key: 'multifacet', label: 'multifacet', file: 'tests/fixtures/scenarios-multifacet.json' },
]

const defaultIndex = () => path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

export function parseCliArgs(argv) {
  let parsed = { indexFile: null, outFile: null }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag !== '--index' && flag !== '--out') throw new Error(`unknown argument: ${flag}`)

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file`)
    const key = flag === '--index' ? 'indexFile' : 'outFile'
    if (parsed[key] !== null) throw new Error(`${flag} may only be specified once`)
    parsed = { ...parsed, [key]: value }
    index++
  }
  if (!parsed.outFile) throw new Error('--out requires a file')
  return parsed
}

async function assertReadableFile(file, label) {
  let stat
  try {
    stat = await fs.stat(file)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} is not readable: ${file} (${message})`)
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`)
}

function validateTerms(terms, location) {
  if (!Array.isArray(terms)) throw new Error(`${location}.terms must be an array`)
  if (terms.length === 0) return
  const isFlat = terms.every((term) => typeof term === 'string' && term.trim())
  const isFaceted = terms.every(
    (facet) =>
      facet &&
      typeof facet === 'object' &&
      typeof facet.name === 'string' &&
      facet.name.trim() &&
      Array.isArray(facet.terms) &&
      facet.terms.length > 0 &&
      facet.terms.every((term) => typeof term === 'string' && term.trim()),
  )
  if (!isFlat && !isFaceted) throw new Error(`${location}.terms has an invalid shape`)
}

function validateScenario(scenario, location) {
  if (!scenario || typeof scenario !== 'object') throw new Error(`${location} must be an object`)
  if (typeof scenario.id !== 'string' || !scenario.id.trim()) {
    throw new Error(`${location}.id must be a non-empty string`)
  }
  validateTerms(scenario.terms, location)
  if (scenario.terms.length === 0 && scenario.expectEmpty !== true) {
    throw new Error(`${location}.terms may only be empty when expectEmpty is true`)
  }
  for (const key of ['expectAny', 'expectNone']) {
    if (scenario[key] === undefined) continue
    if (!Array.isArray(scenario[key]) || !scenario[key].every((name) => typeof name === 'string')) {
      throw new Error(`${location}.${key} must be an array of strings`)
    }
  }
  if (scenario.expectEmpty !== undefined && typeof scenario.expectEmpty !== 'boolean') {
    throw new Error(`${location}.expectEmpty must be a boolean`)
  }
}

async function loadScenarioSuite(definition) {
  const file = path.resolve(projectRoot, definition.file)
  await assertReadableFile(file, `${definition.label} scenario file`)
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid JSON in ${definition.label} scenario file: ${message}`)
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(`${definition.label} scenario file contains no scenarios: ${file}`)
  }
  parsed.scenarios.forEach((scenario, index) =>
    validateScenario(scenario, `${definition.label} scenario ${index + 1}`),
  )
  return { ...definition, file, scenarios: parsed.scenarios }
}

function validateIndex(content, entries, indexFile) {
  const lines = content.split(/\r?\n/)
  const physicalLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines
  const nonHeadingLines = physicalLines.filter((line) => !line.startsWith('#')).length
  const eccEntries = content.split('plugins/cache/ecc').length - 1
  if (entries.length < MIN_INDEX_ENTRIES || eccEntries < MIN_ECC_ENTRIES) {
    throw new Error(
      `index appears degraded: parsed ${entries.length} entries from ${nonHeadingLines} non-heading lines ` +
        `with ${eccEntries} plugins/cache/ecc entries; expected at least ${MIN_INDEX_ENTRIES} and ` +
        `${MIN_ECC_ENTRIES}, respectively (${indexFile})`,
    )
  }
  if (entries.some((entry) => !entry.name || !entry.description || !entry.file)) {
    throw new Error(`index contains an incomplete catalog entry: ${indexFile}`)
  }
  return { nonHeadingLines, eccEntries }
}

function createTokenSizer() {
  const sizeCache = new Map()
  return (entry) => {
    if (!entry.file || /^https?:\/\//.test(entry.file)) return DISTILL_TOKENS_CAP
    if (sizeCache.has(entry.file)) return sizeCache.get(entry.file)
    let tokens = DISTILL_TOKENS_CAP
    try {
      tokens = Math.min(Math.ceil(readFileSync(entry.file, 'utf8').length / 4), DISTILL_TOKENS_CAP)
    } catch {
      // Missing catalog targets use the same conservative fallback as skill-eval.mjs.
    }
    sizeCache.set(entry.file, tokens)
    return tokens
  }
}

function evaluateScenario(scenario, entries, partialFactor, tokensOf) {
  const selected = selectSkills(entries, scenario.terms, {
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    tokensOf,
    tuning: { partialFactor },
  })
  const names = selected.map((entry) => entry.name)
  const usedTokens = selected.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0)
  const checks = [
    !scenario.expectEmpty || selected.length === 0,
    !scenario.expectAny || scenario.expectAny.some((name) => names.includes(name)),
    !scenario.expectNone || scenario.expectNone.every((name) => !names.includes(name)),
    usedTokens <= DEFAULT_TOKEN_BUDGET,
  ]
  return {
    pass: checks.every(Boolean),
    precisionAt1: scenario.expectAny ? scenario.expectAny.includes(names[0]) : null,
    selectedCount: selected.length,
  }
}

function summarizeSuite(suite, entries, partialFactor, tokensOf) {
  const results = suite.scenarios.map((scenario) =>
    evaluateScenario(scenario, entries, partialFactor, tokensOf),
  )
  const precisionResults = results.filter((result) => result.precisionAt1 !== null)
  return {
    key: suite.key,
    label: suite.label,
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    precisionPassed: precisionResults.filter((result) => result.precisionAt1).length,
    precisionTotal: precisionResults.length,
    avgSelected:
      results.reduce((sum, result) => sum + result.selectedCount, 0) / results.length,
  }
}

function combineSummaries(summaries) {
  const total = summaries.reduce((sum, summary) => sum + summary.total, 0)
  return {
    passed: summaries.reduce((sum, summary) => sum + summary.passed, 0),
    total,
    precisionPassed: summaries.reduce((sum, summary) => sum + summary.precisionPassed, 0),
    precisionTotal: summaries.reduce((sum, summary) => sum + summary.precisionTotal, 0),
    avgSelected:
      summaries.reduce((sum, summary) => sum + summary.avgSelected * summary.total, 0) / total,
  }
}

export function runSweep(suites, entries, tokensOf) {
  return PARTIAL_FACTORS.map((partialFactor) => {
    const suiteResults = suites.map((suite) =>
      summarizeSuite(suite, entries, partialFactor, tokensOf),
    )
    return { partialFactor, suiteResults, overall: combineSummaries(suiteResults) }
  })
}

const suiteResult = (measurement, key) =>
  measurement.suiteResults.find((summary) => summary.key === key)

function renderSweepTable(sweep) {
  const lines = [
    '| partialFactor | 32-case | 100-case | multifacet | precision@1 (all suites) | avg selection (all suites) |',
    '|---:|---:|---:|---:|---:|---:|',
  ]
  for (const measurement of sweep) {
    const gate = suiteResult(measurement, 'gate')
    const cases100 = suiteResult(measurement, 'cases100')
    const multifacet = suiteResult(measurement, 'multifacet')
    const marker = gate.passed < gate.total ? '❌ ' : measurement.partialFactor === PARTIAL_FACTOR ? '★ ' : '✅ '
    lines.push(
      `| ${marker}${measurement.partialFactor} | ${gate.passed}/${gate.total} | ` +
        `${cases100.passed}/${cases100.total} | ${multifacet.passed}/${multifacet.total} | ` +
        `${measurement.overall.precisionPassed}/${measurement.overall.precisionTotal} | ` +
        `${measurement.overall.avgSelected.toFixed(2)} |`,
    )
  }
  return lines.join('\n')
}

function renderPlateauVerdict(sweep) {
  const shippedIndex = sweep.findIndex((cell) => cell.partialFactor === PARTIAL_FACTOR)
  if (shippedIndex < 0) throw new Error('shipped partialFactor is absent from the sweep')
  const shipped = sweep[shippedIndex]
  const neighbours = [sweep[shippedIndex - 1], sweep[shippedIndex + 1]].filter(Boolean)
  const gate = suiteResult(shipped, 'gate')
  const isPlateau =
    gate.passed === gate.total &&
    neighbours.every((cell) => {
      const neighbourGate = suiteResult(cell, 'gate')
      return (
        neighbourGate.passed === neighbourGate.total &&
        Math.abs(cell.overall.passed - shipped.overall.passed) <= 1
      )
    })
  const scores = neighbours
    .map((cell) => `${cell.partialFactor}=${cell.overall.passed}/${cell.overall.total}`)
    .join(', ')
  if (!isPlateau) {
    return `**Verdict: no one-dimensional plateau exists around the shipped partialFactor ${PARTIAL_FACTOR}.** Neighbours: ${scores}.`
  }
  return `**Verdict: the shipped partialFactor ${PARTIAL_FACTOR} sits inside a one-dimensional plateau; both adjacent cells pass the 32/32 gate and stay within one aggregate case.** Neighbours: ${scores}.`
}

function renderHistoricalAblation() {
  return [
    '## Historical two-factor ablation (pre-T6 recorded evidence)',
    '',
    'These values were measured before T6 and are preserved as historical evidence. They are **not**',
    'freshly measured by this run: T6 removed the IDF-aware floor clause, `RARE_DESC_IDF`, and',
    '`rareDescHit`, so the floor-only and both variants are no longer reachable.',
    '',
    '| Variant | 32-case | 100-case | multifacet | precision@1 (100-case) | avg selection (100-case) |',
    '|---|---:|---:|---:|---:|---:|',
    '| neither fix | 32/32 | 87/100 | 4/4 | 78/99 (78.8%) | 2.59 |',
    '| IDF floor only | 32/32 | 91/100 | 4/4 | 78/99 (78.8%) | 3.28 |',
    '| phrase fallback only | 32/32 | 99/100 | 4/4 | 84/99 (84.8%) | 8.01 |',
    '| both | 32/32 | 99/100 | 4/4 | 84/99 (84.8%) | 8.57 |',
    '',
    'The matrix measured zero marginal passes from the floor over phrase fallback, at +0.56 average',
    'selection size. That dominated result is why T6 removed the clause and why the live sweep now',
    'has only one axis.',
  ].join('\n')
}

export function renderReport({ indexFile, indexMeta, entries, suites, sweep }) {
  return [
    '# PARTIAL_FACTOR one-dimensional sweep',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Index: \`${indexFile}\` (${entries.length} parsed entries)`,
    `- Integrity check: ${indexMeta.nonHeadingLines} non-heading lines; ` +
      `${indexMeta.eccEntries} \`plugins/cache/ecc\` entries`,
    `- Suites: ${suites.map((suite) => `${suite.label} (${suite.scenarios.length})`).join(', ')}`,
    `- Shipped value: \`partialFactor=${PARTIAL_FACTOR}\` (★)`,
    '',
    'The live sweep is one-dimensional because T6 removed the IDF-aware floor after its measured',
    'ablation contributed zero marginal passes and increased average selection size.',
    '',
    '## Seven-cell sweep',
    '',
    'Every row reports all three suite pass counts plus aggregate precision@1 and average selection',
    'size. A ❌ marks any row below the mandatory 32/32 gate regardless of its other metrics.',
    '',
    renderSweepTable(sweep),
    '',
    renderPlateauVerdict(sweep),
    '',
    renderHistoricalAblation(),
    '',
    '## Method',
    '',
    'The index was read and parsed once, then the same entry array and cached SKILL.md token sizer',
    'were reused for all seven sweep cells. Pass checks, precision@1, the 6,000-token budget, and',
    'the capped `ceil(file characters / 4)` sizing match `skill-eval.mjs`.',
    'The sweep is exhaustive only over the requested partialFactor values; reported results are',
    'measurements, not a claim of a global optimum.',
    '',
  ].join('\n')
}

export async function runCli(argv) {
  const { indexFile, outFile } = parseCliArgs(argv)
  const resolvedIndex = path.resolve(indexFile ?? defaultIndex())
  const resolvedOut = path.resolve(outFile)
  if (resolvedIndex === resolvedOut) throw new Error('--out must not overwrite the index')
  await assertReadableFile(resolvedIndex, 'index')

  const indexContent = await fs.readFile(resolvedIndex, 'utf8')
  const entries = parseCatalog(indexContent)
  const indexMeta = validateIndex(indexContent, entries, resolvedIndex)
  const suites = await Promise.all(SCENARIO_SUITES.map(loadScenarioSuite))
  const sweep = runSweep(suites, entries, createTokenSizer())
  const report = renderReport({ indexFile: resolvedIndex, indexMeta, entries, suites, sweep })
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true })
  await fs.writeFile(resolvedOut, report, 'utf8')
  return { report, outFile: resolvedOut }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then(({ report, outFile }) => {
      console.log(report)
      console.error(`Sweep written → ${outFile}`)
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`tune-sweep: ${message}`)
      process.exitCode = 2
    })
}
