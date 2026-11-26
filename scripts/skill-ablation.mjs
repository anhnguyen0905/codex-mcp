import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRubric, runMechanical, scoreCase, validateCases } from './quality-eval.mjs'

const rubricFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'quality', 'rubrics.json')

const parseCases = (value) => Array.isArray(value) ? value : value?.cases

const caseIds = (cases) => cases.map((item) => item.id)

const flagValue = (args, flag) => {
  const index = args.indexOf(flag)
  const value = index < 0 ? undefined : args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

const isSafeCaseId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && !id.includes('..')

export function buildAblationPrompts(cases, block) {
  if (!Array.isArray(cases) || !cases.every((item) => item && typeof item.id === 'string' && typeof item.request === 'string')) throw new Error('cases must contain ids and requests')
  if (typeof block !== 'string') throw new Error('block must be text')
  return cases.map((item) => ({
    id: item.id,
    with: `${item.request}\n\nRules:\n${block}`,
    without: item.request,
  }))
}

export function compareGrades(withCases, withoutCases) {
  const rubric = loadRubric(rubricFile)
  const withValid = validateCases(withCases, rubric)
  const withoutValid = validateCases(withoutCases, rubric)
  const withIds = caseIds(withValid)
  const withoutIds = caseIds(withoutValid)
  const withoutById = new Map(withoutValid.map((item) => [item.id, item]))
  if (withIds.length !== withoutIds.length || withIds.some((id) => !withoutById.has(id))) throw new Error('with and without cases must have the same id set')
  const rows = withValid.map((item) => {
    const withoutItem = withoutById.get(item.id)
    const withRate = scoreCase(runMechanical(item, { baseDir: process.cwd() })).rubricPct
    const withoutRate = scoreCase(runMechanical(withoutItem, { baseDir: process.cwd() })).rubricPct
    return { id: item.id, withRate, withoutRate, delta: withRate === null || withoutRate === null ? null : withRate - withoutRate }
  })
  const rates = (key) => rows.map((row) => row[key]).filter((rate) => rate !== null)
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const withMean = mean(rates('withRate'))
  const withoutMean = mean(rates('withoutRate'))
  return { cases: rows, aggregate: { withRate: withMean, withoutRate: withoutMean, delta: withMean === null || withoutMean === null ? null : withMean - withoutMean } }
}

const readCaseFile = (file) => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const cases = parseCases(parsed)
  if (!Array.isArray(cases)) throw new Error('case file must be an array or an object with cases')
  return cases
}

const promptsCommand = (args) => {
  const casesFile = flagValue(args, '--cases')
  const blockFile = flagValue(args, '--block')
  const outputDir = flagValue(args, '--out')
  if (!casesFile || !blockFile || !outputDir) throw new Error('prompts requires --cases, --block, and --out')
  const cases = readCaseFile(casesFile)
  const prompts = buildAblationPrompts(cases, readFileSync(blockFile, 'utf8'))
  if (prompts.some((item) => !isSafeCaseId(item.id))) throw new Error('case ids must be safe file-name tokens')
  const target = path.resolve(outputDir)
  mkdirSync(target, { recursive: true })
  const manifest = prompts.map((item) => {
    const withName = `${item.id}.with.prompt.txt`
    const withoutName = `${item.id}.without.prompt.txt`
    writeFileSync(path.join(target, withName), item.with)
    writeFileSync(path.join(target, withoutName), item.without)
    return { id: item.id, with: withName, without: withoutName }
  })
  writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
}

const compareCommand = (args) => {
  const withFile = flagValue(args, '--with')
  const withoutFile = flagValue(args, '--without')
  if (!withFile || !withoutFile) throw new Error('compare requires --with and --without')
  const result = compareGrades(readCaseFile(withFile), readCaseFile(withoutFile))
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else {
    for (const row of result.cases) process.stdout.write(`${JSON.stringify(row)}\n`)
    process.stdout.write(`aggregate ${JSON.stringify(result.aggregate)}\n`)
    if (result.aggregate.withRate === null || result.aggregate.withoutRate === null || result.cases.some((row) => row.withRate === null || row.withoutRate === null)) process.stdout.write('n/a cases are excluded from aggregate means\n')
  }
}

export function main(args) {
  if (args[0] === 'prompts') return promptsCommand(args)
  if (args[0] === 'compare') return compareCommand(args)
  throw new Error('usage: prompts or compare')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); process.exitCode = 0 } catch (error) {
    process.stderr.write(`skill-ablation: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
