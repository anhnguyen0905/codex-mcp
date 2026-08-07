// Generates a bounded authoring brief for one skill facet from the effective
// requirements and the project context recorded in PLAN.md.
//
// Usage: node scripts/skill-brief.mjs --facet <name> [--requirements <path>]
//   [--plan <path>] [--rids R2.1,R2.3] [--out <path>]

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseRequirements } from './requirements-coverage.mjs'

export const BRIEF_TOKEN_BUDGET = 2000

const EXIT_OK = 0
const EXIT_FAILURE = 1
const DEFAULT_REQUIREMENTS_PATH = '.codex-flow/REQUIREMENTS.md'
const DEFAULT_PLAN_PATH = '.codex-flow/PLAN.md'
const ALLOWED_OPTIONS = new Set(['--facet', '--requirements', '--plan', '--rids', '--out'])
const RID_PATTERN = /^R\d+\.\d+$/i
const HEAD_SHA_PATTERN = /^[0-9a-f]{4,64}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const POINTER = (count) =>
  `- (+${count} lower-priority items omitted — read .codex-flow/PLAN.md and REQUIREMENTS.md)`

const tokensOf = (text) => Math.ceil(text.length / 4)
const escapedPattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function validatedCriteria(requirements) {
  if (!Array.isArray(requirements)) throw new TypeError('requirements must be an array')
  return requirements.flatMap((requirement) => {
    if (!requirement || !Array.isArray(requirement.criteria)) {
      throw new TypeError('each requirement must contain a criteria array')
    }
    return requirement.criteria.map((criterion) => {
      if (!criterion || typeof criterion.id !== 'string' || typeof criterion.clause !== 'string') {
        throw new TypeError('each criterion must contain string id and clause fields')
      }
      if (!RID_PATTERN.test(criterion.id) || !criterion.clause.trim()) {
        throw new TypeError('each criterion must contain a valid R-ID and non-empty clause')
      }
      return { id: criterion.id.toUpperCase(), clause: criterion.clause }
    })
  })
}

function validatedFacet(facet) {
  if (typeof facet !== 'string' || !facet.trim()) {
    throw new TypeError('facet must be a non-empty string')
  }
  if (CONTROL_CHARACTER_PATTERN.test(facet)) {
    throw new Error('facet must not contain control characters')
  }
  return facet
}

const facetTokens = (facet) => validatedFacet(facet).split(/[-\s]+/).filter(Boolean)

function criterionMatches(clause, tokens) {
  return tokens.some((token) => token.length < 5
    ? new RegExp(`\\b${escapedPattern(token)}\\b`, 'i').test(clause)
    : clause.toLowerCase().includes(token.toLowerCase()))
}

/** Select effective criteria by explicit R-ID order or facet-token matching. */
export function selectCriteria(requirements, facet, rids = null) {
  const criteria = validatedCriteria(requirements)
  const tokens = facetTokens(facet)
  if (rids === null || rids === undefined) {
    return criteria.filter(({ clause }) => criterionMatches(clause, tokens))
  }
  if (!Array.isArray(rids)) throw new TypeError('rids must be an array when provided')
  const normalizedRids = rids.map((id) => {
    if (typeof id !== 'string' || !RID_PATTERN.test(id)) throw new Error(`invalid --rids ID ${id}`)
    return id.toUpperCase()
  })
  const duplicate = normalizedRids.find((id, index) => normalizedRids.indexOf(id) !== index)
  if (duplicate) throw new Error(`duplicate --rids ID ${duplicate}`)
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]))
  const unknown = normalizedRids.find((id) => !criteriaById.has(id))
  if (unknown) throw new Error(`unknown --rids ID ${unknown}`)
  return normalizedRids.map((id) => ({ ...criteriaById.get(id) }))
}

/** Convert a facet name to the filename fragment required by the CLI contract. */
export function facetSlug(facet) {
  if (typeof facet !== 'string') throw new TypeError('facet must be a string')
  return facet.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '')
}

