import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseTasks } from './task-waves.mjs'

export const TASK_SLICE_TOKEN_BUDGET = 4000
export const RESUME_TOKEN_BUDGET = 8000
export const RECENCY_FLOOR_BLOCKS = 3
export const MANDATORY_TIER_CEILING = 2000
export const CONTRACTS_INDEX_TOKEN_CAP = 600
export const CONTRACTS_INDEX_LINE_CHAR_CAP = 160

export { parseTasks }

const DECISION_FIELDS = [
  'Decision',
  'Why',
  'Constraint for later tasks',
  'Contracts touched',
]
const APPLIES_TO_FIELD = 'Applies to'
const PARSED_DECISION_FIELDS = [...DECISION_FIELDS, APPLIES_TO_FIELD, 'Anchor']
const TASK_BLOCK_ID = /^T\d+$/
const CONTRACT_LABEL = /\b[A-Z]+\d+\b/g
const FILE_REFERENCE = /(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]+(?::\d+(?:-\d+)?)?/g
const GIT_OBJECT_NAME = /^[0-9a-fA-F]{4,64}$/
const MAX_MARKDOWN_FENCE_INDENT = 3
const MIN_MARKDOWN_FENCE_LENGTH = 3
const RESUME_PREAMBLE = '> Assume interruption: read this file fully before acting; treat [verify] blocks as hypotheses to re-confirm against the current code.'
const OPTIONAL_PRIORITY = {
  SESSION_REPORT: 1,
  DIGEST: 2,
  DECISION: 3,
  SCOPED_DECISION: 4,
  KNOWN_RED: 5,
  OBJECTIVE: 6,
  OUT_OF_SCOPE: 6,
  CONTRACTS: 7,
}
const DROPPED_BLOCK_ID_CAP = 10
const RESUME_CANDIDATE_SECTIONS = new Set([
  'Contracts',
  'Objective',
  'Out of scope',
  'Decision log',
  'Known-red baseline',
  'Session report',
])
const TEST_FILE_REFERENCE = /(?:^|[\s`'"(])(?:\.{0,2}\/)?[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*\.(?:test|spec)\.[cm]?[jt]sx?(?=$|[:\s`'")])/i
const KNOWN_RED_NOISE = /^(?:at\s|error\b|caused by\b|expected\b|received\b|stdout\b|stderr\b|console\b|\^+\s*$)/i
const KNOWN_RED_MARKER = /^(?:[-*]\s*)?(?:fail(?:ed)?\b|[×✗✕●❯])|\btest\b.*\b(?:fail|error|broken)\b/i

/** Estimate token usage with the repository's four-characters-per-token heuristic. */
export function tokensOf(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  return Math.ceil(text.length / 4)
}

function sectionsOf(planText) {
  const headingPattern = /^##[ \t]+([^\r\n]+?)[ \t]*\r?$/gm
  const headings = [...planText.matchAll(headingPattern)]
  return new Map(
    headings.map((heading, index) => {
      const nextHeading = headings[index + 1]
      const sectionEnd = nextHeading?.index ?? planText.length
      return [heading[1].trim(), planText.slice(heading.index, sectionEnd).trimEnd()]
    }),
  )
}

function fieldsOf(raw, blockId) {
  const fields = new Map()
  const fieldNames = PARSED_DECISION_FIELDS.map(escapedPattern).join('|')
  const fieldPattern = new RegExp(`^[ \\t]*-[ \\t]*(${fieldNames}):[ \\t]*(.*)$`, 'gm')

  for (const match of raw.matchAll(fieldPattern)) {
    if (fields.has(match[1])) throw new Error(`decision block ${blockId} has duplicate ${match[1]} field`)
    fields.set(match[1], match[2].trim())
  }
  for (const field of DECISION_FIELDS) {
    if (!fields.get(field)) throw new Error(`decision block ${blockId} is missing ${field}`)
  }
  if (fields.has('Anchor') && !fields.get('Anchor')) {
    throw new Error(`decision block ${blockId} has an empty Anchor`)
  }
  return fields
}

function decisionBlocksOf(decisionSection) {
  const headingPattern = /^###[ \t]+(.+?)[ \t]+—[ \t]+([^\r\n]+?)[ \t]*\r?$/gm
  const headings = [...decisionSection.matchAll(headingPattern)]

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1]
    const blockEnd = nextHeading?.index ?? decisionSection.length
    const raw = decisionSection.slice(heading.index, blockEnd).trimEnd()
    const id = heading[1].trim()
    const fields = fieldsOf(raw, id)
    return {
      id,
      title: heading[2].trim(),
      decision: fields.get('Decision'),
      why: fields.get('Why'),
      constraint: fields.get('Constraint for later tasks'),
      contracts: fields.get('Contracts touched'),
      anchor: fields.get('Anchor') ?? null,
      appliesTo: fields.get(APPLIES_TO_FIELD) ?? null,
      raw,
    }
  })
}

