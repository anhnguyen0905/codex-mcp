import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAnchors, parseTables, scanNumberTokens, stripAnchoredRegions } from './evidence-scan.mjs'

const MAX_BUFFER = 64 * 1024
const DEFAULT_TIMEOUT = 120000
const URL_PATTERN = /^https?:\/\//i
const UTF8_COMMAND_ENV = Object.freeze({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const fail = (message) => { throw new Error(message) }

const requireRelativePath = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) {
    fail(`${field} must be a non-empty relative path`)
  }
}

const numericValue = (value, field) => {
  const validString = typeof value === 'string' && value.trim().length > 0
  const validType = typeof value === 'number' || validString
  const number = Number(value)
  if (!validType || !Number.isFinite(number)) fail(`${field} must be a finite number or numeric string`)
  return number
}

const validateFigure = (figure, index, ids) => {
  const prefix = `figures[${index}]`
  if (!isRecord(figure)) fail(`${prefix} must be an object`)
  if (typeof figure.id !== 'string' || !/^F\d+$/.test(figure.id)) fail(`${prefix}.id is invalid`)
  if (ids.has(figure.id)) fail(`duplicate id: ${figure.id}`)
  ids.add(figure.id)
  numericValue(figure.value, `${prefix}.value`)
  if (typeof figure.command !== 'string' || figure.command.length === 0) {
    fail(`${prefix}.command must be a non-empty string`)
  }
  if (figure.tolerance !== undefined
    && (typeof figure.tolerance !== 'number' || !Number.isFinite(figure.tolerance) || figure.tolerance < 0)) {
    fail(`${prefix}.tolerance must be a finite number >= 0`)
  }
  if (figure.timeoutMs !== undefined
    && (!Number.isInteger(figure.timeoutMs) || figure.timeoutMs <= 0)) {
    fail(`${prefix}.timeoutMs must be an integer > 0`)
  }
  if (figure.display !== undefined
    && (!Array.isArray(figure.display) || !figure.display.every((value) => typeof value === 'string'))) {
    fail(`${prefix}.display must be an array of strings`)
  }
}

const validateClaim = (claim, index, ids) => {
  const prefix = `claims[${index}]`
  if (!isRecord(claim)) fail(`${prefix} must be an object`)
  if (typeof claim.id !== 'string' || !/^C\d+$/.test(claim.id)) fail(`${prefix}.id is invalid`)
  if (ids.has(claim.id)) fail(`duplicate id: ${claim.id}`)
  ids.add(claim.id)
  if (typeof claim.text !== 'string') fail(`${prefix}.text must be a string`)
  if (claim.sources !== undefined
    && (!Array.isArray(claim.sources) || !claim.sources.every((value) => typeof value === 'string'))) {
    fail(`${prefix}.sources must be an array of strings`)
  }
  for (const [sourceIndex, source] of (claim.sources ?? []).entries()) {
    if (source.length === 0 || URL_PATTERN.test(source) || sourceIsFigure(source)) continue
    const file = source.replace(/:\d+$/, '')
    requireRelativePath(file, `${prefix}.sources[${sourceIndex}]`)
  }
}

