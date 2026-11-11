/** Required legacy fields for every Decision-log block. */
export const DECISION_FIELDS = Object.freeze([
  'Decision',
  'Why',
  'Constraint for later tasks',
  'Contracts touched',
])

/** Optional field recognized by the shared Decision-log parser. */
export const APPLIES_TO_FIELD = 'Applies to'

/** All fields that can be parsed from a Decision-log block. */
export const PARSED_DECISION_FIELDS = Object.freeze([...DECISION_FIELDS, 'Anchor', APPLIES_TO_FIELD])

/** Pattern identifying task Decision-log blocks. */
export const TASK_BLOCK_ID = /^T\d+$/

function escapedPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/

/** Replace everything but a trailing carriage return with spaces, keeping the line's length. */
function blanked(line) {
  return line.endsWith('\r') ? `${' '.repeat(line.length - 1)}\r` : ' '.repeat(line.length)
}

/** Blank out fence markers and fenced lines, keeping every offset, so fenced text is never parsed. */
function scannedLines(text) {
  const output = []
  let fence = null
  for (const line of text.split('\n')) {
    const closes = fence && line.match(FENCE_CLOSE)
    if (fence) {
      if (closes && closes[1][0] === fence[0] && closes[1].length >= fence.length) fence = null
      output.push(blanked(line))
      continue
    }
    const opens = line.match(FENCE_OPEN)
    if (opens) fence = opens[1]
    output.push(opens ? blanked(line) : line)
  }
  return output.join('\n')
}

/** One stderr line for a problem reported by decisionLogProblems. */
export function formatDecisionLogProblem(problem) {
  if (problem.kind === 'section') return `duplicate "## Decision log" section at line ${problem.line}`
  if (problem.kind === 'heading') return `"${problem.id}": heading must be "<id> — <title>"`
  return `${problem.id}/${problem.title}: ${problem.kind} ${problem.field}`
}

function nextHeadingIndex(headings, heading) {
  return headings.find((next) => next.index > heading.index)?.index
}

/** Find Decision-log sections (each ends at the next level-two heading) and their line numbers. */
export function decisionLogSectionOf(planText) {
  const masked = scannedLines(planText)
  const headings = [...masked.matchAll(/^##[ \t]+([^\r\n]+?)[ \t]*\r?$/gm)]
  const sections = headings.filter((heading) => heading[1].trim() === 'Decision log')
  return sections.map((heading) => ({
    text: planText.slice(heading.index, nextHeadingIndex(headings, heading) ?? planText.length),
    line: planText.slice(0, heading.index).split('\n').length,
  }))
}

/** Return the sole Decision-log section or throw the slice parser's duplicate error. */
export function decisionLogSectionForSlice(planText) {
  const sections = decisionLogSectionOf(planText)
  if (sections.length > 1) throw new Error(`plan: duplicate "## Decision log" section at line ${sections[1].line}`)
  return sections[0]?.text ?? ''
}

/** Collect every missing or duplicate field in schema order. */
export function decisionFieldProblems(raw, requiredFields = DECISION_FIELDS) {
  const fields = new Map()
  const names = PARSED_DECISION_FIELDS.map(escapedPattern).join('|')
  const pattern = new RegExp(`^[ \\t]*-[ \\t]*(${names}):[ \\t]*(.*)$`, 'gm')
  const duplicates = new Set()
  for (const match of scannedLines(raw).matchAll(pattern)) {
    if (fields.has(match[1])) duplicates.add(match[1])
    fields.set(match[1], match[2].trim())
  }
  const problems = requiredFields
    .filter((field) => !fields.get(field))
    .map((field) => ({ kind: 'missing', field }))
  return [...problems, ...[...duplicates].map((field) => ({ kind: 'duplicate', field }))]
}

/** Parse fields for the slice builder, preserving its existing first-error messages. */
export function decisionFieldsOf(raw, blockId, requiredFields = DECISION_FIELDS) {
  const problems = decisionFieldProblems(raw, requiredFields)
  const first = problems.find((problem) => problem.kind === 'duplicate') ?? problems[0]
  if (first?.kind === 'missing') throw new Error(`decision block ${blockId} is missing ${first.field}`)
  if (first?.kind === 'duplicate') throw new Error(`decision block ${blockId} has duplicate ${first.field} field`)
  const fields = new Map()
  const names = PARSED_DECISION_FIELDS.map(escapedPattern).join('|')
  const pattern = new RegExp(`^[ \\t]*-[ \\t]*(${names}):[ \\t]*(.*)$`, 'gm')
  for (const match of scannedLines(raw).matchAll(pattern)) fields.set(match[1], match[2].trim())
  if (fields.has('Anchor') && !fields.get('Anchor')) {
    throw new Error(`decision block ${blockId} has an empty Anchor`)
  }
  return fields
}

/** Split valid Decision-log headings into blocks used by the slice builder. */
export function decisionBlocksOf(decisionSection) {
  const pattern = /^###[ \t]+(.+?)[ \t]+—[ \t]+([^\r\n]+?)[ \t]*\r?$/gm
  const headings = [...scannedLines(decisionSection).matchAll(pattern)]
  return headings.map((heading, index) => {
    const raw = decisionSection.slice(heading.index, headings[index + 1]?.index ?? decisionSection.length).trimEnd()
    const id = heading[1].trim()
    const fields = decisionFieldsOf(raw, id)
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

function validationBlocksOf(section) {
  const pattern = /^###[ \t]+([^\r\n]+?)[ \t]*\r?$/gm
  const headings = [...scannedLines(section).matchAll(pattern)]
  return headings.map((heading, index) => ({
    heading: heading[1].trim(),
    raw: section.slice(heading.index, headings[index + 1]?.index ?? section.length).trimEnd(),
  }))
}

/** Return all malformed Decision-log blocks without changing the plan. */
export function decisionLogProblems(planText) {
  if (typeof planText !== 'string') throw new TypeError('planText must be a string')
  const sections = decisionLogSectionOf(planText)
  const sectionProblems = sections.slice(1).map((section) => ({ kind: 'section', line: section.line }))
  if (!sections[0]) return []
  const blocks = validationBlocksOf(sections[0].text)
  return [...sectionProblems, ...blocks.flatMap((block) => {
    const parts = block.heading.match(/^([^—]+?)[ \t]+—[ \t]+(.+)$/)
    if (!parts) return [{ id: block.heading, title: '', kind: 'heading' }]
    const id = parts[1].trim()
    const title = parts[2].trim()
    const required = TASK_BLOCK_ID.test(id) ? PARSED_DECISION_FIELDS : DECISION_FIELDS
    return decisionFieldProblems(block.raw, required).map((problem) => ({ id, title, ...problem }))
  })]
}

/** Count the blocks inspected by decisionLogProblems. */
export function decisionLogBlockCount(planText) {
  if (typeof planText !== 'string') throw new TypeError('planText must be a string')
  const [section] = decisionLogSectionOf(planText)
  return section ? validationBlocksOf(section.text).length : 0
}
