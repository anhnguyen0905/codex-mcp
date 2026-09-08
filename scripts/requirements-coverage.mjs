// Validates that every effective REQUIREMENTS.md criterion is assigned to at
// least one TASKS.md task and that tasks cite only effective criterion IDs.
// With --plan, also validates that every PLAN.md `A<n>` acceptance entry is
// cited by at least one task's `Acceptance:` field via `satisfies A<n>`.
//
// Usage: node scripts/requirements-coverage.mjs \
//   --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md \
//   [--plan .codex-flow/PLAN.md]

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIREMENT_HEADING = /^##\s+(R\d+):\s*(.+?)\s*$/i
const CRITERION_BULLET = /^\s*-\s*(R\d+\.\d+):\s*(.+?)\s*$/i
const CRITERION_LIKE_BULLET = /^\s*-\s*(R\d+\.\d+)\b/i
const DELTAS_HEADING = /^##\s+Deltas\s*$/i
const DELTA_HEADING =
  /^###\s+\d{4}-\d{2}-\d{2}(?:T\S+)?\s+(ADDED|MODIFIED|REMOVED)\s+(R\d+(?:\.\d+)?)\s*$/i
const TASK_HEADING = /^##\s+(T\d+):\s*.*$/i
const ACCEPTANCE_BULLET =
  /^\s*-\s*(A\d+)\s+\(covers\s+(R\d+\.\d+(?:\s*,\s*R\d+\.\d+)*)\):\s*(\S.*?)\s*$/i
const ACCEPTANCE_LIKE_BULLET = /^\s*-\s*(A\d+)\b/i
const TASK_ACCEPTANCE_FIELD = /^\s*-\s*Acceptance:\s*(.*)$/i
const SATISFIES_CITATION = /\bsatisfies\s+(\S.*?)\s*$/i
const ACCEPTANCE_ID = /^A\d+$/i
const EXIT_OK = 0
const EXIT_VIOLATIONS = 1

const normalizedId = (id) => id.toUpperCase()
const requirementIdOf = (criterionId) => criterionId.split('.')[0]

function parseBase(lines, deltasIndex) {
  const requirements = []
  let current = null

  for (const line of lines.slice(0, deltasIndex)) {
    const heading = line.match(REQUIREMENT_HEADING)
    if (heading) {
      const id = normalizedId(heading[1])
      if (requirements.some((requirement) => requirement.id === id)) {
        throw new Error(`duplicate requirement ${id}`)
      }
      current = { id, title: heading[2].trim(), criteria: [] }
      requirements.push(current)
      continue
    }
    if (/^##\s+R\d+\b/i.test(line)) {
      throw new Error(`malformed requirement heading: ${line.trim()}`)
    }
    if (/^##\s+/.test(line)) {
      current = null
      continue
    }
    const criterion = line.match(CRITERION_BULLET)
    const criterionLike = line.match(CRITERION_LIKE_BULLET)
    if (criterionLike && !criterion) {
      const id = normalizedId(criterionLike[1])
      throw new Error(`malformed criterion ${id}: expected "- R<n>.<m>: <clause>"`)
    }
    if (!criterion) continue
    if (!current) throw new Error(`${normalizedId(criterion[1])} is outside a requirement section`)
    const id = normalizedId(criterion[1])
    if (requirementIdOf(id) !== current.id) throw new Error(`${id} is not under ${current.id}`)
    if (current.criteria.some((entry) => entry.id === id)) {
      throw new Error(`duplicate criterion ${id}`)
    }
    current.criteria.push({ id, clause: criterion[2].trim() })
  }
  return requirements
}

function parseDeltas(lines, deltasIndex) {
  const deltas = []
  let current = null

  for (const line of lines.slice(deltasIndex + 1)) {
    const heading = line.match(DELTA_HEADING)
    if (heading) {
      current = { kind: heading[1].toUpperCase(), id: normalizedId(heading[2]), clauseLines: [] }
      deltas.push(current)
      continue
    }
    if (/^#{1,6}\s+/.test(line) || CRITERION_LIKE_BULLET.test(line)) {
      throw new Error(`invalid structure in Deltas section: ${line.trim()}`)
    }
    if (!current && line.trim()) {
      throw new Error(`content before first delta entry: ${line.trim()}`)
    }
    if (current) current.clauseLines.push(line)
  }
  return deltas.map(({ kind, id, clauseLines }) => ({
    kind,
    id,
    clause: clauseLines.join('\n').trim(),
  }))
}