/** @param {string} manifestPath @returns {Record<string, unknown>} */
export function parseManifest(manifestPath) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) fail('manifest path is required')
  const absolutePath = path.resolve(manifestPath)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`could not read manifest: ${message}`)
  }
  if (!isRecord(parsed)) fail('manifest must be an object')
  if (parsed.schemaVersion === 1) {
    fail('schemaVersion 1 is no longer supported: upgrade to 2 (number anchors <!--Fn-->, tables[])')
  }
  if (parsed.schemaVersion !== 2) fail('schemaVersion must be 2')
  requireRelativePath(parsed.deliverable, 'deliverable')
  if (!Array.isArray(parsed.figures) || !Array.isArray(parsed.claims)) {
    fail('figures and claims must be arrays')
  }
  if (parsed.ignoreNumbers !== undefined
    && (!Array.isArray(parsed.ignoreNumbers)
      || !parsed.ignoreNumbers.every((value) => typeof value === 'string'))) {
    fail('ignoreNumbers must be an array of strings')
  }
  const ids = new Set()
  parsed.figures.forEach((figure, index) => validateFigure(figure, index, ids))
  const tableIds = new Set()
  if (parsed.tables !== undefined && !Array.isArray(parsed.tables)) fail('tables must be an array')
  for (const [index, table] of (parsed.tables ?? []).entries()) {
    const prefix = `tables[${index}]`
    if (!isRecord(table) || typeof table.id !== 'string' || !/^T\d+$/.test(table.id)) fail(`${prefix}.id is invalid`)
    if (tableIds.has(table.id)) fail(`duplicate id: ${table.id}`)
    tableIds.add(table.id)
    if (typeof table.command !== 'string' || table.command.length === 0) fail(`${prefix}.command must be a non-empty string`)
    if (table.timeoutMs !== undefined && (!Number.isInteger(table.timeoutMs) || table.timeoutMs <= 0)) fail(`${prefix}.timeoutMs must be an integer > 0`)
  }
  const figureLiterals = new Set(parsed.figures.flatMap((figure) => [String(figure.value), ...(figure.display ?? [])]))
  for (const [index, entry] of (parsed.ignoreNumbers ?? []).entries()) {
    if (figureLiterals.has(entry)) fail(`ignoreNumbers[${index}] must not match a figure value or display literal: ${entry}`)
    if (/[.,%]/.test(entry)) fail(`ignoreNumbers[${index}] must not contain '.', ',' or '%': ${entry}`)
    if (/^\d+$/.test(entry) && Number(entry) > 100) fail(`ignoreNumbers[${index}] integer must be <= 100: ${entry}`)
  }
  parsed.claims.forEach((claim, index) => validateClaim(claim, index, ids))
  return parsed
}

/** @param {number|string} value @returns {number} */
export function defaultTolerance(value) {
  const written = typeof value === 'string' ? value.trim() : String(value)
  const mantissa = written.split(/[eE]/)[0]
  const exponent = written.includes('e') || written.includes('E')
    ? Number(written.split(/[eE]/)[1]) : 0
  const fraction = mantissa.replace(/^[+-]/, '').split('.')[1] ?? ''
  const decimalPlaces = Math.max(0, fraction.length - exponent)
  return 0.5 * 10 ** -decimalPlaces
}

const normalizeNumber = (value) => String(value).replace(/^%+|%+$/g, '')

const declaredNumbers = (figures, ignoreNumbers = []) => new Set([
  ...figures.flatMap((figure) => [String(figure.value), ...(figure.display ?? [])]),
  ...ignoreNumbers,
].map(normalizeNumber))

const findUndeclaredEntries = (text, figures, ignoreNumbers = []) => {
  const declared = declaredNumbers(figures, ignoreNumbers)
  return scanNumberTokens(text)
    .filter(({ literal }) => !declared.has(normalizeNumber(literal)))
}

/**
 * @param {string} text
 * @param {Array<Record<string, unknown>>|Record<string, unknown>} figuresOrManifest
 * @param {string[]} [ignoreNumbers]
 * @returns {string[]}
 */
export function findUndeclaredNumbers(text, figuresOrManifest, ignoreNumbers = []) {
  const figures = Array.isArray(figuresOrManifest) ? figuresOrManifest : figuresOrManifest.figures ?? []
  const manifestIgnore = Array.isArray(figuresOrManifest) ? ignoreNumbers : figuresOrManifest.ignoreNumbers ?? []
  return findUndeclaredEntries(text, figures, manifestIgnore).map(({ literal }) => literal)
}

const readSourceDescriptor = (source) => {
  const match = source.match(/^(.*?)(?::(\d+))?$/)
  return { file: match?.[1] ?? source, line: match?.[2] ? Number(match[2]) : undefined }
}

const sourceIsFigure = (source) => /^F\d+$/.test(source)

const addFinding = (findings, check, id, detail) => findings.push({ check, id, detail })

