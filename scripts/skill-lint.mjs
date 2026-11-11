// Validates the mechanical structure and provenance discipline of an authored SKILL.md.
//
// Usage: node scripts/skill-lint.mjs <SKILL.md path> [--max-unverified <ratio>]

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { scanSkillRisk } from './build-skills-index.mjs'

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
const EXTRA_RISK_PATTERNS = Object.freeze([
  // Reject direct attempts to displace prior or system instructions.
  { name: 'instruction-override', verb: /\b(?:ignore|override|disregard)\b/i,
    pattern: /\b(?:ignore|override|disregard)\b[^.\n]{0,80}\b(?:previous|system|prior)\s+(?:instructions?|rules?)/i },
  // Reject a bypass verb only when its review/approval object follows within four words.
  { name: 'review-bypass', verb: /\b(?:bypass|skip|disable)\b/i,
    pattern: /\b(?:bypass|skip|disable)\b(?:\s+(?!(?:before|after|during|for|in)\b)\w+){0,4}\s+(?:the\s+)?(?:code\s+)?(?:review|approval|confirmation|gate)\b/i },
  // Reject exfiltration only with an external destination, or explicit exfiltrate/leak wording.
  { name: 'data-exfiltration', verb: /\b(?:exfiltrate|upload|send|leak)\b/i,
    pattern: /\b(?:exfiltrate|leak)\b|\b(?:upload|send)\b[^.\n]{0,80}\b(?:to\s+(?:https?:\/\/|\S+\.(?:com|org|net)|pastebin)|externally|off the machine)\b/i },
  // Reject fetch-and-execute shell pipelines.
  { name: 'download-piped-to-shell', verb: /\b(?:curl|wget)\b/i,
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i },
])
const EXIT_OK = 0
const EXIT_VIOLATIONS = 1
const USAGE = 'usage: node scripts/skill-lint.mjs <SKILL.md path> [--max-unverified <ratio>]'
const MIN_RULE_BULLETS = Object.freeze({
  '## Core method': 3,
  '## Failure modes': 2,
  '## Reviewer checklist': 3,
})

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

function ruleBullets(bodyLines, section) {
  const lines = sectionLinesOf(bodyLines, section) ?? []
  const bullets = []
  let current = null
  for (const line of lines) {
    if (TOP_LEVEL_BULLET_PATTERN.test(line)) {
      if (current) bullets.push(current)
      current = line
    } else if (current && line.trim()) current += ` ${line.trim()}`
  }
  if (current) bullets.push(current)
  return bullets
}

function authoredRuleViolations(bodyLines) {
  return RULE_BEARING_SECTIONS.flatMap((section) => {
    if (sectionLinesOf(bodyLines, section) === null) return []
    const bullets = ruleBullets(bodyLines, section)
    const count = MIN_RULE_BULLETS[section]
    const findings = bullets.length < count
      ? [`${section} must contain at least ${count} top-level bullets`]
      : []
    return [...findings, ...bullets
      .filter((bullet) => !bullet.includes('Source:') && !bullet.includes('derived, unverified'))
      .map((bullet) => `${section} rule bullet lacks provenance: ${bullet.slice(0, 60)}`)]
  })
}

function concreteSourceViolations(bodyLines) {
  const sourcePattern = /Source:\s*([^\s].*?)(?=\s+(?:Source:|derived, unverified)|$)/gi
  return RULE_BEARING_SECTIONS.flatMap((section) => ruleBullets(bodyLines, section)
    .filter((bullet) => bullet.includes('Source:'))
    .flatMap((bullet) => {
      const labels = [...bullet.matchAll(sourcePattern)]
      return labels.some((match) => {
        const value = match[1].trim()
        return value.length >= 3 && !/^(?:TBD|TODO|n\/a|unknown|<[^>]+>)$/i.test(value)
      }) ? [] : [`Source: value is not concrete in rule bullet: ${bullet.slice(0, 60)}`]
    }))
}

/** Return the count and share of rule bullets marked derived, unverified. */
export function unverifiedShare(text) {
  const lines = unfencedLinesOf(text.split(LINE_ENDING_PATTERN))
  const bullets = RULE_BEARING_SECTIONS.flatMap((section) => ruleBullets(lines, section))
  const unverified = bullets.filter((bullet) => bullet.includes('derived, unverified')).length
  return { unverified, total: bullets.length, ratio: bullets.length ? unverified / bullets.length : 0 }
}

function negationBeforeVerb(line, verb) {
  const match = line.match(verb)
  if (!match) return false
  const clause = line.slice(0, match.index).split(/[,;.!?]/).pop() ?? ''
  // A negation governing the risky verb turns the sentence into a safety prohibition.
  return /\b(?:never|do not|don't|must not|mustn't|should not|shouldn't|cannot|can't|no|without)\b/i.test(clause)
    || /\b(?:is forbidden|is prohibited|refuse to)\b/i.test(clause)
}