function validatedBrief(input) {
  if (!input || typeof input !== 'object') throw new TypeError('brief input must be an object')
  facetTokens(input.facet)
  if (!Array.isArray(input.criteria)) throw new TypeError('criteria must be an array')
  const rawWarnings = input.warnings ?? []
  const projectContext = input.projectContext ?? null
  const headSha = input.headSha ?? null
  const omittedCount = input.omittedCount ?? 0
  if (!Array.isArray(rawWarnings)) throw new TypeError('warnings must be an array')
  const requirements = [{ criteria: input.criteria }]
  const criteria = validatedCriteria(requirements)
  const warnings = rawWarnings.map((warning) => {
    if (typeof warning !== 'string' || !warning.trim()) {
      throw new TypeError('warnings must contain non-empty strings')
    }
    return warning
  })
  if (projectContext !== null && typeof projectContext !== 'string') {
    throw new TypeError('projectContext must be a string or null')
  }
  if (headSha !== null && (typeof headSha !== 'string' || !HEAD_SHA_PATTERN.test(headSha))) {
    throw new TypeError('headSha must be a hexadecimal SHA or null')
  }
  if (input.includeProjectContext !== undefined && typeof input.includeProjectContext !== 'boolean') {
    throw new TypeError('includeProjectContext must be a boolean when provided')
  }
  if (!Number.isInteger(omittedCount) || omittedCount < 0) {
    throw new TypeError('omittedCount must be a non-negative integer')
  }
  return { ...input, criteria, warnings, projectContext, headSha, omittedCount }
}

function provenanceScaffold() {
  return [
    '## Provenance (fill from Step 7c)',
    '- Cite the source for every researched claim: `Source: <URL or reference>`.',
    '- Label every unsourced conclusion `derived, unverified`.',
  ].join('\n')
}

/** Render one complete brief without applying the token budget. */
export function renderBrief(input) {
  const brief = validatedBrief(input)
  const anchor = brief.headSha ?? 'null'
  const parts = [
    `<!-- generated by skill-brief.mjs — do not hand-edit; source of truth: .codex-flow/REQUIREMENTS.md + .codex-flow/PLAN.md; anchor: ${anchor} -->`,
    `# Skill authoring brief — ${brief.facet}`,
  ]
  if (brief.warnings.length) {
    parts.push(`## Warning\n${brief.warnings.map((warning) => `- ${warning}`).join('\n')}`)
  }
  const criterionLines = brief.criteria.map(({ id, clause }) => `- ${id}: ${clause}`)
  parts.push(['## Facet gap', ...criterionLines].join('\n'))
  const context = brief.projectContext?.trim() ?? ''
  if (brief.includeProjectContext !== false && context) {
    parts.push(`## Project context\n${context}`)
  }
  parts.push(provenanceScaffold())
  if (brief.omittedCount) parts.push(POINTER(brief.omittedCount))
  return `${parts.join('\n\n')}\n`
}

function validateTokenBudget(tokenBudget) {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) {
    throw new TypeError('tokenBudget must be a positive integer')
  }
}

/** Fit a brief by dropping context, then criteria from the end, as whole items. */
export function fitBrief(input, tokenBudget = BRIEF_TOKEN_BUDGET) {
  validateTokenBudget(tokenBudget)
  const brief = validatedBrief(input)
  let criteria = [...brief.criteria]
  let includesContext = brief.includeProjectContext !== false && Boolean(brief.projectContext?.trim())
  const dropped = []

  while (true) {
    const markdown = renderBrief({
      ...brief,
      criteria,
      includeProjectContext: includesContext,
      omittedCount: dropped.length,
    })
    const tokens = tokensOf(markdown)
    if (tokens <= tokenBudget) return { markdown, tokens, dropped: [...dropped] }
    if (includesContext) {
      includesContext = false
      dropped.push('Project context')
      continue
    }
    if (criteria.length) {
      dropped.push(criteria.at(-1).id)
      criteria = criteria.slice(0, -1)
      continue
    }
    throw new Error(
      `mandatory brief content exceeds tokenBudget ${tokenBudget} (measured ${tokens} tokens)`,
    )
  }
}

function parseCliArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array')
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!ALLOWED_OPTIONS.has(option)) throw new Error(`unknown argument ${option ?? ''}`.trim())
    if (options.has(option)) throw new Error(`duplicate argument ${option}`)
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw new Error(`${option} requires exactly one value`)
    }
    options.set(option, value)
  }
  if (!options.has('--facet')) throw new Error('--facet requires exactly one value')
  return options
}