/** Parse PLAN.md sections and the structured blocks under its Decision log. */
export function parsePlan(planText) {
  if (typeof planText !== 'string') throw new TypeError('planText must be a string')
  const sections = sectionsOf(planText)
  const decisionBlocks = decisionBlocksOf(sections.get('Decision log') ?? '')
  return { sections, decisionBlocks }
}

/** Return one task's raw TASKS.md block, ending at the next level-two heading. */
export function taskRawOf(tasksText, taskId) {
  if (typeof tasksText !== 'string') throw new TypeError('tasksText must be a string')
  if (typeof taskId !== 'string' || !/^T\d+$/i.test(taskId)) {
    throw new TypeError('taskId must match T<n>')
  }

  const normalizedTaskId = taskId.toUpperCase()
  const headings = [...tasksText.matchAll(/^##[ \t]+([^\r\n]+?)[ \t]*\r?$/gm)]
  const matches = headings.flatMap((heading, index) => {
    const taskHeading = heading[1].match(/^(T\d+):/i)
    return taskHeading?.[1].toUpperCase() === normalizedTaskId ? [{ heading, index }] : []
  })
  if (matches.length === 0) throw new Error(`task ${normalizedTaskId} is missing from tasksText`)
  if (matches.length > 1) throw new Error(`task ${normalizedTaskId} appears more than once in tasksText`)

  const [{ heading, index }] = matches
  const sectionEnd = headings[index + 1]?.index ?? tasksText.length
  return tasksText.slice(heading.index, sectionEnd).trimEnd()
}

function escapedPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasToken(text, token) {
  const boundary = '[^A-Za-z0-9_./-]'
  return new RegExp(`(^|${boundary})${escapedPattern(token)}(?=$|${boundary})`).test(text)
}

function hasTokenIgnoringCase(text, token) {
  const boundary = '[^A-Za-z0-9_./-]'
  return new RegExp(`(^|${boundary})${escapedPattern(token)}(?=$|${boundary})`, 'i').test(text)
}

function fileIsMentioned(text, filePath) {
  const normalized = filePath.replace(/^\.\//, '').replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  const basename = segments.at(-1)
  if (!basename) return false
  if (hasTokenIgnoringCase(text, normalized) || hasTokenIgnoringCase(text, basename)) return true

  const prefixes = segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join('/')}/`)
  if (prefixes.some((prefix) => hasTokenIgnoringCase(text, prefix))) return true

  const references = text.match(FILE_REFERENCE) ?? []
  return references.some((reference) => normalizeReference(reference).startsWith(`${normalized}/`))
}

function contractLabelsOf(raw) {
  return [...new Set((raw.match(CONTRACT_LABEL) ?? []).map((label) => label.toUpperCase()))]
    .filter((label) => !TASK_BLOCK_ID.test(label))
}

function validateFilterInput(blocks, task, recencyFloor, taskRaw) {
  if (!Array.isArray(blocks)) throw new TypeError('blocks must be an array')
  if (!task || typeof task !== 'object') throw new TypeError('task must be an object')
  if (!Array.isArray(task.files) || task.files.some((file) => typeof file !== 'string' || !file.trim())) {
    throw new TypeError('task.files must be an array of non-empty strings')
  }
  if (task.raw !== undefined && typeof task.raw !== 'string') {
    throw new TypeError('task.raw must be a string when provided')
  }
  if (taskRaw !== undefined && typeof taskRaw !== 'string') {
    throw new TypeError('taskRaw must be a string when provided')
  }
  if (!Number.isInteger(recencyFloor) || recencyFloor < 0) {
    throw new TypeError('recencyFloor must be a non-negative integer')
  }
  for (const [index, block] of blocks.entries()) {
    const isValid = block && typeof block === 'object' && typeof block.id === 'string' &&
      typeof block.constraint === 'string' && typeof block.contracts === 'string' &&
      (block.appliesTo === undefined || block.appliesTo === null || typeof block.appliesTo === 'string')
    if (!isValid) throw new TypeError(`block ${index + 1} must have id, constraint, and contracts strings`)
  }
}

function appliesToTask(appliesTo, task, labels) {
  if (typeof appliesTo !== 'string' || !appliesTo.trim()) return false
  if (hasTokenIgnoringCase(appliesTo, 'all')) return true
  if (hasTokenIgnoringCase(appliesTo, task.id)) return true
  if (task.files.some((filePath) => fileIsMentioned(appliesTo, filePath))) return true
  return labels.some((label) => hasToken(appliesTo, label))
}

function explicitlyScopedBlocksForTask(blocks, task, taskRaw) {
  const labels = contractLabelsOf(task.raw ?? taskRaw ?? '')
  return new Set(blocks.filter((block) => appliesToTask(block.appliesTo, task, labels)))
}

/** Select task-relevant decision blocks by explicit scope, text relevance, then recency. */
export function filterBlocksForTask(
  blocks,
  task,
  { recencyFloor = RECENCY_FLOOR_BLOCKS, taskRaw } = {},
) {
  validateFilterInput(blocks, task, recencyFloor, taskRaw)
  const labels = contractLabelsOf(task.raw ?? taskRaw ?? '')
  const recentStart = Math.max(0, blocks.length - recencyFloor)

  return blocks.filter((block, index) => {
    if (appliesToTask(block.appliesTo, task, labels)) return true
    const relevantText = `${block.constraint}\n${block.contracts}`
    if (task.files.some((filePath) => fileIsMentioned(relevantText, filePath))) return true
    if (labels.some((label) => hasToken(relevantText, label))) return true
    return index >= recentStart
  })
}

function normalizeReference(reference) {
  return reference.replace(/^\.\//, '').replace(/:\d+(?:-\d+)?$/, '')
}

function validateFileList(files, name) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !file.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`)
  }
  return new Set(files.map(normalizeReference))
}

