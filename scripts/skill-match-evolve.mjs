import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCatalog } from './build-skills-index.mjs'
import { DEFAULT_TUNING, TUNING_BOUNDS } from './skill-match.mjs'
import { runScenarios, validateScenarios } from './skill-eval.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_INDEX = path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')
const DEFAULT_DEV = ['skill-scenarios.json', 'scenarios-100.json', 'scenarios-multifacet.json', 'scenarios-vi.json']
const DEFAULT_HOLDOUT = 'scenarios-holdout.json'
const MAX_GENERATIONS = 50
const MAX_POPULATION = 64

export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function mutate(tuning, rng, bounds) {
  const keys = Object.keys(bounds)
  const count = 1 + Math.floor(rng() * Math.min(3, keys.length))
  const shuffled = [...keys]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[other]
    shuffled[other] = current
  }
  const chosen = shuffled.slice(0, count)
  return chosen.reduce((result, key) => {
    const [min, max] = bounds[key]
    const value = min + rng() * (max - min)
    return { ...result, [key]: Math.round(value * 100) / 100 }
  }, { ...tuning })
}

export function signature(results) {
  return results.map((result) => result.selected[0] ?? '').join('\u001f')
}

const metric = (summary) => ({ fitness: summary.passed, precisionAt1: summary.results.reduce((sum, result) => sum + (result.precisionAt1 ?? 0), 0) })
const canonicalTuning = (tuning) => JSON.stringify(Object.fromEntries(Object.keys(TUNING_BOUNDS).map((key) => [key, tuning[key]])))
export const compareCandidates = (a, b) => b.fitness - a.fitness || b.precisionAt1 - a.precisionAt1 || a.canonical.localeCompare(b.canonical)

export function validateTuning(tuning, bounds = TUNING_BOUNDS) {
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isFinite(tuning[key]) || tuning[key] < min || tuning[key] > max) throw new RangeError(`tuning.${key} is outside bounds`)
  }
}

function evaluateCandidate(tuning, entries, dev, holdout, seen) {
  validateTuning(tuning)
  const devSummary = runScenarios(dev, entries, { tuning })
  const candidateSignature = signature(devSummary.results)
  if (seen.has(candidateSignature)) return { duplicate: true }
  seen.add(candidateSignature)
  const holdoutSummary = runScenarios(holdout, entries, { tuning })
  return { tuning, canonical: canonicalTuning(tuning), signature: candidateSignature, ...metric(devSummary), heldOut: holdoutSummary.passed + holdoutSummary.results.reduce((sum, result) => sum + (result.precisionAt1 ?? 0), 0) }
}

