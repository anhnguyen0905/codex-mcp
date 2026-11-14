import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, appendFileSync, chmodSync, writeFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkManifest } from './evidence-check.mjs'
import { sampleClaims } from './evidence-check.mjs'
import { checkLanguage } from './language-check.mjs'

const profiles = ['data', 'design', 'plan', 'content']
const languages = ['en', 'vi']
const splits = ['dev', 'holdout']
const sources = ['real', 'synthetic']
const rubricPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'quality', 'rubrics.json')
export const SECTION_HINTS = Object.freeze({
  'design.goal-and-fantasy': ['goal', 'fantasy', 'mục tiêu'], 'design.core-loop': ['core loop', 'vòng lặp'],
  'design.systems-and-dependencies': ['system', 'hệ thống'], 'design.economy-balance': ['economy', 'balance', 'kinh tế', 'cân bằng'],
  'design.risks': ['risk', 'rủi ro'], 'plan.risks': ['risk', 'rủi ro'], 'design.kpis': ['kpi', 'chỉ số'],
  'plan.objective': ['objective', 'mục tiêu'], 'plan.milestones-and-dependencies': ['milestone', 'mốc'],
  'plan.owners-and-capacity': ['owner', 'capacity', 'phụ trách', 'năng lực'], 'content.audience': ['audience', 'đối tượng'],
  'content.message': ['message', 'thông điệp'], 'content.voice': ['voice', 'giọng'], 'content.cta': ['cta', 'kêu gọi'],
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sorted = (value) => Array.isArray(value)
  ? value.map(sorted)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value
const canonical = (value) => JSON.stringify(sorted(value))
const digest = (value) => createHash('sha256').update(value).digest('hex')
export class UsageError extends Error {}
class FrozenChangesError extends Error {}

export function isInsideDir(target, dir) {
  const resolveNearest = (value) => {
    let current = path.resolve(value)
    while (!existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return realpathSync(current)
  }
  const relative = path.relative(realpathSync(dir), resolveNearest(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function validateEvalPaths(options, repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  if (options.holdout && options.emitPrompts && isInsideDir(options.emitPrompts, repoRoot)) throw new UsageError('--emit-prompts cannot target the repository during holdout evaluation')
  return options
}

function hasQuotedContent(note, cases) {
  return cases.some((item) => [item.request, item.deliverableText].some((text) => {
    if (typeof text !== 'string' || text.length < 12) return false
    return Array.from({ length: text.length - 11 }, (_, index) => text.slice(index, index + 12)).some((part) => note.includes(part))
  }))
}

export function loadRubric(file) {
  const rubric = JSON.parse(readFileSync(file, 'utf8'))
  if (!isObject(rubric) || rubric.schemaVersion !== 1 || !isObject(rubric.profiles)) throw new Error('invalid rubric: expected schemaVersion 1 and profiles')
  const ids = new Set()
  for (const profile of profiles) {
    if (!Array.isArray(rubric.profiles[profile])) throw new Error(`invalid rubric profile: ${profile}`)
    for (const item of rubric.profiles[profile]) {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim() || !item.id.startsWith(`${profile}.`) || typeof item.criterion !== 'string' || !item.criterion.trim() || typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error(`invalid rubric item in ${profile}`)
      if (ids.has(item.id)) throw new Error(`duplicate rubric id: ${item.id}`)
      ids.add(item.id)
    }
  }
  return rubric
}

export function rubricIds(rubric, profile) {
  if (!profiles.includes(profile) || !rubric?.profiles?.[profile]) throw new Error(`unknown rubric profile: ${profile}`)
  return rubric.profiles[profile].map((item) => item.id)
}

function validateExpected(expected, ids, caseId) {
  if (expected === undefined) return
  if (!isObject(expected)) throw new Error(`case ${caseId}: expected must be an object`)
  for (const section of ['mechanical', 'rubric']) {
    if (expected[section] === undefined) continue
    if (!isObject(expected[section])) throw new Error(`case ${caseId}: expected.${section} must be an object`)
    for (const [id, value] of Object.entries(expected[section])) {
      if (!ids.has(id)) throw new Error(`case ${caseId}: unknown expected rubric id ${id}`)
      const allowed = section === 'mechanical' ? ['pass', 'fail', 'n/a'] : ['pass', 'fail']
      if (!allowed.includes(value)) throw new Error(`case ${caseId}: invalid expected.${section} value`)
    }
  }
}

export function validateCases(cases, rubric) {
  if (!Array.isArray(cases)) throw new TypeError('cases must be an array')
  const seen = new Set()
  const ids = new Set(profiles.flatMap((profile) => rubricIds(rubric, profile)))
  const allowed = new Set(['id', 'profile', 'language', 'domain', 'request', 'split', 'source', 'deliverable', 'deliverableText', 'manifest', 'expected'])
  return cases.map((item, index) => {
    if (!isObject(item)) throw new Error(`case ${index + 1}: must be an object`)
    const caseId = typeof item.id === 'string' ? item.id : `#${index + 1}`
    for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`case ${caseId}: unknown key ${key}`)
    if (seen.has(item.id)) throw new Error(`case ${caseId}: duplicate id`)
    seen.add(item.id)
    if (typeof item.id !== 'string' || !item.id) throw new Error(`case ${caseId}: id must be non-empty`)
    if (!profiles.includes(item.profile) || !languages.includes(item.language) || !splits.includes(item.split) || !sources.includes(item.source)) throw new Error(`case ${caseId}: invalid enum value`)
    if (typeof item.domain !== 'string' || typeof item.request !== 'string' || !item.request.trim()) throw new Error(`case ${caseId}: domain and request are required`)
    const hasPath = typeof item.deliverable === 'string' && item.deliverable.length > 0
    const hasText = typeof item.deliverableText === 'string'
    if (hasPath === hasText) throw new Error(`case ${caseId}: exactly one deliverable or deliverableText is required`)
    if (item.source === 'real' && item.split === 'dev') throw new Error(`case ${caseId}: real cases cannot use dev split`)
    validateExpected(item.expected, ids, caseId)
    return { ...item }
  })
}

export function filterCases(cases, filters = {}) {
  return cases.filter((item) => ['split', 'language', 'profile', 'domain'].every((key) => filters[key] === undefined || item[key] === filters[key]))
}

export function caseHash(item, readDeliverable = (file) => readFileSync(file)) {
  const deliverableHash = item.deliverable ? digest(readDeliverable(item.deliverable)) : null
  return digest(canonical({ ...item, deliverableBytesSha256: deliverableHash }))
}

export function holdoutManifest(cases, readDeliverable, previous) {
  return { schemaVersion: 1, count: cases.length, cases: cases.map((item) => ({ id: item.id, sha256: caseHash(item, readDeliverable) })), approvals: previous?.approvals ? [...previous.approvals] : [] }
}

export function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || !Number.isInteger(manifest.count) || !Array.isArray(manifest.cases) || manifest.count !== manifest.cases.length || !Array.isArray(manifest.approvals)) throw new Error('invalid holdout manifest: schemaVersion, count, cases, and approvals are required')
  const ids = new Set()
  for (const item of manifest.cases) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid holdout manifest: cases require unique ids and 64-hex sha256 values')
    ids.add(item.id)
  }
  return manifest
}

export function checkHoldoutFrozen(cases, manifest, readDeliverable) {
  validateManifest(manifest)
  const current = new Map(holdoutManifest(cases, readDeliverable).cases.map((item) => [item.id, item.sha256]))
  const stored = new Map((manifest?.cases ?? []).map((item) => [item.id, item.sha256]))
  const changes = []
  for (const [id, hash] of current) if (!stored.has(id)) changes.push({ id, kind: 'added' }); else if (stored.get(id) !== hash) changes.push({ id, kind: 'changed' })
  for (const id of stored.keys()) if (!current.has(id)) changes.push({ id, kind: 'removed' })
  return { ok: changes.length === 0, changes }
}

export function freezeHoldout(cases, readDeliverable, previous, note, now = new Date().toISOString()) {
  if (typeof note !== 'string' || !note.trim() || note.includes('\n') || note.includes('\r') || note.trim().length > 120 || hasQuotedContent(note, cases)) throw new UsageError('approval note must be 1-120 characters, single-line, and must not quote case content')
  const current = holdoutManifest(cases, readDeliverable)
  const old = new Map((previous?.cases ?? []).map((item) => [item.id, item.sha256]))
  const next = new Map(current.cases.map((item) => [item.id, item.sha256]))
  const ids = [...new Set([...old.keys(), ...next.keys()].filter((id) => old.get(id) !== next.get(id)))]
  return { ...current, approvals: [...(previous?.approvals ?? []), { ts: now, note, ids }] }
}

export function holdoutDir(env = process.env) { return env.CODEX_MCP_QUALITY_HOLDOUT || path.join(os.homedir(), '.codex-mcp', 'quality-holdout') }

export function loadHoldout(dir) {
  const root = path.resolve(dir)
  const loaded = JSON.parse(readFileSync(path.join(root, 'cases.json'), 'utf8'))
  if (!isObject(loaded) || !Array.isArray(loaded.cases)) throw new Error('invalid holdout cases: expected { cases: [] }')
  return loaded.cases.map((item) => item.deliverable ? { ...item, deliverable: path.resolve(root, item.deliverable) } : { ...item })
}

export function appendLook(dir, entry) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
  const file = path.join(dir, 'looks.jsonl')
  if (!existsSync(file)) appendFileSync(file, '', { mode: 0o600 })
  appendFileSync(file, `${JSON.stringify({ ts: entry.ts ?? new Date().toISOString(), command: entry.command, caseCount: entry.caseCount })}\n`, { mode: 0o600 }); chmodSync(file, 0o600)
}

const headingExists = (text, hints) => text.split(/\r?\n/).some((line) => {
  const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1] ?? ''
  return hints.some((hint) => hint.length <= 3
    ? new RegExp(`(?<!\\p{L})${hint}s?(?!\\p{L})`, 'iu').test(heading)
    : heading.toLowerCase().includes(hint.toLowerCase()))
})
const readDeliverable = (item, baseDir) => item.deliverableText ?? readFileSync(path.resolve(baseDir, item.deliverable), 'utf8')
const reasonFrom = (checks) => [...new Set(checks)].join(', ')

