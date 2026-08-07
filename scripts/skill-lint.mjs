// Validates the mechanical structure and provenance discipline of an authored SKILL.md.
//
// Usage: node scripts/skill-lint.mjs <SKILL.md path>

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const NAME_FIELD_PATTERN = /^name:\s*(.*)$/
const DESCRIPTION_FIELD_PATTERN = /^description:\s*(.*)$/
const BLOCK_SCALAR_DESCRIPTION_PATTERN = /^(?:(?:!\S+|&\S+)\s+)*[>|]/
const SERVES_PATTERN = /^Serves: \S.* — R\d+\.\d+(, R\d+\.\d+)*$/
const LINE_ENDING_PATTERN = /\r?\n/
const TOP_LEVEL_BULLET_PATTERN = /^- /
const REQUIRED_SECTIONS = [
  '## Core method',
  '## Failure modes',
  '## Reviewer checklist',
  '## Provenance',
]
const RULE_BEARING_SECTIONS = REQUIRED_SECTIONS.slice(0, 3)
const H2_PATTERN = /^##\s+/
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/
const EXIT_OK = 0
const EXIT_VIOLATIONS = 1
const USAGE = 'usage: node scripts/skill-lint.mjs <SKILL.md path>'

function frontmatterOf(lines) {
  if (lines[0] !== '---') {
    return {
      bodyLines: lines,
      frontmatterLines: [],
      hasFrontmatter: false,
      violations: ['frontmatter must start with a `---` line'],
    }
  }

  const closingIndex = lines.slice(1).findIndex((line) => line === '---')
  if (closingIndex === -1) {
    return {
      bodyLines: [],
      frontmatterLines: lines.slice(1),
      hasFrontmatter: true,
      violations: ['frontmatter must be closed by a `---` line'],
    }
  }

  const delimiterIndex = closingIndex + 1
  return {
    bodyLines: lines.slice(delimiterIndex + 1),
    frontmatterLines: lines.slice(1, delimiterIndex),
    hasFrontmatter: true,
    violations: [],
  }
}

function frontmatterViolations(frontmatterLines, hasFrontmatter, structuralViolations) {
  if (!hasFrontmatter) return structuralViolations

  const name = frontmatterLines
    .map((line) => line.match(NAME_FIELD_PATTERN)?.[1].trim())
    .find((value) => value !== undefined) ?? ''
  const description = frontmatterLines
    .map((line) => line.match(DESCRIPTION_FIELD_PATTERN)?.[1].trim())
    .find((value) => value !== undefined) ?? ''
  const violations = []

  if (!name) violations.push('frontmatter name is required')
  else if (!NAME_PATTERN.test(name)) {
    violations.push('frontmatter name must match /^[a-z0-9][a-z0-9-]*$/')
  }
  if (!description) {
    violations.push('frontmatter description is required and must be single-line')
  } else if (BLOCK_SCALAR_DESCRIPTION_PATTERN.test(description)) {
    violations.push('description must be a single-line literal value')
  }
  return [...violations, ...structuralViolations]
}

function unfencedLinesOf(lines) {
  let openingFenceType = null
  return lines.filter((line) => {
    const fenceType = line.match(FENCE_PATTERN)?.[1][0] ?? null
    if (fenceType === null) return openingFenceType === null
    if (openingFenceType === null) openingFenceType = fenceType
    else if (fenceType === openingFenceType) openingFenceType = null
    return false
  })
}

function sectionLinesOf(bodyLines, section) {
  const sectionIndex = bodyLines.findIndex((line) => line === section)
  if (sectionIndex === -1) return null

  const followingLines = bodyLines.slice(sectionIndex + 1)
  const nextSectionIndex = followingLines.findIndex((line) => H2_PATTERN.test(line))
  return nextSectionIndex === -1 ? followingLines : followingLines.slice(0, nextSectionIndex)
}

function ruleBearingSectionViolations(bodyLines) {
  return RULE_BEARING_SECTIONS.flatMap((section) => {
    const lines = sectionLinesOf(bodyLines, section)
    if (lines === null || lines.some((line) => (
      line.includes('Source:') || line.includes('derived, unverified')
    ))) return []
    return [`${section} carries no provenance label (Source: or "derived, unverified")`]
  })
}

function provenanceViolations(bodyLines) {
  const lines = sectionLinesOf(bodyLines, '## Provenance') ?? []
  const bullets = lines.filter((line) => TOP_LEVEL_BULLET_PATTERN.test(line))
  if (bullets.length === 0) {
    return ['## Provenance must contain at least one top-level bullet']
  }

  return bullets
    .filter((bullet) => !bullet.includes('Source:') && !bullet.includes('derived, unverified'))
    .map((bullet) => (
      `## Provenance bullet must contain Source: or derived, unverified: ${bullet}`
    ))
}

/** Return all mechanical SKILL.md violations in contract order. */
export function lintSkillText(text) {
  if (typeof text !== 'string') throw new TypeError('skill text must be a string')

  const parsed = frontmatterOf(text.split(LINE_ENDING_PATTERN))
  const bodyLines = unfencedLinesOf(parsed.bodyLines)
  const frontmatterFindings = frontmatterViolations(
    parsed.frontmatterLines,
    parsed.hasFrontmatter,
    parsed.violations,
  )
  const servesFindings = bodyLines.some((line) => SERVES_PATTERN.test(line))
    ? []
    : ['body must contain a Serves line matching /^Serves: \\S.* — R\\d+\\.\\d+(, R\\d+\\.\\d+)*$/']
  const sectionFindings = REQUIRED_SECTIONS
    .filter((section) => !bodyLines.includes(section))
    .map((section) => `missing required section: ${section}`)

  return [
    ...frontmatterFindings,
    ...servesFindings,
    ...sectionFindings,
    ...ruleBearingSectionViolations(bodyLines),
    ...provenanceViolations(bodyLines),
  ]
}

/** Run the skill-lint command and return its process exit code. */
export function runCli(args) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string' || !args[0]) {
    console.error(`skill-lint: ${USAGE}`)
    return EXIT_VIOLATIONS
  }

  const skillPath = args[0]
  let text
  try {
    text = readFileSync(skillPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`skill-lint: cannot read ${skillPath}: ${message}`)
    return EXIT_VIOLATIONS
  }

  const violations = lintSkillText(text)
  for (const violation of violations) console.error(`skill-lint: ${violation}`)
  if (violations.length > 0) return EXIT_VIOLATIONS

  console.log(`skill-lint: OK ${skillPath}`)
  return EXIT_OK
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) process.exitCode = runCli(process.argv.slice(2))