const commandResult = (figure, manifestDir, run) => {
  const timeout = figure.timeoutMs ?? DEFAULT_TIMEOUT
  try {
    return { timeout, result: run(figure.command, {
      shell: true, cwd: manifestDir, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8',
      env: { ...UTF8_COMMAND_ENV, ...process.env },
    }) }
  } catch (error) {
    return { timeout, result: { status: null, error } }
  }
}

const checkFigure = (figure, manifestDir, run, findings) => {
  const { timeout, result } = commandResult(figure, manifestDir, run)
  const errorCode = result?.error?.code
  const timedOut = errorCode === 'ETIMEDOUT' || (result?.signal === 'SIGTERM' && !errorCode)
  if (timedOut) {
    addFinding(findings, 'figure-timeout', figure.id,
      `expected completion within ${timeout} ms, actual timeout`)
    return 1
  }
  const stdout = String(result?.stdout ?? '')
  const stderr = String(result?.stderr ?? '')
  if (result?.status !== 0 || Buffer.byteLength(stdout) > MAX_BUFFER
    || Buffer.byteLength(stderr) > MAX_BUFFER || result?.error) {
    const actual = result?.status === null || result?.status === undefined
      ? errorCode ?? 'no exit status' : `exit ${result.status}`
    addFinding(findings, 'figure-command-failed', figure.id,
      `expected exit 0 and output <= ${MAX_BUFFER} bytes, actual ${actual}`)
    return 1
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  const actual = Number(last)
  if (!Number.isFinite(actual)) {
    addFinding(findings, 'figure-not-numeric', figure.id,
      `expected a finite number on the last non-empty stdout line, actual ${last || '<empty>'}`)
    return 1
  }
  const expected = Number(figure.value)
  const tolerance = figure.tolerance ?? defaultTolerance(figure.value)
  if (Math.abs(actual - expected) > tolerance) {
    addFinding(findings, 'figure-mismatch', figure.id,
      `expected ${String(figure.value)}, actual ${actual}, tolerance ±${tolerance}`)
    return 1
  }
}

const sourceFindings = (manifest, sourceFiles, findings, unchecked) => {
  const figureIds = new Set(manifest.figures.map((figure) => figure.id))
  for (const claim of manifest.claims) {
    const sources = claim.sources ?? []
    if (!sources.some(sourceIsFigure)) addFinding(findings, 'claim-no-figure', claim.id, 'expected at least one figure source')
    if (sources.length === 0) {
      addFinding(findings, 'claim-unsourced', claim.id, 'expected at least one source, actual none')
    }
    for (const source of sources) {
      if (URL_PATTERN.test(source)) {
        if (!unchecked.includes(source)) unchecked.push(source)
        continue
      }
      if (sourceIsFigure(source)) {
        if (!figureIds.has(source)) {
          addFinding(findings, 'source-unknown-figure', claim.id,
            `expected a declared figure, actual unknown figure ${source}`)
        }
        continue
      }
      const descriptor = readSourceDescriptor(source)
      const content = sourceFiles.get(descriptor.file)
      if (content === undefined) {
        addFinding(findings, 'source-missing', claim.id,
          `expected ${source} to exist, actual file is missing`)
        continue
      }
      if (descriptor.line !== undefined
        && (descriptor.line < 1 || descriptor.line > sourceLineCount(content))) {
        addFinding(findings, 'source-missing', claim.id,
          `expected ${source} to be within the file, actual line is beyond EOF`)
      }
    }
  }
}

const csvRows = (output) => output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const cells = []; let cell = ''; let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue }
    if (character === '"') { quoted = !quoted; continue }
    if (character === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue }
    cell += character
  }
  cells.push(cell.trim()); return cells
})