function addDelta(requirements, { id, clause }) {
  if (id.includes('.')) {
    const parent = requirements.find((requirement) => requirement.id === requirementIdOf(id))
    if (!parent) throw new Error(`cannot add ${id}: parent requirement does not exist`)
    if (parent.criteria.some((criterion) => criterion.id === id)) {
      throw new Error(`cannot add duplicate ${id}`)
    }
    return requirements.map((requirement) => requirement.id === parent.id
      ? { ...requirement, criteria: [...requirement.criteria, { id, clause }] }
      : requirement)
  }
  if (requirements.some((requirement) => requirement.id === id)) {
    throw new Error(`cannot add duplicate ${id}`)
  }
  return [...requirements, { id, title: clause, criteria: [] }]
}

function modifyDelta(requirements, { id, clause }) {
  if (!id.includes('.')) {
    const requirement = requirements.find((entry) => entry.id === id)
    if (!requirement) throw new Error(`cannot modify unknown ${id}`)
    return requirements.map((entry) => entry.id === id ? { ...entry, title: clause } : entry)
  }
  const parent = requirements.find((requirement) => requirement.id === requirementIdOf(id))
  const criterion = parent?.criteria.find((entry) => entry.id === id)
  if (!criterion) throw new Error(`cannot modify unknown ${id}`)
  return requirements.map((requirement) => requirement.id === parent.id
    ? { ...requirement, criteria: requirement.criteria.map((entry) => entry.id === id ? { ...entry, clause } : entry) }
    : requirement)
}

function removeDelta(requirements, { id }) {
  if (!id.includes('.')) {
    if (!requirements.some((requirement) => requirement.id === id)) {
      throw new Error(`cannot remove unknown ${id}`)
    }
    return requirements.filter((requirement) => requirement.id !== id)
  }
  const parent = requirements.find((requirement) => requirement.id === requirementIdOf(id))
  if (!parent?.criteria.some((criterion) => criterion.id === id)) {
    throw new Error(`cannot remove unknown ${id}`)
  }
  return requirements.map((requirement) => requirement.id === parent.id
    ? { ...requirement, criteria: requirement.criteria.filter((criterion) => criterion.id !== id) }
    : requirement)
}

function applyDeltas(requirements, deltas) {
  const initial = requirements.map((requirement) => ({
    ...requirement,
    criteria: requirement.criteria.map((criterion) => ({ ...criterion })),
  }))
  return deltas.reduce((effective, delta) => {
    if (delta.kind !== 'REMOVED' && !delta.clause) {
      throw new Error(`${delta.kind} ${delta.id} requires clause text`)
    }
    if (delta.kind === 'ADDED') return addDelta(effective, delta)
    if (delta.kind === 'MODIFIED') return modifyDelta(effective, delta)
    return removeDelta(effective, delta)
  }, initial)
}

function validateRequirements(requirements) {
  const criterionless = requirements.find((requirement) => requirement.criteria.length === 0)
  if (criterionless) throw new Error(`requirement ${criterionless.id} has no criteria`)
  const criterionCount = requirements.reduce(
    (count, requirement) => count + requirement.criteria.length,
    0,
  )
  if (criterionCount === 0) throw new Error('effective requirement set has zero criteria')
  return requirements
}

/** Parse REQUIREMENTS.md and return its ordered, effective requirement set. */
export function parseRequirements(text) {
  const lines = (text ?? '').split(/\r?\n/)
  const deltasIndex = lines.findIndex((line) => DELTAS_HEADING.test(line))
  const baseEnd = deltasIndex === -1 ? lines.length : deltasIndex
  const requirements = parseBase(lines, baseEnd)
  if (deltasIndex === -1) return validateRequirements(requirements)
  return validateRequirements(applyDeltas(requirements, parseDeltas(lines, deltasIndex)))
}

