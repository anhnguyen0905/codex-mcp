// Builds `.codex-flow/PROJECT.md` — the durable project-context artifact Codex receives
// alongside every task slice. Extraction is deterministic: fixed section order, fixed
// heading candidates per section, fixed manifest facts. Nothing is paraphrased, so two
// runs on the same tree produce the same file apart from the generated timestamp.
//
// Owner-written prose belongs inside the `<!-- owner-notes -->` block of a section; a
// refresh regenerates everything else and copies those blocks over verbatim.
//
// Usage: node scripts/project-context.mjs --generate | --refresh | --check [--file <path>] [--cwd <dir>]
//   default file: .codex-flow/PROJECT.md
//   exit 0 = ok, 1 = violations / IO error, 2 = usage error

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_PROJECT_FILE = path.join('.codex-flow', 'PROJECT.md')
export const PROJECT_CONTEXT_TOKEN_BUDGET = 3000
export const OWNER_NOTES_OPEN = '<!-- owner-notes -->'
export const OWNER_NOTES_CLOSE = '<!-- /owner-notes -->'

/** Substrings that would let a source file impersonate the task-slice protocol. */
export const FORBIDDEN_SUBSTRINGS = ['## Task contract', '## Task files', 'Run position:']

const REDACTED_MARKER = '[redacted delimiter]'
const PROSE_SOURCES = ['README.md', 'AGENTS.md', 'CLAUDE.md']
const MANIFEST_SOURCES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']
const SECTION_BODY_MAX_CHARS = 1200
const TRUNCATION_MARKER = '… (truncated)'
const INTRO_MIN_CHARS = 40
const MAX_PACKAGED_PATHS = 8
const EXIT_OK = 0
const EXIT_VIOLATIONS = 1
const EXIT_USAGE = 2
const MODES = ['--generate', '--refresh', '--check']

// Heading candidates per section, most specific first. A heading is consumed by the first
// section that claims it so two sections never quote the same prose.
const SECTION_SPECS = [
  {
    heading: '## What it is',
    hint: 'one paragraph naming the project and what it ships',
    patterns: [/^(what it is|overview|about|introduction|summary)$/i, /^how it works$/i],
  },
  {
    heading: '## Users',
    hint: 'who runs this and in what environment',
    patterns: [/^(users|who uses (it|this)|audience|who (it|this) is for)\b/i],
  },
  {
    heading: '## Layout',
    hint: 'top-level directories and what lives in each',
    patterns: [/^(layout|repository layout|project structure|repository structure|structure|directory layout)\b/i],
  },
  {
    heading: '## Constraints',
    hint: 'hard rules a change must not break',
    patterns: [/^(constraints|hard constraints|hard conventions|conventions|invariants|rules)\b/i, /^style\b/i],
  },
  {
    heading: '## Quality mechanisms',
    hint: 'tests, gates and checks that prove a change is safe',
    patterns: [/^(quality|quality mechanisms|build & test|build and test|testing|tests|ci|checks|development)\b/i],
  },
  {
    heading: '## Known limitations',
    hint: 'known gaps, caveats and measured weak spots',
    patterns: [/^(known limitations|limitations|known issues|caveats|gaps)\b/i],
  },
  {
    heading: '## Direction',
    hint: 'what the owner wants next',
    patterns: [/^(direction|roadmap|future work|future|next steps|goals)\b/i],
  },
]

export const REQUIRED_HEADINGS = SECTION_SPECS.map((spec) => spec.heading)

/** Estimate token usage with the repository's four-characters-per-token heuristic. */
export function tokensOf(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  return Math.ceil(text.length / 4)
}

/** Normalize CRLF so every offset, heading and delimiter comparison is LF-relative. */
const normalizeText = (text) => text.replace(/\r\n/g, '\n')