const checkTables = (manifest, deliverable, manifestDir, run, findings, unchecked) => {
  const declared = new Map((manifest.tables ?? []).map((table) => [table.id, table]))
  const parsed = parseTables(deliverable)
  const captions = new Set(parsed.map((table) => table.id))
  for (const table of parsed) {
    const declaration = declared.get(table.id)
    if (!declaration) { addFinding(findings, 'table-unknown', table.id, 'expected a declared table'); continue }
    const { timeout, result } = commandResult(declaration, manifestDir, run)
    if (result?.error || result?.status !== 0 || result?.signal) {
      addFinding(findings, 'table-command', table.id, `expected exit 0 within ${timeout} ms`); continue
    }
    const actual = csvRows(String(result.stdout ?? '')).slice(1)
    if (actual.length !== table.rows.length || actual.some((row, rowIndex) => row.length !== table.rows[rowIndex].length
      || row.some((cell, cellIndex) => cell !== table.rows[rowIndex][cellIndex]))) {
      addFinding(findings, 'table-mismatch', table.id, 'expected every table body cell to match command CSV output')
    }
  }
  for (const table of manifest.tables ?? []) if (!captions.has(table.id)) unchecked.push(`table ${table.id} (not captioned)`)
  return parsed.filter((table) => declared.has(table.id))
}

const anchorFindings = (manifest, deliverable, findings) => {
  const figures = new Map(manifest.figures.map((figure) => [figure.id, figure]))
  for (const anchor of parseAnchors(deliverable)) {
    const figure = figures.get(anchor.id)
    if (!figure) { addFinding(findings, 'anchor-unknown', anchor.id, 'expected a declared figure'); continue }
    const accepted = new Set([String(figure.value), ...(figure.display ?? [])])
    if (anchor.literal === null || !accepted.has(anchor.literal)) addFinding(findings, 'anchor-mismatch', anchor.id, `actual ${anchor.literal ?? '<null>'}`)
  }
}

const preflightFiles = (manifest, manifestDir) => {
  const deliverablePath = path.resolve(manifestDir, manifest.deliverable)
  const deliverable = readFileSync(deliverablePath, 'utf8')
  const sourceFiles = new Map()
  for (const claim of manifest.claims) {
    for (const source of claim.sources ?? []) {
      if (URL_PATTERN.test(source) || sourceIsFigure(source)) continue
      const { file } = readSourceDescriptor(source)
      const sourcePath = path.resolve(manifestDir, file)
      if (!existsSync(sourcePath)) continue
      if (!sourceFiles.has(file)) sourceFiles.set(file, readFileSync(sourcePath, 'utf8'))
    }
  }
  return { deliverable, sourceFiles }
}