export function runMechanical(item, options = {}) {
  const baseDir = options.baseDir ?? process.cwd(); const text = readDeliverable(item, baseDir)
  const ids = rubricIds(loadRubric(rubricPath), item.profile); const results = []
  for (const id of ids) {
    const hints = SECTION_HINTS[id]
    if (hints) results.push({ id, result: headingExists(text, hints) ? 'pass' : 'fail', reason: hints.join(' | ') })
    else if (id === 'data.reproducible' || id === 'data.sourced') {
      if (!item.manifest) { results.push({ id, result: 'n/a', reason: 'no manifest' }); continue }
      let checked
      try { checked = checkManifest(path.resolve(baseDir, item.manifest), { run: options.run }) } catch (error) {
        if (id === 'data.reproducible') results.push({ id, result: 'fail', reason: 'manifest error' })
        else results.push({ id, result: 'fail', reason: 'manifest error' })
        continue
      }
      const checks = checked.findings.filter((finding) => id === 'data.reproducible'
        ? /^(figure-|table-|anchor-|unanchored-number)/.test(finding.check)
        : /^(claim-|source-)/.test(finding.check)).map((finding) => finding.check)
      results.push({ id, result: checks.length ? 'fail' : 'pass', reason: checks.length ? reasonFrom(checks) : 'manifest checks pass' })
    } else if (id.endsWith('language-consistent')) {
      const findings = checkLanguage(text, item.language); results.push({ id, result: findings.length ? 'fail' : 'pass', reason: findings.length ? reasonFrom(findings.map((finding) => finding.check)) : 'language checks pass' })
    } else results.push({ id, result: 'n/a', reason: 'needs grader' })
  }
  return results
}