function logicalBlocks(text) {
  const lines = text.split(LINE_ENDING_PATTERN)
  const blocks = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1
      continue
    }
    const first = index
    const collected = [lines[index]]
    const fenced = FENCE_PATTERN.test(lines[index])
    const comment = lines[index].includes('<!--')
    index += 1
    while (index < lines.length) {
      const line = lines[index]
      if (fenced && FENCE_PATTERN.test(line)) {
        collected.push(line)
        index += 1
        break
      }
      if (comment && line.includes('-->')) {
        collected.push(line)
        index += 1
        break
      }
      if (!fenced && !comment && (TOP_LEVEL_BULLET_PATTERN.test(line)
        || !line.trim() || H2_PATTERN.test(line) || FENCE_PATTERN.test(line)
        || line.includes('<!--'))) break
      collected.push(line)
      index += 1
    }
    blocks.push({ line: first + 1, text: collected.join(' ') })
  }
  return blocks
}

function riskViolations(text) {
  // The shared scanner is intentionally broad; retain its findings except where this
  // authored-skill gate proves a negated prohibition or a non-risky review context.
  const findings = scanSkillRisk(text).findings.filter(({ line, pattern }) => {
    const source = text.split(LINE_ENDING_PATTERN)[line - 1] ?? ''
    if (negationBeforeVerb(source, /\b(?:ignore|override|disregard|skip|bypass|disable)\b/i)) return false
    if (pattern === 'bypass-review-or-safety' && !EXTRA_RISK_PATTERNS[1].pattern.test(source)) return false
    return true
  })
  const scanNames = new Set(['override-instructions', 'bypass-review-or-safety', 'download-piped-to-shell'])
  const extra = logicalBlocks(text).flatMap(({ line, text: block }) => EXTRA_RISK_PATTERNS
    .filter(({ pattern, verb }) => pattern.test(block) && !negationBeforeVerb(block, verb))
    .filter(({ name }) => !findings.some((finding) => (
      finding.line >= line && finding.line < line + block.split(LINE_ENDING_PATTERN).length
        && ((name === 'instruction-override' && finding.pattern === 'override-instructions')
          || (name === 'review-bypass' && finding.pattern === 'bypass-review-or-safety')
          || (name === 'download-piped-to-shell' && finding.pattern === 'download-piped-to-shell'))
        && scanNames.has(finding.pattern)
    )))
    .map(({ name }) => ({ pattern: name, line, excerpt: block.trim().slice(0, 160) })))
  return [...findings, ...extra].map(({ pattern, line, excerpt }) => (
    `risk:${pattern} line ${line}: ${excerpt}`
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

  const description = parsed.frontmatterLines
    .map((line) => line.match(DESCRIPTION_FIELD_PATTERN)?.[1] ?? '')
    .find((value) => value !== '') ?? ''
  // Block scalars are already rejected by frontmatterViolations; only plain values need length checks.
  const descriptionFindings = description && !BLOCK_SCALAR_DESCRIPTION_PATTERN.test(description)
    && (description.trim().length < 40 || description.trim().length > 400)
    ? ['frontmatter description must be a single line of 40–400 characters'] : []
  return [
    ...frontmatterFindings,
    ...descriptionFindings,
    ...servesFindings,
    ...sectionFindings,
    ...ruleBearingSectionViolations(bodyLines),
    ...provenanceViolations(bodyLines),
    ...authoredRuleViolations(bodyLines),
    ...concreteSourceViolations(bodyLines),
    ...riskViolations(text),
  ]
}

/** Run the skill-lint command and return its process exit code. */
export function runCli(args) {
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !args[0]) {
    console.error(`skill-lint: ${USAGE}`)
    return EXIT_VIOLATIONS
  }

  const skillPath = args[0]
  let maxUnverified = null
  if (args.length > 1) {
    if (args.length !== 3 || args[1] !== '--max-unverified') {
      console.error(`skill-lint: ${USAGE}`)
      return EXIT_VIOLATIONS
    }
    maxUnverified = Number(args[2])
    if (!Number.isFinite(maxUnverified) || maxUnverified < 0 || maxUnverified > 1) {
      console.error('skill-lint: --max-unverified must be a ratio from 0 to 1')
      return EXIT_VIOLATIONS
    }
  }
  let text
  try {
    text = readFileSync(skillPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`skill-lint: cannot read ${skillPath}: ${message}`)
    return EXIT_VIOLATIONS
  }

  const share = unverifiedShare(text)
  console.log(`skill-lint: unverified: ${share.unverified}/${share.total} (${(share.ratio * 100).toFixed(0)}%)`)
  const shareViolations = maxUnverified !== null && share.ratio > maxUnverified
    ? [`unverified share ${(share.ratio * 100).toFixed(0)}% exceeds ${(maxUnverified * 100).toFixed(0)}%`] : []
  const violations = [...lintSkillText(text), ...shareViolations]
  for (const violation of violations) console.error(`skill-lint: ${violation}`)
  if (violations.length > 0) return EXIT_VIOLATIONS

  console.log(`skill-lint: OK ${skillPath}`)
  return EXIT_OK
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) process.exitCode = runCli(process.argv.slice(2))
