import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LANGUAGE_TERMS } from './language-terms.mjs'

const LETTER = '\\p{L}'
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const boundary = (value) => `(?<!${LETTER})${value}(?!${LETTER})`
const mask = (text, regex) => text.replace(regex, (match) => match.replace(/[^\r\n]/g, ' '))
const lineNumber = (text, index) => text.slice(0, index).split(/\r?\n/).length
const TABLE_SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/

const tableCells = (line) => {
  if (!line.includes('|')) return []
  const trimmed = line.trim()
  const content = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return content.split('|')
}

const isTableSeparator = (line) => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell))
}

const isTableHeader = (line, separator) => {
  const headerCells = tableCells(line)
  const separatorCells = tableCells(separator)
  return isTableSeparator(separator) && headerCells.length === separatorCells.length
}

const ignoredText = (text) => {
  let clean = text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, ' '))
  clean = mask(clean, /```[\s\S]*?```/g)
  clean = mask(clean, /`[^`\r\n]*`/g)
  clean = mask(clean, /https?:\/\/[^\s)>]+/gi)
  const parts = clean.split(/(\r?\n)/)
  const lines = parts.filter((_part, index) => index % 2 === 0)
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (isTableHeader(lines[index], lines[index + 1])) lines[index] = lines[index].replace(/[^\r\n]/g, ' ')
  }
  for (let index = 0; index < lines.length; index += 1) parts[index * 2] = lines[index]
  clean = parts.join('')
  clean = mask(clean, /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g)
  return clean
}

const variantPattern = (variant) => boundary(escapeRegex(variant.normalize('NFC')).replace(/\ /g, '\\s+'))
const englishPattern = (term) => {
  const escaped = escapeRegex(term).replace(/ /g, '\\s+')
  if (/[^aeiou]y$/i.test(term)) return boundary(escaped.replace(/y$/i, '(?:y|ies)'))
  return boundary(`${escaped}(?:s|es)?`)
}
const isEnglishSafe = (variant) => /\p{L}/u.test(variant) && (/[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu.test(variant) || variant.trim().split(/\s+/).length >= 2)

const findingsFor = (text, language, terms) => {
  const clean = ignoredText(text)
  const matches = []
  for (const term of terms) {
    if (language === 'vi' && term.allowEnglish) continue
    const candidates = language === 'vi' ? [term.en] : term.vi.filter(isEnglishSafe)
    for (const candidate of candidates) {
      const regex = new RegExp(language === 'vi' ? englishPattern(candidate) : variantPattern(candidate), 'giu')
      for (const match of clean.matchAll(regex)) {
        const index = match.index ?? 0
        const ownVariantBeforeGloss = term.vi.some((variant) =>
          new RegExp(`${escapeRegex(variant)}\\s*\\($`, 'iu').test(text.slice(0, index)))
        if (ownVariantBeforeGloss) continue
        matches.push({ start: index, end: index + match[0].length, check: language === 'vi' ? 'untranslated-term' : 'wrong-language-term', term: candidate })
      }
    }
  }
  const accepted = []
  for (const match of matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.term.localeCompare(b.term))) {
    if (accepted.some((other) => match.start < other.end && other.start < match.end)) continue
    accepted.push(match)
  }
  const findings = accepted.map(({ start, check, term }) => ({ check, term, line: lineNumber(text, start) }))
  const unique = new Map(findings.map((finding) => [`${finding.check}\0${finding.term}\0${finding.line}`, finding]))
  return [...unique.values()].sort((a, b) => a.line - b.line || a.term.localeCompare(b.term))
}

export function checkLanguage(text, language, terms = LANGUAGE_TERMS) {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (!['en', 'vi'].includes(language)) throw new Error('language must be en or vi')
  return findingsFor(text.normalize('NFC'), language, terms)
}

export function languageGateAction({ languageMode, profileMode, exitCode }) {
  if (!['off', 'on'].includes(languageMode) || !['off', 'shadow', 'enforce'].includes(profileMode)) throw new TypeError('unknown language or profile mode')
  if (![0, 1, 2].includes(exitCode)) throw new TypeError('unknown language gate exit code')
  if (languageMode === 'off') return 'skip'
  if (exitCode === 0) return 'record'
  if (exitCode === 2) return 'stop'
  return profileMode === 'enforce' ? 'finding' : 'record'
}

const parseArgs = (argv) => {
  const args = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') { args.json = true; continue }
    if (flag !== '--deliverable' && flag !== '--language') throw new Error(`unknown argument: ${flag}`)
    if (args[flag.slice(2)] !== undefined) throw new Error(`duplicate flag: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    args[flag.slice(2)] = value
    index += 1
  }
  if (!args.deliverable) throw new Error('--deliverable is required')
  if (!['en', 'vi'].includes(args.language)) throw new Error('language must be en or vi')
  return args
}

const printError = (argv, error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ status: 'fail', findings: [], error: message })}\n`)
  process.stderr.write(`${message}\n`)
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv)
    const text = readFileSync(path.resolve(args.deliverable), 'utf8')
    const findings = checkLanguage(text, args.language)
    const result = { status: findings.length ? 'fail' : 'pass', language: args.language, findings }
    if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else {
      for (const finding of findings) process.stdout.write(`${finding.check} ${finding.term}: line ${finding.line}\n`)
      process.stdout.write(`summary: ${result.status.toUpperCase()} (${findings.length} ${findings.length === 1 ? 'finding' : 'findings'})\n`)
    }
    return findings.length ? 1 : 0
  } catch (error) {
    printError(argv, error)
    return 2
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main()
