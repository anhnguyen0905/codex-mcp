import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const TOKEN_PATTERN = /[\p{L}\p{N}_.-]{4,}/gu
const WORD_PATTERN = /[\p{L}\p{N}]+/gu
const DEFAULT_DENYLIST = path.join(homedir(), '.codex-mcp', 'data-guard.json')
const normalize = (value) => value.normalize('NFKC').toLowerCase()
const sha256 = (value) => createHash('sha256').update(normalize(value)).digest('hex')
const lineNumber = (text, index) => text.slice(0, index).split(/\r?\n/).length
const finding = (file, line, rule) => ({ file, line, rule })
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const unchecked = (file, reason) => ({ file, reason })

const realCaseLines = (text) => {
  try {
    const parsed = JSON.parse(text)
    const sources = []
    const collect = (value) => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (isRecord(value)) {
        if (value.source === 'real') sources.push(value)
        Object.values(value).forEach(collect)
      }
    }
    collect(parsed)
    if (!sources.length) return []
    return [...text.matchAll(/"source"\s*:\s*"real"/g)].map((match) => lineNumber(text, match.index))
  } catch { return [] }
}

const candidateHashes = (text) => {
  const candidates = new Map()
  const add = (value, index) => {
    const normalized = normalize(value)
    if (normalized.length >= 4) candidates.set(`${normalized}:${index}`, normalized)
  }
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    add(match[0], match.index)
    match[0].split('.').forEach((segment) => add(segment, match.index))
    match[0].split(/[._/-]/).forEach((segment) => add(segment, match.index))
  }
  const words = [...text.matchAll(WORD_PATTERN)]
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= words.length - size; index += 1) {
      add(words.slice(index, index + size).map((word) => word[0]).join(' '), words[index].index)
    }
  }
  return [...candidates.keys()]
}

export function scanTrackedFiles({ files, readFile, denyHashes }) {
  const findings = []
  const uncheckedFiles = []
  for (const file of files) {
    if (file.split('/').includes('quality-holdout')) findings.push(finding(file, 1, 'holdout-path'))
    let text
    try { text = readFile(file) } catch (error) {
      uncheckedFiles.push(unchecked(file, error instanceof Error ? error.message : 'read failed'))
      continue
    }
    if (file.endsWith('.json')) realCaseLines(text).forEach((line) => findings.push(finding(file, line, 'real-case')))
    const seenLines = new Set()
    for (const key of candidateHashes(text)) {
      const [token, index] = key.split(':')
      if (denyHashes.has(sha256(token))) seenLines.add(lineNumber(text, Number(index)))
    }
    seenLines.forEach((line) => findings.push(finding(file, line, 'denylisted-token')))
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))
  return { findings, unchecked: uncheckedFiles }
}

const loadDenylist = (file) => {
  if (!existsSync(file)) return new Set()
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed) || !Array.isArray(parsed.sha256)
    || parsed.sha256.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('denylist must contain a sha256 array of lowercase hashes')
  }
  return new Set(parsed.sha256)
}
const repoRoot = (cwd) => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'could not find repository root')
  return result.stdout.trim()
}
const trackedFiles = (cwd) => {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'could not list tracked files')
  return result.stdout.split('\0').filter(Boolean)
}
const usage = () => 'usage: node scripts/data-guard.mjs [--json] [--add <token>]'
const parseArgs = (argv) => {
  if (argv.length === 0) return { json: false, add: null }
  if (argv.length === 1 && argv[0] === '--json') return { json: true, add: null }
  if (argv.length === 2 && argv[0] === '--add' && argv[1] && !argv[1].startsWith('--')) {
    return { json: false, add: argv[1] }
  }
  throw new Error(usage())
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const { json, add } = parseArgs(argv)
  const denyPath = process.env.CODEX_MCP_DATA_GUARD || DEFAULT_DENYLIST
  const denyHashes = loadDenylist(denyPath)
  if (add !== null) {
    const hash = sha256(add)
    const isNew = !denyHashes.has(hash)
    const next = [...new Set([...denyHashes, hash])]
    mkdirSync(path.dirname(denyPath), { recursive: true, mode: 0o700 })
    writeFileSync(denyPath, `${JSON.stringify({ sha256: next }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(denyPath, 0o600)
    console.log(isNew ? 'added 1 hash' : 'added 0 hashes')
    return 0
  }
  const root = repoRoot(cwd)
  const skipped = []
  const files = trackedFiles(root).filter((file) => {
    try {
      const bytes = readFileSync(path.join(root, file))
      if (bytes.length > MAX_FILE_BYTES) { skipped.push(unchecked(file, 'oversize')); return false }
      if (bytes.subarray(0, 8192).includes(0)) { skipped.push(unchecked(file, 'binary')); return false }
      return true
    } catch (error) {
      skipped.push(unchecked(file, error instanceof Error ? error.message : 'read failed'))
      return false
    }
  })
  const result = scanTrackedFiles({ files, readFile: (file) => readFileSync(path.join(root, file), 'utf8'), denyHashes })
  const output = { findings: result.findings, unchecked: [...skipped, ...result.unchecked] }
  if (json) console.log(JSON.stringify(output))
  else {
    output.findings.forEach(({ rule, file, line }) => console.log(`${rule} ${file}:${line}`))
    output.unchecked.forEach(({ file, reason }) => console.log(`unchecked ${file}: ${reason}`))
    console.log(`${output.findings.length} finding(s); ${output.unchecked.length} unchecked`)
  }
  return output.findings.length || output.unchecked.length ? 1 : 0
}
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) {
  try { process.exitCode = main() } catch (error) {
    console.error(`data-guard: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