function blockTextOf(block) {
  if (typeof block.raw === 'string') return block.raw
  return ['decision', 'why', 'constraint', 'contracts']
    .map((field) => block[field])
    .filter((value) => typeof value === 'string')
    .join('\n')
}

/** Classify an anchored block against committed and dirty file changes. */
export function stalenessOf(block, { headSha, changedFiles, dirtyFiles }) {
  if (!block || typeof block !== 'object') throw new TypeError('block must be an object')
  if (headSha !== null && headSha !== undefined && typeof headSha !== 'string') {
    throw new TypeError('headSha must be a string, null, or undefined')
  }
  const changed = validateFileList(changedFiles, 'changedFiles')
  const dirty = validateFileList(dirtyFiles, 'dirtyFiles')
  if (block.anchor === null || block.anchor === undefined) return 'verify'
  if (typeof block.anchor !== 'string' || !block.anchor.trim()) {
    throw new TypeError('block.anchor must be a non-empty string, null, or undefined')
  }

  const blockText = blockTextOf(block)
  const changedPaths = [...changed, ...dirty]
  if (changedPaths.some((filePath) => fileIsMentioned(blockText, filePath))) return 'verify'
  const references = blockText.match(FILE_REFERENCE) ?? []
  const hasChangedReference = references
    .map(normalizeReference)
    .some((reference) => changed.has(reference) || dirty.has(reference))
  return hasChangedReference ? 'verify' : 'fresh'
}

/** Create a non-throwing git seam rooted at cwd. */
export function defaultGit(cwd = process.cwd()) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('cwd must be a non-empty string')

  const gitLines = (args, failureValue = []) => {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    } catch {
      return failureValue
    }
  }

  const gitPaths = (args) => {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const paths = output.split('\0')
      return paths.at(-1) === '' ? paths.slice(0, -1) : paths
    } catch {
      return null
    }
  }

  return {
    headSha: () => gitLines(['rev-parse', 'HEAD'], null)?.[0] ?? null,
    isAncestor: (sha) => {
      if (typeof sha !== 'string' || !GIT_OBJECT_NAME.test(sha)) return null
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
          cwd,
          stdio: ['ignore', 'ignore', 'ignore'],
        })
        return true
      } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 1) return false
        return null
      }
    },
    changedFilesSince: (sha) => typeof sha === 'string' && GIT_OBJECT_NAME.test(sha)
      ? gitPaths(['diff', '--name-only', '-z', `${sha}..HEAD`])
      : null,
    dirtyFiles: () => {
      const probes = [
        gitPaths(['diff', '--name-only', '-z']),
        gitPaths(['diff', '--cached', '--name-only', '-z']),
        gitPaths(['ls-files', '-z', '--others', '--exclude-standard']),
      ]
      if (probes.some((files) => files === null)) return null
      return [...new Set(probes.flat())]
    },
  }
}

function validateGitSeam(git) {
  const methods = ['headSha', 'isAncestor', 'changedFilesSince', 'dirtyFiles']
  if (!git || typeof git !== 'object' || methods.some((method) => typeof git[method] !== 'function')) {
    throw new TypeError('git must provide headSha, isAncestor, changedFilesSince, and dirtyFiles functions')
  }
  return git
}

function gitStateOf(git) {
  const seam = validateGitSeam(git)
  const rawHeadSha = seam.headSha()
  const headSha = typeof rawHeadSha === 'string' && GIT_OBJECT_NAME.test(rawHeadSha)
    ? rawHeadSha
    : null
  const dirtyFiles = seam.dirtyFiles()
  if (dirtyFiles !== null) validateFileList(dirtyFiles, 'git.dirtyFiles()')
  return { seam, headSha, dirtyFiles }
}