export async function evolve(options) {
  const generations = options.generations
  const population = options.population
  const seed = options.seed
  if (![generations, population, seed].every(Number.isInteger) || generations < 1 || generations > MAX_GENERATIONS || population < 1 || population > MAX_POPULATION || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('generations, population, and seed are out of range')
  const indexPath = path.resolve(options.index ?? DEFAULT_INDEX)
  const entries = parseCatalog(await fs.readFile(indexPath, 'utf8'))
  const devFiles = options.dev ?? DEFAULT_DEV.map((file) => path.join(here, '..', 'tests', 'fixtures', file))
  const dev = (await Promise.all(devFiles.map(readScenarios))).flat()
  const holdout = (options.holdout ? await readScenarios(options.holdout) : await readScenarios(path.join(here, '..', 'tests', 'fixtures', DEFAULT_HOLDOUT)))
  validateScenarios(dev)
  validateScenarios(holdout)
  const rng = mulberry32(seed)
  const seen = new Set()
  const baselineDev = runScenarios(dev, entries, { tuning: DEFAULT_TUNING })
  const baselineHoldout = runScenarios(holdout, entries, { tuning: DEFAULT_TUNING })
  const baseline = { tuning: { ...DEFAULT_TUNING }, canonical: canonicalTuning(DEFAULT_TUNING), signature: signature(baselineDev.results), ...metric(baselineDev), heldOut: baselineHoldout.passed + baselineHoldout.results.reduce((sum, result) => sum + (result.precisionAt1 ?? 0), 0), baseline: true }
  seen.add(baseline.signature)
  let parents = [baseline]
  const candidates = []
  let rejectedDuplicates = 0
  let rejected = 0
  for (let generation = 1; generation <= generations; generation++) {
    const batch = []
    for (let index = 0; index < population; index++) {
      const parent = parents[Math.floor(rng() * parents.length)]
      try {
        const candidate = evaluateCandidate(mutate(parent.tuning, rng, TUNING_BOUNDS), entries, dev, holdout, seen)
        if (candidate.duplicate) rejectedDuplicates++
        else batch.push({ ...candidate, generation })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        if (!(error instanceof RangeError)) throw error
        rejected++
      }
    }
    batch.sort(compareCandidates)
    candidates.push(...batch)
    parents = [baseline, ...[...candidates].sort(compareCandidates).slice(0, Math.ceil(population / 2))]
  }
  return { seed, generations, population, baseline, candidates, rejectedDuplicates, rejected, evaluations: 1 + generations * population, recommended: recommend(baseline, candidates) }
}

export function recommend(baseline, candidates) {
  return candidates.filter((candidate) => candidate.fitness > baseline.fitness && candidate.heldOut >= baseline.heldOut)
}

async function readScenarios(file) {
  const parsed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
  return Array.isArray(parsed) ? parsed : parsed.scenarios
}

export function formatReport(report) {
  const lines = ['# Skill-match evolution', '', `seed: ${report.seed}`, `generations: ${report.generations}`, `population: ${report.population}`, `evaluations: ${report.evaluations}`, `rejectedDuplicates: ${report.rejectedDuplicates}`, `rejected: ${report.rejected}`, '', '## best measured safe variant', '', '| generation | fitness | P@1 sum | held-out | tuning |', '| ---: | ---: | ---: | ---: | --- |']
  for (const candidate of [report.baseline, ...report.candidates]) lines.push(`| ${candidate.generation ?? 0} | ${candidate.fitness} | ${candidate.precisionAt1} | ${candidate.heldOut} | ${JSON.stringify(candidate.tuning)} |`)
  lines.push('', '## recommended', '', ...report.recommended.map((candidate) => `- ${JSON.stringify(candidate.tuning)}`))
  return `${lines.join('\n')}\n`
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--json') values.json = true
    else if (flag === '--dev') { values.dev ??= []; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--dev requires a path'); values.dev.push(args[++index]) }
    else if (['--generations', '--population', '--seed', '--out', '--index', '--holdout'].includes(flag)) { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`); values[flag.slice(2)] = value }
    else throw new Error(`unknown flag: ${flag}`)
  }
  for (const name of ['generations', 'population', 'seed']) { if (values[name] === undefined) throw new Error(`missing --${name}`); if (!/^\d+$/.test(values[name])) throw new Error(`--${name} must be an integer`) ; values[name] = Number(values[name]) }
  if (!values.out) throw new Error('missing --out')
  return values
}

async function runCli(args) {
  const options = parseArgs(args)
  const output = path.resolve(options.out)
  const skillMatchPath = path.join(here, 'skill-match.mjs')
  const realSkillMatch = await fs.realpath(skillMatchPath)
  const realOutput = await resolveRealOutput(output)
  const outputStats = await statIfPresent(output)
  const skillMatchStats = await statIfPresent(skillMatchPath)
  const sameFile = path.resolve(output).toLowerCase() === path.resolve(skillMatchPath).toLowerCase()
    || realOutput.toLowerCase() === realSkillMatch.toLowerCase()
    || Boolean(outputStats && skillMatchStats && outputStats.dev === skillMatchStats.dev && outputStats.ino === skillMatchStats.ino)
  if (sameFile) throw new Error('--out cannot overwrite scripts/skill-match.mjs')
  const report = await evolve(options)
  const content = options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report)
  const temporary = `${output}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(temporary, content, 'utf8')
  await fs.rename(temporary, output)
}

async function statIfPresent(file) {
  try {
    return await fs.stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function resolveRealOutput(file) {
  if (await statIfPresent(file)) return fs.realpath(file)
  const missing = []
  let current = file
  while (true) {
    missing.unshift(path.basename(current))
    const parent = path.dirname(current)
    if (await statIfPresent(parent)) return path.join(await fs.realpath(parent), ...missing)
    if (parent === current) throw new Error(`cannot resolve output parent: ${file}`)
    current = parent
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error) => { const message = error instanceof Error ? error.message : String(error); process.stderr.write(`skill-match-evolve: ${message}\n`); process.exitCode = 2 })
}