const sourceLineCount = (content) => {
  const lines = content.split(/\r?\n/)
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

const checkParsedManifest = (manifestPath, manifest, run = (command, options) => spawnSync(command, options)) => {
  const manifestDir = path.dirname(path.resolve(manifestPath))
  const { deliverable, sourceFiles } = preflightFiles(manifest, manifestDir)
  const findings = []
  for (const figure of manifest.figures) checkFigure(figure, manifestDir, run, findings)
  const unchecked = ['claim meaning (owner sampling)']
  sourceFindings(manifest, sourceFiles, findings, unchecked)
  const parsedTables = checkTables(manifest, deliverable, manifestDir, run, findings, unchecked)
  anchorFindings(manifest, deliverable, findings)
  const sourceCount = manifest.claims.reduce(
    (total, claim) => total + (claim.sources?.length ?? 0), 0,
  )
  const anchored = new Set(parseAnchors(deliverable).filter((anchor) => anchor.literal !== null)
    .map((anchor) => `${anchor.line}:${anchor.column}`))
  const scanned = scanNumberTokens(stripAnchoredRegions(deliverable, parsedTables))
  const ignored = new Set(manifest.ignoreNumbers ?? [])
  const undeclared = scanned.filter(({ literal, line, column }) => !anchored.has(`${line}:${column}`)
    && !ignored.has(literal))
  for (const { literal, line } of undeclared) {
    addFinding(findings, 'unanchored-number', manifest.deliverable,
      `expected a declared number, actual ${literal} on line ${line}`)
  }
  const checks = manifest.figures.length + manifest.claims.length + sourceCount + (manifest.tables ?? []).length + 1
  return { status: findings.length === 0 ? 'pass' : 'fail', checks, findings, unchecked }
}

/** @param {Array<Record<string, unknown>>} claims @param {number} count @param {number} seed */
export function sampleClaims(claims, count, seed) {
  const random = (() => {
    let state = seed >>> 0
    return () => {
      state += 0x6D2B79F5
      let value = state
      value = Math.imul(value ^ value >>> 15, value | 1)
      value ^= value + Math.imul(value ^ value >>> 7, value | 61)
      return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
  })()
  const shuffled = [...claims]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
  }
  return shuffled.slice(0, Math.min(count, shuffled.length))
}

/** @param {string} manifestPath @param {{run?: Function}} [options] */
export function checkManifest(manifestPath, options = {}) {
  const manifest = parseManifest(manifestPath)
  return checkParsedManifest(manifestPath, manifest, options.run)
}

const valueAfter = (argv, index, flag) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${flag} requires a value`)
  return value
}

const parseArgs = (argv) => {
  const values = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      if (values.json) fail('duplicate flag: --json')
      values.json = true
      continue
    }
    if (!['--manifest', '--sample', '--seed'].includes(flag)) fail(`unknown argument: ${flag}`)
    const value = valueAfter(argv, index, flag)
    const key = flag.slice(2)
    if (values[key] !== undefined) fail(`duplicate flag: ${flag}`)
    values[key] = value
    index += 1
  }
  if (!values.manifest) fail('--manifest is required')
  if (values.seed !== undefined && values.sample === undefined) fail('--seed requires --sample')
  if (values.sample !== undefined
    && (!/^\d+$/.test(values.sample) || !Number.isSafeInteger(Number(values.sample)))) {
    fail('--sample must be a non-negative integer')
  }
  if (values.seed !== undefined
    && (!/^-?\d+$/.test(values.seed) || !Number.isSafeInteger(Number(values.seed)))) {
    fail('--seed must be an integer')
  }
  return {
    ...values,
    sample: values.sample === undefined ? undefined : Number(values.sample),
    seed: values.seed === undefined ? 1 : Number(values.seed),
  }
}

const printResult = (result, args, manifest) => {
  const sampleableClaims = manifest.claims.filter((claim) => (claim.sources ?? []).some(sourceIsFigure))
  const sample = args.sample === undefined ? undefined : sampleClaims(sampleableClaims, args.sample, args.seed)
    .map(({ id, text, sources }) => ({ id, text, sources: sources ?? [] }))
  const output = { ...result, ...(sample === undefined ? {} : { sample }) }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output)}\n`)
    return
  }
  for (const finding of result.findings) {
    process.stdout.write(`${finding.check} ${finding.id}: ${finding.detail}\n`)
  }
  const word = result.findings.length === 1 ? 'finding' : 'findings'
  process.stdout.write(`summary: ${result.status.toUpperCase()} (${result.findings.length} ${word})\n`)
  process.stdout.write(`unchecked: ${result.unchecked.length ? result.unchecked.join(', ') : 'none'}\n`)
  if (sample) process.stdout.write(`sample: ${sample.map((claim) => claim.id).join(', ') || 'none'}\n`)
}

const printError = (argv, error) => {
  const message = error instanceof Error ? error.message : String(error)
  const json = argv.includes('--json')
  if (json) {
    process.stdout.write(`${JSON.stringify({
      status: 'fail', checks: 0, findings: [], unchecked: [], error: message,
    })}\n`)
  } else {
    process.stdout.write(`status: error\nsummary: ${message}\nunchecked: none\n`)
  }
  process.stderr.write(`${message}\n`)
}

/** @param {string[]} [argv] @returns {number} */
export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv)
    const manifest = parseManifest(args.manifest)
    const result = checkParsedManifest(args.manifest, manifest)
    printResult(result, args, manifest)
    return result.findings.length === 0 ? 0 : 1
  } catch (error) {
    printError(argv, error)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