function taskCitations(tasksText) {
  const tasks = []
  let current = null

  for (const line of (tasksText ?? '').split(/\r?\n/)) {
    const heading = line.match(TASK_HEADING)
    if (heading) {
      current = { taskId: normalizedId(heading[1]), ids: [] }
      tasks.push(current)
      continue
    }
    if (/^##\s+/.test(line)) {
      current = null
      continue
    }
    const requirements = line.match(/^\s*-\s*Requirements:\s*(.*)$/i)
    if (!current || !requirements) continue
    current.ids = requirements[1]
      .split(',')
      .map((id) => normalizedId(id.trim()))
      .filter(Boolean)
  }
  return tasks
}

/** Flatten a validated requirement set into its ordered effective criterion IDs. */
export function effectiveCriterionIds(requirements) {
  return validateRequirements(requirements).flatMap(
    (requirement) => requirement.criteria.map(({ id }) => id),
  )
}

/** Report uncovered effective criteria and citations to unknown criterion IDs. */
export function coverageOf(requirements, tasksText) {
  const effectiveIds = effectiveCriterionIds(requirements)
  const effectiveSet = new Set(effectiveIds)
  const citations = taskCitations(tasksText)
  const covered = new Set(citations.flatMap(({ ids }) => ids).filter((id) => effectiveSet.has(id)))
  const unknown = citations.flatMap(({ taskId, ids }) => ids
    .filter((id) => !effectiveSet.has(id))
    .map((id) => ({ taskId, id })))
  return { uncovered: effectiveIds.filter((id) => !covered.has(id)), unknown }
}

/** Parse PLAN.md and return its ordered `A<n>` acceptance entries. */
export function parsePlanAcceptance(planText) {
  const entries = []

  for (const line of (planText ?? '').split(/\r?\n/)) {
    const entry = line.match(ACCEPTANCE_BULLET)
    const entryLike = line.match(ACCEPTANCE_LIKE_BULLET)
    if (entryLike && !entry) {
      throw new Error(
        `malformed acceptance entry ${normalizedId(entryLike[1])}: expected "- A<n> (covers R<n>.<m>[, R<n>.<m>]): <command or probe>"`,
      )
    }
    if (!entry) continue
    const id = normalizedId(entry[1])
    if (entries.some((existing) => existing.id === id)) {
      throw new Error(`duplicate acceptance entry ${id}`)
    }
    entries.push({
      id,
      covers: entry[2].split(',').map((criterionId) => normalizedId(criterionId.trim())),
      command: entry[3].trim(),
    })
  }
  if (entries.length === 0) throw new Error('plan has zero acceptance entries')
  return entries
}

function taskAcceptanceCitations(tasksText) {
  const tasks = []
  let current = null

  for (const line of (tasksText ?? '').split(/\r?\n/)) {
    const heading = line.match(TASK_HEADING)
    if (heading) {
      current = { taskId: normalizedId(heading[1]), ids: [] }
      tasks.push(current)
      continue
    }
    if (/^##\s+/.test(line)) {
      current = null
      continue
    }
    const acceptance = line.match(TASK_ACCEPTANCE_FIELD)
    if (!current || !acceptance) continue
    const citation = acceptance[1].match(SATISFIES_CITATION)
    if (!citation) continue
    // Malformed tokens are kept verbatim so they surface as unknown citations
    // instead of being silently dropped.
    current.ids = [
      ...current.ids,
      ...citation[1]
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => ACCEPTANCE_ID.test(token) ? normalizedId(token) : token),
    ]
  }
  return tasks
}

/** Report orphan plan acceptance entries plus citations to unknown A- and R-IDs. */
export function planCoverageOf(acceptanceEntries, tasksText, criterionIds) {
  if (!Array.isArray(acceptanceEntries) || acceptanceEntries.length === 0) {
    throw new Error('plan has zero acceptance entries')
  }
  const acceptanceIds = new Set(acceptanceEntries.map(({ id }) => id))
  const effectiveSet = new Set(criterionIds ?? [])
  const citations = taskAcceptanceCitations(tasksText)
  const cited = new Set(
    citations.flatMap(({ ids }) => ids).filter((id) => acceptanceIds.has(id)),
  )
  return {
    orphans: acceptanceEntries.map(({ id }) => id).filter((id) => !cited.has(id)),
    unknown: citations.flatMap(({ taskId, ids }) => ids
      .filter((id) => !acceptanceIds.has(id))
      .map((id) => ({ taskId, id }))),
    unknownRequirements: acceptanceEntries.flatMap(({ id, covers }) => covers
      .filter((criterionId) => !effectiveSet.has(criterionId))
      .map((criterionId) => ({ acceptanceId: id, criterionId }))),
  }
}

