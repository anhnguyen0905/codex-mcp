// Validates that every effective REQUIREMENTS.md criterion is assigned to at
// least one TASKS.md task and that tasks cite only effective criterion IDs.
//
// Usage: node scripts/requirements-coverage.mjs \
//   --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIREMENT_HEADING = /^##\s+(R\d+):\s*(.+?)\s*$/i
const CRITERION_BULLET = /^\s*-\s*(R\d+\.\d+):\s*(.+?)\s*$/i
const CRITERION_LIKE_BULLET = /^\s*-\s*(R\d+\.\d+)\b/i
const DELTAS_HEADING = /^##\s+Deltas\s*$/i
const DELTA_HEADING =
  /^###\s+\d{4}-\d{2}-\d{2}(?:T\S+)?\s+(ADDED|MODIFIED|REMOVED)\s+(R\d+(?:\.\d+)?)\s*$/i
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
    const heading = line.match(/^##\s+(T\d+):\s*.*$/i)
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

/** Report uncovered effective criteria and citations to unknown criterion IDs. */
export function coverageOf(requirements, tasksText) {
  const validRequirements = validateRequirements(requirements)
  const effectiveIds = validRequirements.flatMap(
    (requirement) => requirement.criteria.map(({ id }) => id),
  )
  const effectiveSet = new Set(effectiveIds)
  const citations = taskCitations(tasksText)
  const covered = new Set(citations.flatMap(({ ids }) => ids).filter((id) => effectiveSet.has(id)))
  const unknown = citations.flatMap(({ taskId, ids }) => ids
    .filter((id) => !effectiveSet.has(id))
    .map((id) => ({ taskId, id })))
  return { uncovered: effectiveIds.filter((id) => !covered.has(id)), unknown }
}

function optionValue(args, option) {
  const indexes = args.flatMap((argument, index) => argument === option ? [index] : [])
  if (indexes.length !== 1 || !args[indexes[0] + 1] || args[indexes[0] + 1].startsWith('--')) {
    throw new Error(`${option} requires exactly one path`)
  }
  return args[indexes[0] + 1]
}

async function runCli(args) {
  const requirementsPath = path.resolve(optionValue(args, '--requirements'))
  const tasksPath = path.resolve(optionValue(args, '--tasks'))
  const [requirementsText, tasksText] = await Promise.all([
    fs.readFile(requirementsPath, 'utf8').catch((error) => {
      throw new Error(`cannot read ${requirementsPath}: ${error.message}`)
    }),
    fs.readFile(tasksPath, 'utf8').catch((error) => {
      throw new Error(`cannot read ${tasksPath}: ${error.message}`)
    }),
  ])
  const requirements = parseRequirements(requirementsText)
  const coverage = coverageOf(requirements, tasksText)
  for (const id of coverage.uncovered) console.error(`requirements-coverage: uncovered criterion ${id}`)
  for (const { taskId, id } of coverage.unknown) console.error(`requirements-coverage: ${taskId} cites unknown criterion ${id}`)
  if (coverage.uncovered.length || coverage.unknown.length) return EXIT_VIOLATIONS
  const criterionCount = requirements.reduce((count, requirement) => count + requirement.criteria.length, 0)
  console.log(`requirements-coverage: OK — ${criterionCount} effective criteria covered; no unknown citations`)
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