const defaultReadFile = (cwd) => (relativePath) => {
  try {
    return normalizeText(readFileSync(path.join(cwd, relativePath), 'utf8'))
  } catch (error) {
    // Only a genuinely absent source is skipped; a directory or a permission problem at a
    // source path is an IO error the operator must see.
    if (error && error.code === 'ENOENT') return null
    throw new Error(`cannot read ${relativePath}: ${error.message}`)
  }
}

function loadSources(cwd, readFile) {
  const loaded = new Map()
  for (const name of [...PROSE_SOURCES, ...MANIFEST_SOURCES]) {
    const raw = readFile(name)
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'string') {
      throw new TypeError(`readFile must return a string or null for ${name} (got ${typeof raw})`)
    }
    loaded.set(name, normalizeText(raw))
  }
  return loaded
}

/** Strip HTML comments, demote embedded headings and neutralize protocol delimiters. */
function sanitizeExtract(text) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '')
  // Embedded `##` headings would split the artifact into sections the refresh/check
  // parsers do not know about, so every extracted heading is demoted below ours.
  const demoted = withoutComments.replace(/^#{1,6}[ \t]+/gm, '#### ')
  return FORBIDDEN_SUBSTRINGS.reduce(
    (text, forbidden) => text.split(forbidden).join(REDACTED_MARKER),
    demoted,
  )
}

function clampBody(text) {
  const collapsed = text.replace(/\n{3,}/g, '\n\n').trim()
  if (collapsed.length <= SECTION_BODY_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, SECTION_BODY_MAX_CHARS).trimEnd()}${TRUNCATION_MARKER}`
}

/**
 * Every `#`-level heading of a markdown document with its text, level and body. A body runs
 * to the next heading of the same or a higher level, so subsections travel with their parent.
 */