const KNOWN_OPTIONS = ['--requirements', '--tasks', '--plan']

/**
 * Parse `--requirements <path> --tasks <path> [--plan <path>]` into a flag→path map.
 *
 * Every argument must be a known flag with exactly one path value, and no flag may repeat:
 * silently ignoring an unrecognized argument made a typo like `--planx` skip plan validation
 * and still exit 0, reporting coverage the operator never asked for.
 */
export function parseCliOptions(args) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array')
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    if (!KNOWN_OPTIONS.includes(option)) throw new Error(`unknown argument ${option}`)
    const value = args[index + 1]
    if (values.has(option) || !value || value.startsWith('--')) {
      throw new Error(`${option} requires exactly one path`)
    }
    values.set(option, value)
  }
  return values
}

function optionValue(values, option) {
  const value = values.get(option)
  if (value === undefined) throw new Error(`${option} requires exactly one path`)
  return value
}

const readControlFile = (filePath) => fs.readFile(filePath, 'utf8').catch((error) => {
  throw new Error(`cannot read ${filePath}: ${error.message}`)
})

function reportPlanCoverage(planCoverage) {
  for (const id of planCoverage.orphans) {
    console.error(`requirements-coverage: orphan plan acceptance ${id}`)
  }
  for (const { taskId, id } of planCoverage.unknown) {
    console.error(`requirements-coverage: ${taskId} cites unknown acceptance entry ${id}`)
  }
  for (const { acceptanceId, criterionId } of planCoverage.unknownRequirements) {
    console.error(`requirements-coverage: ${acceptanceId} covers unknown criterion ${criterionId}`)
  }
  return planCoverage.orphans.length
    + planCoverage.unknown.length
    + planCoverage.unknownRequirements.length
}

async function runCli(args) {
  const options = parseCliOptions(args)
  const requirementsPath = path.resolve(optionValue(options, '--requirements'))
  const tasksPath = path.resolve(optionValue(options, '--tasks'))
  const planOption = options.get('--plan')
  const planPath = planOption === undefined ? null : path.resolve(planOption)
  const [requirementsText, tasksText, planText] = await Promise.all([
    readControlFile(requirementsPath),
    readControlFile(tasksPath),
    planPath === null ? Promise.resolve(null) : readControlFile(planPath),
  ])
  const requirements = parseRequirements(requirementsText)
  const coverage = coverageOf(requirements, tasksText)
  for (const id of coverage.uncovered) console.error(`requirements-coverage: uncovered criterion ${id}`)
  for (const { taskId, id } of coverage.unknown) console.error(`requirements-coverage: ${taskId} cites unknown criterion ${id}`)
  const planEntries = planText === null ? null : parsePlanAcceptance(planText)
  const planCoverage = planEntries === null
    ? null
    : planCoverageOf(planEntries, tasksText, effectiveCriterionIds(requirements))
  const planViolationCount = planCoverage === null ? 0 : reportPlanCoverage(planCoverage)
  if (coverage.uncovered.length || coverage.unknown.length || planViolationCount) {
    return EXIT_VIOLATIONS
  }
  const criterionCount = requirements.reduce((count, requirement) => count + requirement.criteria.length, 0)
  console.log(`requirements-coverage: OK — ${criterionCount} effective criteria covered; no unknown citations`)
  if (planEntries) {
    console.log(`requirements-coverage: OK — ${planEntries.length} plan acceptance entries cited by tasks`)
  }
  return EXIT_OK
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      console.error(`requirements-coverage: ${error.message}`)
      process.exitCode = EXIT_VIOLATIONS
    })
}