export function scoreCase(results) {
  if (results.some((item) => !['pass', 'fail', 'n/a'].includes(item.result))) throw new Error('invalid mechanical result')
  const pass = results.filter((item) => item.result === 'pass').length; const fail = results.filter((item) => item.result === 'fail').length
  return { pass, fail, na: results.length - pass - fail, rubricPct: pass + fail ? pass / (pass + fail) : null }
}

export function summarize(caseResults) {
  const cells = {}
  for (const entry of caseResults) {
    const key = `${entry.case.profile}|${entry.case.language}`; const cell = cells[key] ??= { profile: entry.case.profile, language: entry.case.language, n: 0, rubric: [], evidence: [], languagePass: [] }
    cell.n++; const score = entry.score ?? scoreCase(entry.results); if (score.rubricPct !== null) cell.rubric.push(score.rubricPct)
    const evidence = entry.results.find((result) => result.id === 'data.reproducible'); if (entry.case.manifest && evidence) cell.evidence.push(evidence.result === 'pass')
    const language = entry.results.find((result) => result.id.endsWith('language-consistent')); if (language) cell.languagePass.push(language.result === 'pass')
  }
  return Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, { profile: cell.profile, language: cell.language, n: cell.n, rubricPct: cell.rubric.length ? cell.rubric.reduce((a, b) => a + b, 0) / cell.rubric.length : null, evidencePassPct: cell.evidence.length ? cell.evidence.filter(Boolean).length / cell.evidence.length : null, languagePassPct: cell.languagePass.length ? cell.languagePass.filter(Boolean).length / cell.languagePass.length : null }]))
}