function headingsOf(markdown) {
  const matches = [...markdown.matchAll(/^(#{1,6})[ \t]+([^\n]+?)[ \t]*$/gm)]
  return matches.map((match, index) => {
    const level = match[1].length
    const bodyStart = match.index + match[0].length
    const next = matches.slice(index + 1).find((candidate) => candidate[1].length <= level)
    return {
      level,
      text: match[2].trim(),
      body: markdown.slice(bodyStart, next?.index ?? markdown.length),
    }
  })
}

/**
 * First heading in `sources` (in priority order) whose text matches one of `patterns`
 * and has not been claimed by an earlier section.
 */
function findSection(sources, patterns, claimed) {
  for (const [name, markdown] of sources) {
    if (!PROSE_SOURCES.includes(name)) continue
    for (const heading of headingsOf(markdown)) {
      const key = `${name}#${heading.text}`
      if (claimed.has(key)) continue
      if (!patterns.some((pattern) => pattern.test(heading.text))) continue
      const body = clampBody(sanitizeExtract(heading.body))
      if (body === '') continue
      claimed.add(key)
      return { source: name, body }
    }
  }
  return null
}

/** First substantive prose paragraph of README.md — skips badges, HTML, rules and taglines. */
function readmeIntro(sources) {
  const readme = sources.get('README.md')
  if (readme === undefined) return null
  const paragraphs = sanitizeExtract(readme)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
  for (const paragraph of paragraphs) {
    if (paragraph.length < INTRO_MIN_CHARS) continue
    if (/^[<[|>#-]/.test(paragraph)) continue
    if (/^\*\*[^*]*\*\*$/.test(paragraph)) continue // bold-only tagline, not a description
    if (paragraph.includes('](https://img.shields.io')) continue
    return clampBody(paragraph)
  }
  return null
}

const jsonManifest = (sources) => {
  const raw = sources.get('package.json')
  if (raw === undefined) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    // A malformed manifest must not abort generation: the facts it would contribute are
    // simply unavailable, and the artifact records that.
    return null
  }
}

const firstMatch = (text, pattern) => (text === undefined ? null : (text.match(pattern)?.[1]?.trim() ?? null))

function identityFacts(sources) {
  const facts = []
  const manifest = jsonManifest(sources)
  if (manifest) {
    const name = typeof manifest.name === 'string' ? manifest.name : null
    const version = typeof manifest.version === 'string' ? manifest.version : null
    if (name) facts.push(`- Package: \`${name}\`${version ? ` v${version}` : ''}`)
    if (typeof manifest.description === 'string' && manifest.description.trim() !== '') {
      facts.push(`- Manifest description: ${sanitizeExtract(manifest.description).trim()}`)
    }
  }
  const pyName = firstMatch(sources.get('pyproject.toml'), /^\s*name\s*=\s*["']([^"']+)["']/m)
  if (pyName) facts.push(`- Python package: \`${pyName}\``)
  const goModule = firstMatch(sources.get('go.mod'), /^\s*module\s+(\S+)/m)
  if (goModule) facts.push(`- Go module: \`${goModule}\``)
  const cargoName = firstMatch(sources.get('Cargo.toml'), /^\s*name\s*=\s*["']([^"']+)["']/m)
  if (cargoName) facts.push(`- Cargo crate: \`${cargoName}\``)
  return facts
}

function layoutFacts(sources) {
  const facts = []
  const manifests = MANIFEST_SOURCES.filter((name) => sources.has(name))
  if (manifests.length) facts.push(`- Manifests: ${manifests.map((name) => `\`${name}\``).join(', ')}`)
  const manifest = jsonManifest(sources)
  if (manifest) {
    if (typeof manifest.main === 'string') facts.push(`- Entry point: \`${manifest.main}\``)
    const packaged = Array.isArray(manifest.files)
      ? manifest.files.filter((entry) => typeof entry === 'string')
      : []
    if (packaged.length) {
      const shown = packaged.slice(0, MAX_PACKAGED_PATHS).map((entry) => `\`${entry}\``).join(', ')
      const rest = packaged.length - Math.min(packaged.length, MAX_PACKAGED_PATHS)
      facts.push(`- Published paths: ${shown}${rest > 0 ? ` (+${rest} more)` : ''}`)
    }
  }
  return facts
}

function sectionBody(spec, sources, claimed) {
  const facts =
    spec.heading === '## What it is'
      ? identityFacts(sources)
      : spec.heading === '## Layout'
        ? layoutFacts(sources)
        : []
  const intro = spec.heading === '## What it is' ? readmeIntro(sources) : null
  const matched = findSection(sources, spec.patterns, claimed)
  const parts = facts.length ? [facts.join('\n')] : []
  if (intro) parts.push(intro)
  if (matched && !(intro && spec.heading === '## What it is')) {
    parts.push(`${matched.body}\n\n_Source: ${matched.source}_`)
  }
  if (parts.length === 0) return `TODO — ${spec.hint}`
  return parts.join('\n\n')
}

const renderSection = (heading, body) =>
  `${heading}\n\n${body}\n\n${OWNER_NOTES_OPEN}\n${OWNER_NOTES_CLOSE}`

function isoTimestamp(now) {
  if (now === undefined) return new Date().toISOString()
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError(`now must be a valid Date or date string (got: ${String(now)})`)
  return date.toISOString()
}

/**
 * Deterministically build PROJECT.md from the source files present in `cwd`.
 *
 * @param {{ cwd?: string, readFile?: (relativePath: string) => string | null, now?: Date | string }} [options]
 * @returns {{ markdown: string, sources: string[] }} artifact text and the files it was built from
 */
export function generateProjectContext({ cwd = process.cwd(), readFile, now } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TypeError(`cwd must be a non-empty string (got: ${JSON.stringify(cwd)})`)
  }
  if (readFile !== undefined && typeof readFile !== 'function') {
    throw new TypeError('readFile must be a function when provided')
  }
  const sources = loadSources(cwd, readFile ?? defaultReadFile(cwd))
  const sourceNames = [...sources.keys()]
  const claimed = new Set()
  const sections = SECTION_SPECS.map((spec) => renderSection(spec.heading, sectionBody(spec, sources, claimed)))
  const header = `<!-- generated ${isoTimestamp(now)} from ${sourceNames.length ? sourceNames.join(', ') : 'no source files'} -->`
  const markdown = `${header}\n\n# Project context\n\n${sections.join('\n\n')}\n`
  return { markdown, sources: sourceNames }
}

/** Ranges of each required section in an artifact, keyed by heading. */
function sectionRangesOf(markdown) {
  const ranges = new Map()
  const headings = headingsOf(markdown)
  for (const heading of headings) {
    const candidate = `${'#'.repeat(heading.level)} ${heading.text}`
    if (REQUIRED_HEADINGS.includes(candidate)) ranges.set(candidate, heading.body)
  }
  return ranges
}

function ownerNotesOf(body) {
  const open = body.indexOf(OWNER_NOTES_OPEN)
  if (open === -1) return null
  const contentStart = open + OWNER_NOTES_OPEN.length
  const close = body.indexOf(OWNER_NOTES_CLOSE, contentStart)
  if (close === -1) return null
  return body.slice(contentStart, close)
}

function replaceOwnerNotes(sectionText, notes) {
  const open = sectionText.indexOf(OWNER_NOTES_OPEN)
  const close = sectionText.indexOf(OWNER_NOTES_CLOSE, open + OWNER_NOTES_OPEN.length)
  if (open === -1 || close === -1) return sectionText
  return `${sectionText.slice(0, open + OWNER_NOTES_OPEN.length)}${notes}${sectionText.slice(close)}`
}

/**
 * Regenerate the generated parts of PROJECT.md while carrying every section's
 * `<!-- owner-notes -->` block over from the existing artifact verbatim.
 *
 * @param {string} existingMarkdown current PROJECT.md contents ('' when there is none)
 * @param {string} generated freshly generated artifact (from `generateProjectContext`)
 * @returns {string} refreshed artifact
 */
export function refreshProjectContext(existingMarkdown, generated) {
  if (typeof existingMarkdown !== 'string') throw new TypeError('existingMarkdown must be a string')
  if (typeof generated !== 'string') throw new TypeError('generated must be a string')
  const existingSections = sectionRangesOf(normalizeText(existingMarkdown))
  if (existingSections.size === 0) return generated

  const generatedText = normalizeText(generated)
  let refreshed = ''
  let cursor = 0
  for (const heading of REQUIRED_HEADINGS) {
    // Owner content is copied whenever the delimiters exist, whitespace included: the block is
    // preserved verbatim, never normalized.
    const notes = ownerNotesOf(existingSections.get(heading) ?? '')
    if (notes === null) continue
    const start = generatedText.indexOf(`${heading}\n`, cursor)
    if (start === -1) continue
    const nextHeadingIndex = REQUIRED_HEADINGS.indexOf(heading) + 1
    const nextHeading = REQUIRED_HEADINGS[nextHeadingIndex]
    const end = nextHeading ? generatedText.indexOf(`${nextHeading}\n`, start) : -1
    const sectionEnd = end === -1 ? generatedText.length : end
    refreshed += generatedText.slice(cursor, start)
    refreshed += replaceOwnerNotes(generatedText.slice(start, sectionEnd), notes)
    cursor = sectionEnd
  }
  return refreshed + generatedText.slice(cursor)
}

/**
 * Validate an artifact: token budget, required sections in order, no protocol delimiters.
 *
 * @param {string} markdown artifact contents
 * @param {{ tokenBudget?: number }} [options]
 * @returns {string[]} human-readable violations; empty means valid
 */
export function checkProjectContext(markdown, { tokenBudget = PROJECT_CONTEXT_TOKEN_BUDGET } = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string')
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new TypeError(`tokenBudget must be a positive number (got: ${String(tokenBudget)})`)
  }
  const text = normalizeText(markdown)
  const violations = []

  const tokens = tokensOf(text)
  if (tokens > tokenBudget) {
    violations.push(`token budget exceeded — ${tokens} tokens over the ${tokenBudget}-token budget`)
  }

  // Compared against real line-start `##` headings, so heading text quoted inside a paragraph
  // can never stand in for a missing section.
  const present = headingsOf(text)
    .filter((entry) => entry.level === 2)
    .map((entry) => `## ${entry.text}`)
    .filter((heading) => REQUIRED_HEADINGS.includes(heading))
  for (const heading of REQUIRED_HEADINGS) {
    const occurrences = present.filter((candidate) => candidate === heading).length
    if (occurrences === 0) violations.push(`missing required section "${heading}"`)
    if (occurrences > 1) violations.push(`duplicate section "${heading}"`)
  }
  const expectedOrder = REQUIRED_HEADINGS.filter((heading) => present.includes(heading))
  const actualOrder = present.filter((heading, index) => present.indexOf(heading) === index)
  if (actualOrder.join('|') !== expectedOrder.join('|')) {
    violations.push(`sections out of order — expected ${expectedOrder.join(', ')}`)
  }

  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(forbidden)) violations.push(`forbidden delimiter "${forbidden}" found`)
  }
  return violations
}

