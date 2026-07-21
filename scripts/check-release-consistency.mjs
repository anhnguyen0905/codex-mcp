// Release consistency gate: verifies that every file which declares the
// package version agrees on a single version string, and that CHANGELOG.md
// documents it. Optionally (when the git tag v<version> exists, or --tag is
// passed) verifies the tag's tree carries the same versions.
//
// Checked sources:
//   - package.json                .version
//   - package-lock.json           .version and .packages[""].version
//   - server.json                 .version and .packages[0].version
//   - .claude-plugin/plugin.json  .version
//   - CHANGELOG.md                a "## [<version>]" (or "## <version>") heading
//
// Usage: node scripts/check-release-consistency.mjs [--tag]
//   Exits 1 listing EVERY mismatch, not just the first.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// JSON files carrying a version, with the paths inside each document to read.
export const VERSION_SOURCES = [
  { file: 'package.json', paths: [['version']] },
  { file: 'package-lock.json', paths: [['version'], ['packages', '', 'version']] },
  { file: 'server.json', paths: [['version'], ['packages', 0, 'version']] },
  { file: '.claude-plugin/plugin.json', paths: [['version']] },
]

export const CHANGELOG_FILE = 'CHANGELOG.md'

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const describePath = (segments) => `.${segments.map((s) => (typeof s === 'number' ? `[${s}]` : s === '' ? '[""]' : s)).join('.')}`

const getAtPath = (value, segments) =>
  segments.reduce((current, segment) => (current == null ? undefined : current[segment]), value)

// Pure: extract {label, version} entries from one JSON document.
export const extractJsonVersions = (file, jsonText, paths) => {
  const parsed = JSON.parse(jsonText)
  return paths.map((segments) => ({
    label: `${file} ${describePath(segments)}`,
    version: getAtPath(parsed, segments),
  }))
}

// Pure: does the changelog contain a heading for this version?
// Accepts "## [1.2.3] - date" and "## 1.2.3" style headings.
export const changelogHasVersion = (markdown, version) => {
  const v = escapeRegExp(version)
  return new RegExp(`^#{1,3} \\[?${v}\\]?( |$)`, 'm').test(markdown)
}

// Pure: compare entries against the expected version; returns every mismatch.
export const findMismatches = (entries, expected) =>
  entries.filter((entry) => entry.version !== expected)

const formatMismatches = (mismatches, expected) =>
  mismatches
    .map((m) => `  MISMATCH ${m.label} = ${JSON.stringify(m.version ?? null)} (expected "${expected}")`)
    .join('\n')

const readRepoFile = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8')

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const tagExists = (tag) => {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])
    return true
  } catch {
    return false
  }
}

const readFileAtTag = (tag, file) => git(['show', `${tag}:${file}`])

// Collect entries from the working tree (or from a tag's tree via reader).
const collectEntries = (readFile) => {
  const entries = []
  const errors = []
  for (const source of VERSION_SOURCES) {
    try {
      entries.push(...extractJsonVersions(source.file, readFile(source.file), source.paths))
    } catch (error) {
      errors.push(`  ERROR reading ${source.file}: ${error.message}`)
    }
  }
  return { entries, errors }
}

const checkTree = (label, readFile, expected) => {
  const problems = []
  const { entries, errors } = collectEntries(readFile)
  problems.push(...errors)
  problems.push(...formatMismatches(findMismatches(entries, expected), expected).split('\n').filter(Boolean))

  try {
    if (!changelogHasVersion(readFile(CHANGELOG_FILE), expected)) {
      problems.push(`  MISMATCH ${CHANGELOG_FILE}: no heading found for version "${expected}"`)
    }
  } catch (error) {
    problems.push(`  ERROR reading ${CHANGELOG_FILE}: ${error.message}`)
  }

  if (problems.length > 0) {
    console.error(`${label}: version inconsistencies found:`)
    for (const problem of problems) console.error(problem)
    return false
  }
  console.log(`${label}: all sources agree on version "${expected}"`)
  return true
}

const main = () => {
  const wantsTagCheck = process.argv.includes('--tag')

  let expected
  try {
    expected = JSON.parse(readRepoFile('package.json')).version
  } catch (error) {
    console.error(`ERROR: cannot read package.json version: ${error.message}`)
    process.exit(1)
  }
  if (typeof expected !== 'string' || expected.length === 0) {
    console.error('ERROR: package.json .version is missing or empty')
    process.exit(1)
  }

  let ok = checkTree('working tree', readRepoFile, expected)

  const tag = `v${expected}`
  if (wantsTagCheck || tagExists(tag)) {
    if (tagExists(tag)) {
      ok = checkTree(`tag ${tag}`, (file) => readFileAtTag(tag, file), expected) && ok
    } else {
      console.log(`tag ${tag}: not found locally — skipping tag check`)
    }
  } else {
    console.log(`tag ${tag}: not present locally — skipping tag check (pass --tag to require it)`)
  }

  process.exit(ok ? 0 : 1)
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) main()