export function renderReport(summary, meta) {
  const format = (value) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
  const rows = Object.values(summary).map((cell) => `| ${cell.profile} | ${cell.language} | ${cell.n} | ${format(cell.rubricPct)} | ${format(cell.evidencePassPct)} | ${format(cell.languagePassPct)} |`)
  return `# Quality evaluation report\n\nGenerated: ${meta.generatedTs}\nSplit: ${meta.split}\nInput sha256: ${meta.inputSha256}\nCase count: ${meta.caseCount}\n\n| Profile | Language | n | Rubric % | Evidence pass % | Language pass % |\n| --- | --- | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n`
}

const graderFence = /```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g
const seededRandom = (seed) => {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function buildGraderPrompt(item, rubric, seed = 0) {
  const sourceItems = rubric?.profiles?.[item.profile]
  if (!Array.isArray(sourceItems)) throw new Error('grader prompt requires a known rubric profile')
  const random = seededRandom(seed)
  const shuffled = [...sourceItems]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
  }
  const keyMap = {}
  const rubricText = shuffled.map((rubricItem, index) => {
    const key = `I${index + 1}`
    keyMap[key] = rubricItem.id
    return `${key}: criterion: ${rubricItem.criterion}\nevidence: ${rubricItem.evidence}`
  }).join('\n\n')
  const prompt = `Assess the deliverable against each rubric item using only the request and deliverable. Return pass or fail and quote concise evidence from the deliverable.\n\nRequest:\n${item.request}\n\nDeliverable:\n${item.deliverableText ?? readFileSync(item.deliverable, 'utf8')}\n\nRubric items:\n${rubricText}\n\nPlace exactly one fenced json block LAST, with this shape: {"items":{"I1":{"result":"pass|fail","quote":"<≤200 chars quoted from the deliverable>"}, …}}}`
  return { prompt, keyMap }
}

export function parseGraderVerdict(text, keyMap) {
  const matches = [...String(text).matchAll(graderFence)]
  if (matches.length !== 1) throw new Error('grader verdict must contain exactly one fenced json block')
  if (String(text).slice(matches[0].index + matches[0][0].length).trim()) throw new Error('grader verdict has trailing content')
  const seenKeys = new Set()
  for (const match of matches[0][1].matchAll(/"(I\d+)"\s*:/g)) {
    if (seenKeys.has(match[1])) throw new Error(`duplicate grader key: ${match[1]}`)
    seenKeys.add(match[1])
  }
  let parsed
  try { parsed = JSON.parse(matches[0][1]) } catch { throw new Error('grader verdict JSON is invalid') }
  if (!isObject(parsed) || !isObject(parsed.items)) throw new Error('grader verdict requires an items object')
  const expected = Object.keys(keyMap)
  const actual = Object.keys(parsed.items)
  if (actual.length !== expected.length || actual.some((key) => !Object.hasOwn(keyMap, key))) throw new Error('grader verdict keys do not match the key map')
  return Object.fromEntries(expected.map((key) => {
    const value = parsed.items[key]
    if (!isObject(value) || !['pass', 'fail'].includes(value.result)) throw new Error(`invalid grader result for ${key}`)
    if (typeof value.quote !== 'string' || value.quote.length > 200) throw new Error(`invalid grader quote for ${key}`)
    return [keyMap[key], { result: value.result, quote: value.quote }]
  }))
}

export function agreement(a, b) {
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  const comparable = ids.filter((id) => ['pass', 'fail'].includes(a[id]?.result ?? a[id]) && ['pass', 'fail'].includes(b[id]?.result ?? b[id]))
  const matched = comparable.filter((id) => (a[id]?.result ?? a[id]) === (b[id]?.result ?? b[id])).length
  return { matched, total: comparable.length, rate: comparable.length ? matched / comparable.length : 0 }
}

export function calibrationStatus(rate, min = 0.8) {
  return rate >= min && rate !== 0 ? 'calibrated' : 'uncalibrated'
}

export function sampleForOwner(cases, count, seed) { return sampleClaims(cases, count, seed) }
export function graderCacheKey(prompt, rubricVersion, deliverableText) { return digest(`${prompt}${rubricVersion}${deliverableText}`) }

export function ingestGrades(caseResults, grades) {
  return caseResults.map((entry, index) => {
    const grade = grades[index]
    if (!grade) return entry
    const merged = entry.results.map((result) => {
      const grader = grade[result.id]
      return result.result === 'n/a' && grader ? { ...result, result: grader.result, quote: grader.quote } : result
    })
    return { ...entry, results: merged, score: scoreCase(merged) }
  })
}

const valueFlags = Object.freeze({
  '--cases': 'cases', '--manifest': 'manifest', '--approve': 'approve', '--report': 'report',
  '--split': 'split', '--emit-prompts': 'emitPrompts', '--ingest-grades': 'ingestGrades', '--seed': 'seed',
})

function parseArgs(args) {
  // Usage notes must not quote case content.
  let options = { manifest: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'quality', 'holdout-manifest.json') }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--holdout') options.holdout = true
    else if (arg === '--check-frozen') options.checkFrozen = true
    else if (arg === '--freeze') options.freeze = true
    else if (valueFlags[arg]) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new UsageError(`${arg} requires a value`)
      const value = args[++i]
      if (arg === '--seed' && !/^\d+$/.test(value)) throw new UsageError('--seed requires a non-negative integer')
      options = { ...options, [valueFlags[arg]]: arg === '--seed' ? Number(value) : value }
    } else throw new UsageError(`unknown argument: ${arg}`)
  }
  if (options.freeze && !options.approve) throw new UsageError('--freeze requires --approve')
  if (options.holdout && options.split) throw new UsageError('--split cannot be used with --holdout')
  if (options.split && !['dev', 'holdout'].includes(options.split)) throw new UsageError('--split must be dev or holdout')
  if ((options.checkFrozen || options.freeze) && !options.holdout) throw new UsageError('--check-frozen and --freeze require --holdout')
  return options
}

export function ingestGradeLines(lines, cases, rubric, baseDir, seed = 0) {
  const seen = new Set()
  for (const line of lines) {
    if (!/^\d+$/.test(String(line.index))) throw new UsageError('grade line index must be an integer')
    const index = Number(line.index)
    if (seen.has(index)) throw new UsageError(`duplicate grade index: ${index}`)
    if (index >= cases.length) throw new UsageError(`grade index out of range: ${index}`)
    seen.add(index)
  }
  let ingested = 0; let ungraded = 0
  const grades = {}
  for (const line of lines) {
    const index = Number(line.index); const item = cases[index]
    try {
      const built = buildGraderPrompt({ ...item, deliverableText: readDeliverable(item, baseDir) }, rubric, seed + index)
      grades[index] = parseGraderVerdict(line.text, built.keyMap); ingested++
    } catch { ungraded++ }
  }
  return { grades, ingested, ungraded }
}

async function runCli(args) {
  const options = validateEvalPaths(parseArgs(args)); const dir = holdoutDir()
  if (options.holdout) {
    const casesFile = path.join(dir, 'cases.json'); const cases = loadHoldout(dir); appendLook(dir, { command: process.argv.slice(2).join(' '), caseCount: cases.length })
    const rubric = loadRubric(rubricPath); validateCases(cases, rubric)
    const manifestFile = path.resolve(options.manifest); const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : undefined
    if (previous) validateManifest(previous)
    if (options.checkFrozen) { const result = checkHoldoutFrozen(cases, previous, (file) => readFileSync(file)); if (!result.ok) throw new FrozenChangesError(`holdout changed: ${result.changes.map((change) => `${change.kind}:${change.id}`).join(', ')}`) }
    if (options.freeze) { const next = freezeHoldout(cases, (file) => readFileSync(file), previous, options.approve); mkdirSync(path.dirname(manifestFile), { recursive: true }); writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`) }
    if (options.emitPrompts) {
      mkdirSync(path.resolve(options.emitPrompts), { recursive: true })
      const maps = cases.map((item, index) => { const built = buildGraderPrompt({ ...item, deliverableText: readDeliverable(item, dir) }, rubric, Number(options.seed ?? 0) + index); writeFileSync(path.join(path.resolve(options.emitPrompts), `${index}.prompt.txt`), built.prompt); return built.keyMap })
      writeFileSync(path.join(path.resolve(options.emitPrompts), 'keymap.json'), `${JSON.stringify(maps, null, 2)}\n`)
    }
    if (options.report) {
      let results = cases.map((item) => ({ case: item, results: runMechanical(item, { baseDir: dir }) }))
      if (options.ingestGrades) {
        const lines = readFileSync(path.resolve(options.ingestGrades), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        const ingested = ingestGradeLines(lines, cases, rubric, dir, Number(options.seed ?? 0)); results = ingestGrades(results, ingested.grades); process.stdout.write(`${ingested.ingested} verdicts ingested, ${ingested.ungraded} ungraded\n`)
      }
      const summary = summarize(results); const meta = { generatedTs: new Date().toISOString(), split: 'holdout', inputSha256: digest(readFileSync(casesFile)), caseCount: cases.length }
      writeFileSync(path.resolve(options.report), renderReport(summary, meta)); process.stdout.write(`quality-eval: wrote ${options.report} (${cases.length} cases)\n`)
    }
    return
  }
  if (!options.cases) throw new Error('--cases is required unless --holdout is used')
  const source = readFileSync(options.cases, 'utf8'); const rubric = loadRubric(rubricPath); const parsed = JSON.parse(source)
  const cases = validateCases(parsed.cases ?? parsed, rubric); const baseDir = path.dirname(path.resolve(options.cases))
  const selected = options.split ? filterCases(cases, { split: options.split }) : cases
  if (options.emitPrompts) {
    mkdirSync(path.resolve(options.emitPrompts), { recursive: true })
    const maps = selected.map((item, index) => {
      const built = buildGraderPrompt({ ...item, deliverableText: readDeliverable(item, baseDir) }, rubric, Number(options.seed ?? 0) + index)
      writeFileSync(path.join(path.resolve(options.emitPrompts), `${index}.prompt.txt`), built.prompt)
      return built.keyMap
    })
    writeFileSync(path.join(path.resolve(options.emitPrompts), 'keymap.json'), `${JSON.stringify(maps, null, 2)}\n`)
  }
  if (options.report) {
    let results = selected.map((item) => ({ case: item, results: runMechanical(item, { baseDir }) }))
    if (options.ingestGrades) {
      const lines = readFileSync(path.resolve(options.ingestGrades), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      const ingested = ingestGradeLines(lines, selected, rubric, baseDir, Number(options.seed ?? 0)); results = ingestGrades(results, ingested.grades); process.stdout.write(`${ingested.ingested} verdicts ingested, ${ingested.ungraded} ungraded\n`)
    }
    const summary = summarize(results); const meta = { generatedTs: new Date().toISOString(), split: options.split ?? 'all', inputSha256: digest(source), caseCount: selected.length }
    writeFileSync(path.resolve(options.report), renderReport(summary, meta)); process.stdout.write(`quality-eval: wrote ${options.report} (${selected.length} cases)\n`)
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) runCli(process.argv.slice(2)).then(() => process.exit(0)).catch((error) => {
  console.error(`quality-eval: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(error instanceof FrozenChangesError ? 1 : 2)
})
