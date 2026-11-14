import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync, appendFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendLook, buildGraderPrompt, graderCacheKey, isInsideDir, loadHoldout, holdoutDir, loadRubric, parseGraderVerdict, validateCases, runMechanical, ingestGrades } from './quality-eval.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const rubricFile = path.join(root, 'tests/fixtures/quality/rubrics.json')
const timeoutMs = 300000
export class UsageError extends Error {}

const readCache = (file) => {
  if (!existsSync(file)) return new Map()
  return new Map(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { const item = JSON.parse(line); return [item.key, item.verdict] }))
}
const writeCache = (file, key, verdict) => { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify({ key, verdict })}\n`, { mode: 0o600 }); chmodSync(file, 0o600) }

export async function gradeCases({ cases, rubric, client, cache = new Map(), maxRuns = 6, seed = 0 }) {
  const results = []; let runs = 0; let cacheHits = 0; let skipped = 0
  for (const [index, item] of cases.entries()) {
    const built = buildGraderPrompt(item, rubric, seed + index)
    const deliverableText = item.deliverableText ?? readFileSync(item.deliverable, 'utf8')
    const key = graderCacheKey(built.prompt, rubric.schemaVersion ?? 1, deliverableText)
    if (cache.has(key)) { results.push({ case: item, key, verdict: cache.get(key), fresh: false, cacheHit: true }); cacheHits++; continue }
    if (runs >= maxRuns) { results.push({ case: item, key, skipped: 'budget', fresh: false }); skipped++; continue }
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'quality-grade-'))
    try {
      const file = path.join(workdir, 'deliverable.md');
      writeFileSync(file, deliverableText)
      const response = await client.callTool({ name: 'codex_execute', arguments: { prompt: built.prompt, cwd: workdir, sandbox: 'read-only', timeoutMs } })
      const structured = response?.structuredContent
      let payload = structured
      if (!payload) {
        const text = response?.content?.find((part) => typeof part.text === 'string')?.text
        if (typeof text !== 'string') throw new Error('codex_execute response has no text payload')
        try { payload = JSON.parse(text) } catch { throw new Error('codex_execute response payload is not JSON') }
      }
      if (payload?.status !== 'success') throw new Error(`codex_execute status is ${payload?.status ?? 'missing'}`)
      const agentMessage = payload.agentMessage
      if (typeof agentMessage !== 'string') throw new Error('codex_execute payload has no agentMessage')
      const verdict = parseGraderVerdict(agentMessage, built.keyMap)
      cache.set(key, verdict); results.push({ case: item, key, verdict, fresh: true }); runs++
    } catch (error) {
      results.push({ index, case: item, key, error: error instanceof Error ? error.message : String(error), fresh: true }); runs++
    } finally { rmSync(workdir, { recursive: true, force: true }) }
  }
  return { results, stats: { runs, cacheHits, skipped } }
}

export function gradingSummary(graded) {
  const errors = graded.results.filter((item) => item.error)
  const skipped = graded.results.filter((item) => item.skipped === 'budget')
  return { graded: graded.results.length - errors.length - skipped.length, errors, skipped: skipped.length }
}
export function gradingExitCode(graded) { return gradingSummary(graded).errors.length ? 1 : 0 }
export function graderReportLine(graded) { const counts = gradingSummary(graded); return `Grader: ${counts.graded} graded, ${counts.errors.length} errors, ${counts.skipped} skipped` }

export function parseGradeArgs(args) {
  const options = { maxRuns: 6, seed: 0 }
  const valueFlags = new Set(['--cases', '--max-runs', '--cache', '--seed', '--report'])
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--holdout') {
      if (options.holdout) throw new UsageError('duplicate --holdout')
      options.holdout = true
    } else if (valueFlags.has(flag)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
      index += 1
      if (flag === '--cases') options.cases = value
      else if (flag === '--cache') options.cache = value
      else if (flag === '--report') options.report = value
      else {
        if (!/^\d+$/.test(value)) throw new UsageError(`${flag} requires a non-negative integer`)
        const parsed = Number(value)
        if (flag === '--max-runs' && parsed > 6) throw new UsageError('--max-runs cannot exceed 6')
        if (flag === '--max-runs') options.maxRuns = parsed
        else options.seed = parsed
      }
    } else throw new UsageError(`unknown argument: ${flag}`)
  }
  if (Boolean(options.cases) === Boolean(options.holdout)) throw new UsageError('provide exactly one of --cases or --holdout')
  return options
}

export function validateGradePaths(options, repoRoot = root) {
  if (options.holdout && options.cache && isInsideDir(options.cache, repoRoot)) throw new UsageError('--cache cannot target the repository during holdout grading')
  return options
}

function loadInput(options) {
  const holdout = holdoutDir()
  const file = options.holdout ? path.join(holdout, 'cases.json') : path.resolve(options.cases)
  const source = readFileSync(file, 'utf8')
  const parsed = options.holdout ? { cases: loadHoldout(holdout) } : JSON.parse(source)
  if (options.holdout) appendLook(holdout, { command: process.argv.slice(2).join(' '), caseCount: parsed.cases.length })
  const rubric = loadRubric(rubricFile)
  const baseDir = options.holdout ? holdout : path.dirname(file)
  const cases = validateCases(parsed.cases ?? parsed, rubric).map((item) => item.deliverable ? { ...item, deliverable: path.resolve(baseDir, item.deliverable) } : item)
  return { baseDir, cases, file, holdout, rubric, source }
}

function persistFreshGrades(file, graded) {
  for (const item of graded.results) if (item.fresh && item.verdict) writeCache(file, item.key, item.verdict)
}

async function writeReport(file, graded, input, options) {
  if (!options.report) return
  const mechanical = input.cases.map((item) => ({ case: item, results: runMechanical(item, { baseDir: input.baseDir }) }))
  const merged = ingestGrades(mechanical, Object.fromEntries(graded.results.map((item, index) => [index, item.verdict])))
  const { renderReport, summarize } = await import('./quality-eval.mjs')
  const metadata = { generatedTs: new Date().toISOString(), split: options.holdout ? 'holdout' : 'all', inputSha256: createHash('sha256').update(input.source).digest('hex'), caseCount: merged.length }
  const report = renderReport(summarize(merged), metadata)
  writeFileSync(path.resolve(options.report), report.replace('\n\nGenerated:', `\n\n${graderReportLine(graded)}\n\nGenerated:`))
}

async function main(args) {
  const options = validateGradePaths(parseGradeArgs(args))
  if (!existsSync(path.join(root, 'dist/index.js'))) throw new Error('dist/ is missing; run npm run build first')
  const input = loadInput(options)
  const cacheFile = path.resolve(options.cache || (options.holdout ? path.join(input.holdout, 'grades.jsonl') : path.join(root, '.codex-flow/notes/grades-dev.jsonl'))); const cache = readCache(cacheFile)
  const client = new Client({ name: 'quality-grade', version: '0.0.1' }); const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js')] })
  try {
    await client.connect(transport)
    const graded = await gradeCases({ cases: input.cases, rubric: input.rubric, client, cache, maxRuns: options.maxRuns, seed: options.seed })
    const counts = gradingSummary(graded)
    for (const item of counts.errors) console.error(`grade ${item.index}: ${item.error}`)
    if (counts.skipped) console.error(`grade skipped: ${counts.skipped}`)
    persistFreshGrades(cacheFile, graded); await writeReport(options.report, graded, input, options)
    if (gradingExitCode(graded)) process.exitCode = 1
  } finally { await client.close().catch(() => {}) }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (direct) main(process.argv.slice(2)).catch((error) => { console.error(`quality-grade: ${error.message}`); process.exit(2) })