function stampedBlockItems(blocks, gitState, explicitlyScopedBlocks = new Set()) {
  const { seam, headSha, dirtyFiles } = gitState
  const changesByAnchor = new Map()

  return blocks.map((block) => {
    const hasVerifiableAnchor = headSha && typeof block.anchor === 'string' && GIT_OBJECT_NAME.test(block.anchor)
    if (hasVerifiableAnchor && !changesByAnchor.has(block.anchor)) {
      const isAncestor = seam.isAncestor(block.anchor)
      const changedFiles = isAncestor === true ? seam.changedFilesSince(block.anchor) : null
      changesByAnchor.set(block.anchor, changedFiles)
    }
    const comparison = hasVerifiableAnchor ? changesByAnchor.get(block.anchor) : null
    const isUnverifiable = comparison === null || dirtyFiles === null
    const anchoredBlock = isUnverifiable ? { ...block, anchor: null } : block
    const changedFiles = comparison ?? []
    const state = stalenessOf(anchoredBlock, { headSha, changedFiles, dirtyFiles: dirtyFiles ?? [] })
    return {
      name: `Decision ${block.id}`,
      blockId: block.id,
      section: 'Decision log',
      markdown: block.raw.replace(/^###[ \t]+/, `### [${state}] `),
      priority: explicitlyScopedBlocks.has(block)
        ? OPTIONAL_PRIORITY.SCOPED_DECISION
        : OPTIONAL_PRIORITY.DECISION,
    }
  })
}

function firstParagraphOf(section) {
  if (!section) return null
  const lines = section.split(/\r?\n/)
  const heading = lines.shift()
  while (lines[0]?.trim() === '') lines.shift()
  if (lines.length === 0) return heading

  let digestEnd = 0
  while (digestEnd < lines.length && lines[digestEnd].trim() !== '') digestEnd += 1

  let bulletStart = digestEnd
  while (lines[bulletStart]?.trim() === '') bulletStart += 1
  if (/^[ \t]*-[ \t]+/.test(lines[bulletStart] ?? '')) {
    digestEnd = bulletStart
    while (digestEnd < lines.length) {
      if (!/^[ \t]*-[ \t]+/.test(lines[digestEnd])) break
      digestEnd += 1
      while (digestEnd < lines.length && /^[ \t]+\S/.test(lines[digestEnd])) digestEnd += 1

      const nextItem = digestEnd
      while (lines[digestEnd]?.trim() === '') digestEnd += 1
      if (!/^[ \t]*-[ \t]+/.test(lines[digestEnd] ?? '')) {
        digestEnd = nextItem
        break
      }
    }
  }

  if (digestEnd === lines.length) return section
  return `${heading}\n${lines.slice(0, digestEnd).join('\n')}`
}

function compactKnownRed(section) {
  const [heading, ...bodyLines] = section.split(/\r?\n/)
  const identifiers = bodyLines.flatMap((rawLine) => {
    if (/^\s+(?:at\b|❯.*:\d+:\d+)/i.test(rawLine)) return []
    const line = rawLine.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim()
    if (!line || KNOWN_RED_NOISE.test(line)) return []
    const isClearBaseline = /^(?:[-*]\s*)?(?:none\b|no known-red\b|all\b.*\b(?:pass|green)\b)/i.test(line)
    if (isClearBaseline) return ['None.']
    return TEST_FILE_REFERENCE.test(line) || KNOWN_RED_MARKER.test(line) ? [line] : []
  })
  const compactLines = [...new Set(identifiers)]
  if (compactLines.length) return `${heading}\n${compactLines.join('\n')}`
  return `${heading}\n- See .codex-flow/PLAN.md Known-red baseline for unparsed details.`
}

function contractsAreReferenced(contracts, task, taskRaw) {
  if (!contracts) return false
  if (task.files.some((filePath) => fileIsMentioned(contracts, filePath))) return true
  if (hasToken(contracts, task.id)) return true
  return contractLabelsOf(taskRaw).some((label) => hasToken(contracts, label))
}

function openingFenceOf(line) {
  const indentation = line.match(/^ */)[0].length
  if (indentation > MAX_MARKDOWN_FENCE_INDENT) return null
  const match = line.slice(indentation).match(/^(`+|~+)(.*)$/)
  if (!match || match[1].length < MIN_MARKDOWN_FENCE_LENGTH) return null
  if (match[1][0] === '`' && match[2].includes('`')) return null
  return { character: match[1][0], length: match[1].length }
}

function isClosingFence(line, fence) {
  const indentation = line.match(/^ */)[0].length
  if (indentation > MAX_MARKDOWN_FENCE_INDENT) return false
  const match = line.slice(indentation).match(/^(`+|~+)[ \t]*$/)
  if (!match || match[1][0] !== fence.character) return false
  return match[1].length >= fence.length
}

function contractUnitsOf(section) {
  const newline = section.indexOf('\n')
  if (newline === -1) return null
  const heading = section.slice(0, newline)
  const lines = section.slice(newline + 1).split(/\r?\n/)
  const blocks = []
  let current = []
  let fence = null

  const flush = (type) => {
    const markdown = current.join('\n').trim()
    if (markdown) blocks.push({ markdown, type })
    current = []
  }

  for (const line of lines) {
    if (fence) {
      current.push(line)
      if (isClosingFence(line, fence)) {
        flush('fence')
        fence = null
      }
      continue
    }
    const openingFence = openingFenceOf(line)
    if (openingFence) {
      flush('prose')
      fence = openingFence
      current.push(line)
      continue
    }
    if (!line.trim()) {
      flush('prose')
      continue
    }
    current.push(line)
  }
  if (fence) return null
  flush('prose')

  const units = []
  let groupedBlocks = []
  let underSubheading = false
  let previousType = null
  const flushGroup = () => {
    const markdown = groupedBlocks.map((block) => block.markdown).join('\n\n')
    if (markdown) units.push(markdown)
    groupedBlocks = []
    underSubheading = false
  }

  for (const block of blocks) {
    const startsSubheading = /^###[ \t]+/.test(block.markdown)
    if (startsSubheading) {
      flushGroup()
      groupedBlocks.push(block)
      underSubheading = true
    } else if (underSubheading) {
      groupedBlocks.push(block)
    } else if (block.type === 'fence' && previousType === 'prose') {
      groupedBlocks.push(block)
    } else {
      flushGroup()
      groupedBlocks.push(block)
    }
    previousType = block.type
  }
  flushGroup()
  return units.length > 1 ? { heading, units } : null
}

function contractIndexUnitsOf(section) {
  if (!section) return []
  const lines = section.split(/\r?\n/).slice(1)
  const units = []
  let current = []
  const flush = () => {
    const unit = current.join('\n').trim()
    if (unit) units.push(unit)
    current = []
  }
  for (const line of lines) {
    if (!line.trim()) {
      flush()
      continue
    }
    const startsContract = /^(?:[-*]\s+|#{3,}\s+)?[A-Z]+\d+\b/.test(line.trim())
    if (startsContract && current.length) flush()
    current.push(line)
  }
  flush()
  return units
}

function firstContractSentence(unit, label) {
  const prose = unit.split(/\r?\n/)
    .filter((line) => !/^\s*(?:`{3,}|~{3,})/.test(line))
    .map((line) => line.trim())
    .join(' ')
    .replace(/^(?:[-*]\s+|#{3,}\s+)?/, '')
    .replace(new RegExp(`^${escapedPattern(label)}(?:\\s*[:—-])?\\s*`, 'i'), '')
    .trim()
  if (!prose) return 'See .codex-flow/PLAN.md Contracts section.'
  return prose.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? prose
}

function earliestDecisionAnchorOf(decisionBlocks) {
  return decisionBlocks.find(
    (block) => typeof block.anchor === 'string' && GIT_OBJECT_NAME.test(block.anchor),
  )?.anchor ?? null
}

function planComparisonOf(gitState, decisionBlocks) {
  const { seam, headSha, dirtyFiles } = gitState
  const anchor = earliestDecisionAnchorOf(decisionBlocks)
  if (!anchor || !headSha || dirtyFiles === null || seam.isAncestor(anchor) !== true) return null
  const changedFiles = seam.changedFilesSince(anchor)
  if (changedFiles === null) return null
  validateFileList(changedFiles, 'git.changedFilesSince()')
  return { anchor, headSha, changedFiles, dirtyFiles }
}

function truncateIndexLine(line) {
  if (line.length <= CONTRACTS_INDEX_LINE_CHAR_CAP) return line
  return `${line.slice(0, CONTRACTS_INDEX_LINE_CHAR_CAP - 1)}…`
}

function contractsIndexItem(contracts, decisionBlocks, gitState) {
  const comparison = planComparisonOf(gitState, decisionBlocks)
  const entries = new Map()
  for (const unit of contractIndexUnitsOf(contracts)) {
    for (const label of contractLabelsOf(unit)) {
      if (!entries.has(label)) entries.set(label, { label, unit })
    }
  }
  const lines = [...entries.values()].map(({ label, unit }) => {
    const state = comparison ? stalenessOf({ anchor: comparison.anchor, raw: unit }, comparison) : 'verify'
    return truncateIndexLine(`- ${label}: [${state}] ${firstContractSentence(unit, label)}`)
  })
  const fallbackState = comparison ? 'fresh' : 'verify'
  if (!lines.length) {
    lines.push(`- Contracts: [${fallbackState}] See .codex-flow/PLAN.md Contracts section.`)
  }
  const markdown = `## Contracts index\n${lines.join('\n')}`
  const cappedMarkdown = tokensOf(markdown) > CONTRACTS_INDEX_TOKEN_CAP
    ? '## Contracts index\n- Contracts: [verify] See .codex-flow/PLAN.md Contracts section (index too large).'
    : markdown
  return {
    name: 'Contracts index',
    section: 'Contracts',
    markdown: cappedMarkdown,
    mandatory: true,
  }
}

function contractsExcerptOf(contracts, task, taskRaw) {
  const structure = contractUnitsOf(contracts)
  if (!structure) return { markdown: contracts, droppedRemainder: false }
  const labels = contractLabelsOf(taskRaw)
  const relevantUnits = structure.units.filter((unit) => {
    if (task.files.some((filePath) => fileIsMentioned(unit, filePath))) return true
    if (hasToken(unit, task.id)) return true
    return labels.some((label) => hasToken(unit, label))
  })
  if (relevantUnits.length === 0) return { markdown: contracts, droppedRemainder: false }
  return {
    markdown: `${structure.heading}\n${relevantUnits.join('\n\n')}`,
    droppedRemainder: relevantUnits.length < structure.units.length,
  }
}

function pointerFor(droppedItems) {
  const sections = [...new Set(droppedItems.map((item) => item.section))].join(', ')
  const budgetDroppedBlockIds = droppedItems.flatMap((item) => item.blockId ? [item.blockId] : [])
  const filteredBlockIds = droppedItems.flatMap((item) => item.blockIds ?? [])
  const visibleBlockIds = [...new Set([...budgetDroppedBlockIds, ...filteredBlockIds])]
  const additionalBlockCount = droppedItems.reduce(
    (total, item) => total + (item.additionalBlockCount ?? 0),
    0,
  )
  const additionalBlockSuffix = additionalBlockCount ? `, +${additionalBlockCount} more` : ''
  const blockSuffix = visibleBlockIds.length
    ? ` (dropped blocks: ${visibleBlockIds.join(', ')}${additionalBlockSuffix})`
    : ''
  return `- (+${droppedItems.length} lower-priority items omitted — read .codex-flow/PLAN.md ${sections})${blockSuffix}`
}

function generatedHeader(headSha) {
  return `<!-- generated by context-slice.mjs — do not hand-edit; source of truth: .codex-flow/PLAN.md; anchor: ${headSha ?? 'null'} -->`
}

function renderItems(items, droppedItems, headSha, preamble = null) {
  const parts = [preamble, generatedHeader(headSha), ...items.map((item) => item.markdown)].filter(Boolean)
  if (droppedItems.length) parts.push(pointerFor(droppedItems))
  return `${parts.join('\n\n')}\n`
}

function validateTokenBudget(tokenBudget) {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) {
    throw new TypeError('tokenBudget must be a positive integer')
  }
}

function fitToBudget(items, tokenBudget, headSha, preDroppedItems = [], preamble = null) {
  validateTokenBudget(tokenBudget)
  let included = [...items]
  const droppedItems = [...preDroppedItems]

  while (true) {
    const markdown = renderItems(included, droppedItems, headSha, preamble)
    const tokens = tokensOf(markdown)
    if (tokens <= tokenBudget) {
      return { markdown, tokens, dropped: droppedItems.map((item) => item.name) }
    }
    const optionalItems = included.filter((item) => !item.mandatory)
    if (optionalItems.length === 0) {
      throw new Error(`mandatory slice content exceeds tokenBudget ${tokenBudget} (measured ${tokens} tokens)`)
    }
    const lowestPriority = Math.min(...optionalItems.map((item) => item.priority))
    const removeIndex = included.findIndex((item) => !item.mandatory && item.priority === lowestPriority)
    droppedItems.push(included[removeIndex])
    included = included.filter((_, index) => index !== removeIndex)
  }
}

function assertTaskRawWithinCeiling(taskItem) {
  const tokens = tokensOf(taskItem.markdown)
  if (tokens <= MANDATORY_TIER_CEILING) return
  throw new Error(
    `mandatory slice content exceeds tokenBudget ${MANDATORY_TIER_CEILING} ` +
    `(measured ${tokens} tokens)`,
  )
}

function decisionRemainderItem(decisionBlocks, filteredBlocks) {
  const included = new Set(filteredBlocks)
  const excludedBlockIds = decisionBlocks
    .filter((block) => !included.has(block))
    .map((block) => block.id)
  return {
    name: 'Decision log remainder',
    section: 'Decision log',
    blockIds: excludedBlockIds.slice(0, DROPPED_BLOCK_ID_CAP),
    additionalBlockCount: Math.max(0, excludedBlockIds.length - DROPPED_BLOCK_ID_CAP),
  }
}

function taskPlanItems(sections, decisionBlocks, task, taskRaw, gitState) {
  const items = []
  const omittedItems = []
  const handledSections = new Set()
  const contracts = sections.get('Contracts')
  if (contractsAreReferenced(contracts, task, taskRaw)) {
    const excerpt = contractsExcerptOf(contracts, task, taskRaw)
    items.push({ name: 'Contracts', section: 'Contracts', markdown: excerpt.markdown, priority: OPTIONAL_PRIORITY.CONTRACTS })
    handledSections.add('Contracts')
    if (excerpt.droppedRemainder) {
      omittedItems.push({ name: 'Contracts remainder', section: 'Contracts' })
    }
  }
  const outOfScope = sections.get('Out of scope')
  if (outOfScope) {
    items.push({ name: 'Out of scope', section: 'Out of scope', markdown: outOfScope, priority: OPTIONAL_PRIORITY.OUT_OF_SCOPE })
    handledSections.add('Out of scope')
  }
  const filteredBlocks = filterBlocksForTask(decisionBlocks, task, { taskRaw })
  const explicitlyScopedBlocks = explicitlyScopedBlocksForTask(filteredBlocks, task, taskRaw)
  items.push(...stampedBlockItems(filteredBlocks, gitState, explicitlyScopedBlocks))
  handledSections.add('Decision log')
  if (sections.has('Decision log') && decisionBlocks.length === 0) {
    omittedItems.push({ name: 'Decision log', section: 'Decision log' })
  } else if (filteredBlocks.length < decisionBlocks.length) {
    omittedItems.push(decisionRemainderItem(decisionBlocks, filteredBlocks))
  }
  for (const name of ['Context', 'Objective']) {
    const section = sections.get(name)
    const digest = firstParagraphOf(section)
    if (!digest) continue
    const priority = name === 'Objective' ? OPTIONAL_PRIORITY.OBJECTIVE : OPTIONAL_PRIORITY.DIGEST
    items.push({ name: `${name} digest`, section: name, markdown: digest, priority })
    handledSections.add(name)
    if (digest !== section) omittedItems.push({ name: `${name} remainder`, section: name })
  }
  const knownRed = sections.get('Known-red baseline')
  if (knownRed) {
    items.push({ name: 'Known-red baseline', section: 'Known-red baseline', markdown: compactKnownRed(knownRed), priority: OPTIONAL_PRIORITY.KNOWN_RED })
    handledSections.add('Known-red baseline')
  }
  for (const name of sections.keys()) {
    if (!handledSections.has(name)) omittedItems.push({ name, section: name })
  }
  return { items, omittedItems }
}

function validateSliceText(planText, tasksText) {
  if (typeof planText !== 'string') throw new TypeError('planText must be a string')
  if (typeof tasksText !== 'string') throw new TypeError('tasksText must be a string')
}

/** Render a deterministic, budgeted PLAN.md slice for one task. */
export function sliceForTask(
  planText,
  tasksText,
  taskId,
  { tokenBudget = TASK_SLICE_TOKEN_BUDGET, git = defaultGit() } = {},
) {
  validateSliceText(planText, tasksText)
  validateTokenBudget(tokenBudget)
  const gitState = gitStateOf(git)
  if (typeof taskId !== 'string' || !/^T\d+$/i.test(taskId)) {
    throw new TypeError('taskId must match T<n>')
  }
  const { sections, decisionBlocks } = parsePlan(planText)
  const tasks = parseTasks(tasksText)
  const normalizedTaskId = taskId.toUpperCase()
  const task = tasks.find((candidate) => candidate.id === normalizedTaskId)
  if (!task) throw new Error(`task ${taskId ?? '<missing>'} is missing from tasksText`)
  const taskRaw = taskRawOf(tasksText, task.id)
  const taskItem = { name: `Task ${task.id}`, section: `task ${task.id}`, markdown: taskRaw, mandatory: true }
  assertTaskRawWithinCeiling(taskItem)
  const items = [
    taskItem,
    contractsIndexItem(sections.get('Contracts'), decisionBlocks, gitState),
  ]
  const planItems = taskPlanItems(sections, decisionBlocks, task, taskRaw, gitState)
  items.push(...planItems.items)
  return fitToBudget(items, tokenBudget, gitState.headSha, planItems.omittedItems)
}

function taskRecordsOf(tasksText) {
  const tasks = parseTasks(tasksText)
  if (tasks.length === 0) throw new Error('no tasks found in tasksText')
  return tasks.map((task) => {
    const raw = taskRawOf(tasksText, task.id)
    return { task, raw, status: task.status }
  })
}

function statusItemOf(records) {
  const lines = records.map(({ task, raw, status }) => {
    const session = status === 'in-progress'
      ? raw.match(/^[ \t]*-[ \t]*Session:[ \t]*(.*)$/mi)?.[1].trim()
      : null
    return `- ${task.id} — Status: ${status}${session ? ` — Session: ${session}` : ''}`
  })
  return {
    name: 'Task statuses',
    section: 'task statuses',
    markdown: `## Task statuses\n${lines.join('\n')}`,
    mandatory: true,
  }
}

function resumeDecisionSelection(decisionBlocks, unfinishedRecords) {
  const included = new Set()
  const explicitlyScoped = new Set()
  for (const { task, raw } of unfinishedRecords) {
    for (const block of filterBlocksForTask(decisionBlocks, task, { taskRaw: raw })) included.add(block)
    for (const block of explicitlyScopedBlocksForTask(decisionBlocks, task, raw)) {
      explicitlyScoped.add(block)
    }
  }
  return {
    blocks: decisionBlocks.filter((block) => included.has(block)),
    explicitlyScoped,
  }
}

function resumeOmissionsOf(sections, decisionBlocks, filteredBlocks) {
  const omittedItems = [...sections.keys()]
    .filter((name) => !RESUME_CANDIDATE_SECTIONS.has(name))
    .map((name) => ({ name, section: name }))
  if (sections.has('Decision log') && decisionBlocks.length === 0) {
    omittedItems.push({ name: 'Decision log', section: 'Decision log' })
  } else if (filteredBlocks.length < decisionBlocks.length) {
    omittedItems.push(decisionRemainderItem(decisionBlocks, filteredBlocks))
  }
  return omittedItems
}

/** Render a deterministic, budgeted resume slice for all remaining tasks. */
export function sliceForResume(
  planText,
  tasksText,
  { tokenBudget = RESUME_TOKEN_BUDGET, git = defaultGit() } = {},
) {
  validateSliceText(planText, tasksText)
  validateTokenBudget(tokenBudget)
  const gitState = gitStateOf(git)
  const { sections, decisionBlocks } = parsePlan(planText)
  const records = taskRecordsOf(tasksText)
  const unfinishedRecords = records.filter(({ status }) => status !== 'done')
  const items = [statusItemOf(records)]
  if (unfinishedRecords[0]) {
    items.push({
      name: `Next task ${unfinishedRecords[0].task.id}`,
      section: `task ${unfinishedRecords[0].task.id}`,
      markdown: unfinishedRecords[0].raw,
      mandatory: true,
    })
  }
  items.push(contractsIndexItem(sections.get('Contracts'), decisionBlocks, gitState))
  for (const name of ['Contracts', 'Objective', 'Out of scope']) {
    const section = sections.get(name)
    const priority = name === 'Contracts'
      ? OPTIONAL_PRIORITY.CONTRACTS
      : name === 'Out of scope' ? OPTIONAL_PRIORITY.OUT_OF_SCOPE : OPTIONAL_PRIORITY.OBJECTIVE
    if (section) items.push({ name, section: name, markdown: section, priority })
  }
  const decisionSelection = resumeDecisionSelection(decisionBlocks, unfinishedRecords)
  const filteredBlocks = decisionSelection.blocks
  items.push(...stampedBlockItems(filteredBlocks, gitState, decisionSelection.explicitlyScoped))
  for (const name of ['Known-red baseline', 'Session report']) {
    const section = sections.get(name)
    if (!section) continue
    const priority = name === 'Known-red baseline'
      ? OPTIONAL_PRIORITY.KNOWN_RED
      : OPTIONAL_PRIORITY.SESSION_REPORT
    const markdown = name === 'Known-red baseline' ? compactKnownRed(section) : section
    items.push({ name, section: name, markdown, priority })
  }
  const omittedItems = resumeOmissionsOf(sections, decisionBlocks, filteredBlocks)
  return fitToBudget(items, tokenBudget, gitState.headSha, omittedItems, RESUME_PREAMBLE)
}

async function assertNotSymlink(targetPath, label) {
  try {
    const stats = await fs.lstat(targetPath)
    if (stats.isSymbolicLink()) throw new Error(`${label} is a symlink — refusing to write through it`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing')) throw error
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

export async function writeFileAtomically(outputPath, contents) {
  const outputDirectory = path.dirname(outputPath)
  const outputName = path.basename(outputPath)
  const temporaryPath = path.join(
    outputDirectory,
    `.${outputName}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' })
    await assertNotSymlink(outputPath, 'output file')
    await fs.rename(temporaryPath, outputPath)
  } catch (error) {
    try {
      await fs.rm(temporaryPath, { force: true })
    } catch {
      // Preserve the primary write error when best-effort cleanup also fails.
    }
    throw error
  }
}

function parseCliArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('CLI args must be an array of strings')
  }
  const config = { taskId: null, resume: false, plan: '.codex-flow/PLAN.md', tasks: '.codex-flow/TASKS.md', out: '.codex-flow' }
  const valuedFlags = new Set(['--task', '--plan', '--tasks', '--out'])
  const seen = new Set()

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (seen.has(flag)) throw new Error(`duplicate flag ${flag}`)
    seen.add(flag)
    if (flag === '--resume') {
      config.resume = true
      continue
    }
    if (!valuedFlags.has(flag)) throw new Error(`unknown flag ${flag}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--task') config.taskId = value
    if (flag === '--plan') config.plan = value
    if (flag === '--tasks') config.tasks = value
    if (flag === '--out') config.out = value
    index += 1
  }
  if (config.resume === Boolean(config.taskId)) throw new Error('provide exactly one of --task T<n> or --resume')
  if (config.taskId && !/^T\d+$/i.test(config.taskId)) throw new Error(`invalid task id ${config.taskId}`)
  return config
}

/** Execute the context-slice CLI and return the written absolute path. */
export async function main(args = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('cwd must be a non-empty string')
  const config = parseCliArgs(args)
  const planPath = path.resolve(cwd, config.plan)
  const tasksPath = path.resolve(cwd, config.tasks)
  const outputDirectory = path.resolve(cwd, config.out)
  const [planText, tasksText] = await Promise.all([
    fs.readFile(planPath, 'utf8'),
    fs.readFile(tasksPath, 'utf8'),
  ])
  const git = defaultGit(cwd)
  const slice = config.resume
    ? sliceForResume(planText, tasksText, { git })
    : sliceForTask(planText, tasksText, config.taskId, { git })
  const outputName = config.resume ? 'RESUME.md' : `CONTEXT-${config.taskId.toUpperCase()}.md`
  const outputPath = path.join(outputDirectory, outputName)
  await assertNotSymlink(outputDirectory, 'output directory')
  await fs.mkdir(outputDirectory, { recursive: true })
  await assertNotSymlink(outputDirectory, 'output directory')
  await assertNotSymlink(outputPath, 'output file')
  await writeFileAtomically(outputPath, slice.markdown)
  return outputPath
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  main()
    .then((outputPath) => console.log(outputPath))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`context-slice: ${message.replace(/\s+/g, ' ')}`)
      process.exitCode = 1
    })
}