function parseRids(value) {
  if (value === undefined) return null
  const rids = value.split(',').map((id) => id.trim())
  if (rids.some((id) => !RID_PATTERN.test(id))) {
    throw new Error('--rids must be a comma-separated list of R<n>.<m> IDs')
  }
  return rids
}

function readOptionalFile(filePath, missingWarning) {
  try {
    return { text: readFileSync(filePath, 'utf8'), warning: null }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { text: null, warning: missingWarning }
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read ${filePath}: ${message}`)
  }
}

function projectContextOf(planText) {
  if (typeof planText !== 'string') throw new TypeError('planText must be a string')
  const headings = [...planText.matchAll(/^##[ \t]+([^\r\n]+?)[ \t]*\r?$/gm)]
  const contextIndex = headings.findIndex((heading) => heading[1].trim() === 'Context')
  if (contextIndex === -1) return null
  const heading = headings[contextIndex]
  const start = heading.index + heading[0].length
  const end = headings[contextIndex + 1]?.index ?? planText.length
  return planText.slice(start, end).trim() || null
}

function headShaOf(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return HEAD_SHA_PATTERN.test(sha) ? sha : null
  } catch (error) {
    return null
  }
}

function resolvedPaths(options, cwd, slug) {
  const fromCwd = (value) => path.resolve(cwd, value)
  return {
    requirements: fromCwd(options.get('--requirements') ?? DEFAULT_REQUIREMENTS_PATH),
    plan: fromCwd(options.get('--plan') ?? DEFAULT_PLAN_PATH),
    out: fromCwd(options.get('--out') ?? `.codex-flow/SKILL-BRIEF-${slug}.md`),
  }
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return filePath
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot resolve ${filePath}: ${message}`)
  }
}

function validateOutputPath(paths) {
  if (existsSync(paths.out) && lstatSync(paths.out).isSymbolicLink()) {
    throw new Error('--out must not be a symlink')
  }
  const outputPath = canonicalPath(paths.out)
  if (outputPath === canonicalPath(paths.requirements)) {
    throw new Error('--out must not overwrite the requirements input')
  }
  if (outputPath === canonicalPath(paths.plan)) {
    throw new Error('--out must not overwrite the plan input')
  }
}

/** Execute the CLI synchronously and return its process exit code. */
export function runCli(args, cwd = process.cwd()) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('cwd must be a non-empty string')
  const options = parseCliArgs(args)
  const facet = validatedFacet(options.get('--facet')).trim()
  const slug = facetSlug(facet)
  if (!slug) throw new Error('--facet must contain at least one ASCII letter or digit')
  const paths = resolvedPaths(options, path.resolve(cwd), slug)
  validateOutputPath(paths)
  const requirementsFile = readOptionalFile(
    paths.requirements,
    'REQUIREMENTS.md is missing; no effective criteria are available.',
  )
  const planFile = readOptionalFile(
    paths.plan,
    'PLAN.md is missing; project context is unavailable.',
  )
  const requirements = requirementsFile.text === null
    ? []
    : parseRequirements(requirementsFile.text)
  const criteria = selectCriteria(requirements, facet, parseRids(options.get('--rids')))
  const projectContext = planFile.text === null ? null : projectContextOf(planFile.text)
  const warnings = [requirementsFile.warning, planFile.warning].filter(Boolean)
  if (planFile.text !== null && projectContext === null) {
    warnings.push('PLAN.md has no non-empty ## Context section; project context is unavailable.')
  }
  if (criteria.length === 0) warnings.push(`No matching R-IDs were found for facet "${facet}".`)
  const fitted = fitBrief({
    facet,
    criteria,
    projectContext,
    warnings,
    headSha: headShaOf(path.resolve(cwd)),
  })
  mkdirSync(path.dirname(paths.out), { recursive: true })
  const temporaryPath = `${paths.out}.tmp-${process.pid}`
  try {
    writeFileSync(temporaryPath, fitted.markdown, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryPath, paths.out)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch (cleanupError) {
      if (!cleanupError || typeof cleanupError !== 'object' || cleanupError.code !== 'ENOENT') {
        throw cleanupError
      }
    }
    throw error
  }
  return EXIT_OK
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`skill-brief: ${message}`)
    process.exitCode = EXIT_FAILURE
  }
}