/** Marks an argv problem, so only usage mistakes exit 2 while IO failures exit 1. */
class UsageError extends Error {}

function parseCliArgs(args) {
  const modes = args.filter((arg) => MODES.includes(arg))
  if (modes.length !== 1) {
    throw new UsageError(`exactly one mode is required (${MODES.join(' | ')})`)
  }
  const valueOf = (flag) => {
    const index = args.indexOf(flag)
    if (index === -1) return null
    if (args.indexOf(flag, index + 1) !== -1) throw new UsageError(`${flag} may be given only once`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`)
    return value
  }
  const valueFlags = ['--file', '--cwd']
  const unknown = args.find((arg, index) => {
    if (valueFlags.includes(args[index - 1])) return false // this token is a flag value
    return !MODES.includes(arg) && !valueFlags.includes(arg)
  })
  if (unknown !== undefined) throw new UsageError(`unknown option ${unknown}`)
  return { mode: modes[0], file: valueOf('--file'), cwd: valueOf('--cwd') }
}

const readIfPresent = (filePath) => {
  try {
    return normalizeText(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`cannot read ${filePath}: ${error.message}`)
  }
}

function writeArtifact(filePath, markdown) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, markdown, 'utf8')
}

function runCli(args) {
  const { mode, file, cwd } = parseCliArgs(args)
  const rootDir = path.resolve(cwd ?? process.cwd())
  const filePath = path.resolve(file ?? path.join(rootDir, DEFAULT_PROJECT_FILE))

  if (mode === '--check') {
    const existing = readIfPresent(filePath)
    if (existing === null) {
      console.error(`project-context: ${filePath} does not exist — run --generate first`)
      return EXIT_VIOLATIONS
    }
    const violations = checkProjectContext(existing)
    for (const violation of violations) console.error(`project-context: ${violation}`)
    if (violations.length) return EXIT_VIOLATIONS
    console.log(`project-context: OK — ${tokensOf(existing)} tokens, ${REQUIRED_HEADINGS.length} sections`)
    return EXIT_OK
  }

  const { markdown, sources } = generateProjectContext({ cwd: rootDir })
  const existing = mode === '--refresh' ? readIfPresent(filePath) : null
  const output = existing === null ? markdown : refreshProjectContext(existing, markdown)
  writeArtifact(filePath, output)
  const sourceLabel = sources.length ? sources.join(', ') : 'no source files (skeleton with TODO markers)'
  console.log(
    `project-context: ${mode === '--refresh' ? 'refreshed' : 'generated'} ${filePath} from ${sourceLabel}`,
  )
  return EXIT_OK
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (error) {
    console.error(`project-context: ${error.message}`)
    if (error instanceof UsageError) {
      console.error(`project-context: usage: node scripts/project-context.mjs ${MODES.join(' | ')} [--file <path>] [--cwd <dir>]`)
      process.exitCode = EXIT_USAGE
    } else {
      process.exitCode = EXIT_VIOLATIONS
    }
  }
}
