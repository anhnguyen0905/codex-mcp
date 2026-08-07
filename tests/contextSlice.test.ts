import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  CONTRACTS_INDEX_LINE_CHAR_CAP,
  CONTRACTS_INDEX_TOKEN_CAP,
  MANDATORY_TIER_CEILING,
  RECENCY_FLOOR_BLOCKS,
  RESUME_TOKEN_BUDGET,
  TASK_SLICE_TOKEN_BUDGET,
  defaultGit,
  filterBlocksForTask,
  parsePlan,
  parseTasks,
  sliceForResume,
  sliceForTask,
  stalenessOf,
  taskRawOf,
  tokensOf,
  writeFileAtomically,
} from '../scripts/context-slice.mjs'

const CONTEXT_SLICE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'context-slice.mjs')
const HEAD_SHA = 'abcdef12'
const FRESH_ANCHOR = 'aaaabbbb'
const CHANGED_ANCHOR = 'ccccdddd'
const tempDirectories: string[] = []
const GIT_AVAILABLE = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

const PLAN = `# Plan: Context slicing

## Context
Keep PLAN.md authoritative.

### Nested context
This remains inside Context.

## Contracts
C1 owns scripts/context-slice.mjs.

## Decision log
### T1 — Add the parser
- Decision: Parse scripts/context-slice.mjs:20 deterministically.
- Why: Slices must be reproducible.
- Constraint for later tasks: Keep scripts/context-slice.mjs pure.
- Contracts touched: C1 confirmed.
- Anchor: abc123

### Final review — Legacy event
- Decision: Review the finished parser.
- Why: Legacy plans predate anchors.
- Constraint for later tasks: Re-check tests/contextSlice.test.ts:1.
- Contracts touched: C1.
`

const LARGE_TASKS = `# Tasks

${Array.from({ length: 20 }, (_, index) => {
  const id = index + 1
  const status = id === 1 ? 'done' : 'pending'
  return `## T${id}: Task ${id}
- Depends on: —
- Files: src/task${id}.ts
- Contract: C${id === 2 ? 2 : id}
- Status: ${status}
`
}).join('\n')}`

const LONG_CONSTRAINT = 'Preserve deterministic path:line pointers and whole-item budget cuts for later tasks. '.repeat(24)
const LARGE_PLAN = `# Plan: Large fixture

## Context
This context paragraph explains the source-of-truth plan.

Additional context is lower priority.

## Objective
Produce deterministic context slices within fixed budgets.

Additional objective detail.

## Contracts
C2 owns src/task2.ts and the shared decision contract.

## Known-red baseline
None.

## Session report
- Report dir: .codex-flow/reports/example

## Decision log
${Array.from({ length: 24 }, (_, index) => `### T${index + 1} — Decision ${index + 1}
- Decision: Keep src/shared.ts:10 as a restorable pointer.
- Why: ${LONG_CONSTRAINT}
- Constraint for later tasks: ${LONG_CONSTRAINT}
- Contracts touched: C2 confirmed.
- Anchor: ${index % 2 === 0 ? FRESH_ANCHOR : CHANGED_ANCHOR}
`).join('\n')}`

const FAKE_GIT = {
  headSha: () => HEAD_SHA,
  isAncestor: () => true,
  changedFilesSince: (sha: string) => sha === CHANGED_ANCHOR ? ['src/shared.ts'] : [],
  dirtyFiles: () => [],
}

function block(id: string, constraint = '—', contracts = '—') {
  return { id, constraint, contracts, anchor: 'abc123', raw: `${constraint}\n${contracts}` }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function runGit(directory: string, args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

function initializeGitRepository(directory: string): void {
  runGit(directory, ['init', '--quiet'])
  runGit(directory, ['config', 'user.email', 'context-slice@example.test'])
  runGit(directory, ['config', 'user.name', 'Context Slice Test'])
}

describe('parsePlan', () => {
  test('slices each level-two section through the next level-two heading', () => {
    const { sections } = parsePlan(PLAN)

    expect([...sections.keys()]).toEqual(['Context', 'Contracts', 'Decision log'])
    expect(sections.get('Context')).toContain('### Nested context')
    expect(sections.get('Context')).not.toContain('## Contracts')
    expect(sections.get('Contracts')).toContain('C1 owns scripts/context-slice.mjs.')
  })

  test('parses anchored and legacy Decision-log blocks', () => {
    const { decisionBlocks } = parsePlan(PLAN)

    expect(decisionBlocks).toHaveLength(2)
    expect(decisionBlocks[0]).toMatchObject({
      id: 'T1',
      title: 'Add the parser',
      decision: 'Parse scripts/context-slice.mjs:20 deterministically.',
      why: 'Slices must be reproducible.',
      constraint: 'Keep scripts/context-slice.mjs pure.',
      contracts: 'C1 confirmed.',
      anchor: 'abc123',
      appliesTo: null,
    })
    expect(decisionBlocks[0].raw).toContain('### T1 — Add the parser')
    expect(decisionBlocks[1]).toMatchObject({ id: 'Final review', anchor: null, appliesTo: null })
  })

  test('parses the optional Applies to field while keeping legacy blocks nullable', () => {
    const scopedPlan = PLAN.replace(
      '- Anchor: abc123',
      "- Anchor: abc123\n- Applies to: T9, scripts/context-slice.mjs, C1",
    )

    const { decisionBlocks } = parsePlan(scopedPlan)

    expect(decisionBlocks[0].appliesTo).toBe('T9, scripts/context-slice.mjs, C1')
    expect(decisionBlocks[1].appliesTo).toBeNull()
  })

  test('rejects malformed plan input and missing required block fields', () => {
    const malformedBlock = `## Decision log
### T1 — Broken
- Decision: Incomplete.
`

    expect(() => parsePlan(null)).toThrow(/planText must be a string/)
    expect(() => parsePlan(malformedBlock)).toThrow(/T1 is missing Why/)
  })
})

describe('filterBlocksForTask', () => {
  test('retains an appliesTo all block for an unrelated task', () => {
    const task = { id: 'T9', files: ['src/unrelated.ts'], raw: '' }
    const blocks = [{ ...block('T1'), appliesTo: 'all' }, block('T2')]

    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 0 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('retains an old block when appliesTo mentions a task file', () => {
    const task = { id: 'T9', files: ['src/core/config.ts'], raw: '' }
    const blocks = [{ ...block('T1'), appliesTo: 'config.ts' }, block('T2')]

    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 0 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('retains an old block when appliesTo mentions the task id', () => {
    const task = { id: 'T9', files: ['src/unrelated.ts'], raw: '' }
    const blocks = [{ ...block('T1'), appliesTo: 'T9' }, block('T2')]

    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 0 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('retains an old block when appliesTo mentions a task contract label', () => {
    const task = { id: 'T9', files: ['src/unrelated.ts'], raw: '- Contract: API2' }
    const blocks = [{ ...block('T1'), appliesTo: 'API2' }, block('T2')]

    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 0 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test.each([
    ['exact path', 'Keep src/core/config.ts stable.'],
    ['path prefix', 'Keep src/core/ stable.'],
    ['basename', 'Keep config.ts stable.'],
  ])('includes a block that mentions a task file by %s', (_label, constraint) => {
    const [parsedTask] = parseTasks('## T9: Config\n- Files: src/core/config.ts\n')
    const blocks = [block('T1', constraint), block('T2')]

    const filtered = filterBlocksForTask(blocks, parsedTask, { recencyFloor: 0 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('includes a block whose contracts field mentions a task file', () => {
    // Arrange
    const [parsedTask] = parseTasks('## T9: Config\n- Files: src/core/config.ts\n')
    const blocks = [block('T1', '—', 'Keep src/core/config.ts stable.'), block('T2')]

    // Act
    const filtered = filterBlocksForTask(blocks, parsedTask, { recencyFloor: 0 })

    // Assert
    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('includes a contract-labelled block using an untouched parseTasks result', () => {
    const tasksText = `# Tasks

## T9: Parser
- Files: unrelated.ts
- Contract: C1

## Notes
- Contract: C2
`
    const [parsedTask] = parseTasks(tasksText)
    const blocks = [block('T1', '—', 'C1 confirmed.'), block('T2', '—', 'C2 confirmed.')]

    const filtered = filterBlocksForTask(blocks, parsedTask, {
      recencyFloor: 0,
      taskRaw: taskRawOf(tasksText, parsedTask.id),
    })

    expect(parsedTask).not.toHaveProperty('raw')
    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1'])
  })

  test('matches uppercase contract labels without treating lowercase tokens as labels', () => {
    // Arrange
    const task = {
      id: 'T9',
      files: ['unrelated.ts'],
      raw: '- Encoding: utf8\n- Contract: API2',
    }
    const blocks = [
      block('T1', '—', 'UTF8 compatibility contract.'),
      block('T2', '—', 'API2 compatibility contract.'),
      block('T3', '—', 'api2 compatibility prose.'),
    ]

    // Act
    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 0 })

    // Assert
    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T2'])
  })

  test('always includes the configured number of most recent blocks', () => {
    const task = { id: 'T9', files: ['unrelated.ts'], raw: '' }
    const blocks = [block('T1'), block('T2'), block('T3'), block('T4')]

    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 2 })

    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T3', 'T4'])
    expect(RECENCY_FLOOR_BLOCKS).toBe(3)
  })

  test('includes the default number of most recent blocks when recencyFloor is omitted', () => {
    // Arrange
    const task = { id: 'T9', files: ['unrelated.ts'], raw: '' }
    const blocks = [block('T1'), block('T2'), block('T3'), block('T4'), block('T5')]

    // Act
    const filtered = filterBlocksForTask(blocks, task)

    // Assert
    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T3', 'T4', 'T5'])
  })

  test('ages out an event block past the recency floor without mutating recursively frozen inputs', () => {
    // Arrange
    const task = deepFreeze({ id: 'T9', files: ['unrelated.ts'], raw: '' })
    const blocks = deepFreeze([block('Wave merge'), block('T1'), block('T2')])
    const original = JSON.stringify({ blocks, task })

    // Act
    const filtered = filterBlocksForTask(blocks, task, { recencyFloor: 2 })

    // Assert
    expect(filtered.map((item: { id: string }) => item.id)).toEqual(['T1', 'T2'])
    expect(filtered).not.toBe(blocks)
    expect(JSON.stringify({ blocks, task })).toBe(original)
  })

  test('keeps legacy blocks on the existing constraint-text matching rule', () => {
    const task = { id: 'T9', files: ['src/core/config.ts'], raw: '' }
    const legacyBlock = block('T1', 'Keep src/core/config.ts stable.')

    const filtered = filterBlocksForTask([legacyBlock], task, { recencyFloor: 0 })

    expect(legacyBlock).not.toHaveProperty('appliesTo')
    expect(filtered).toEqual([legacyBlock])
  })

  test('returns an empty list when no relevance rule matches', () => {
    const task = { id: 'T9', files: ['src/config.ts'], raw: '' }

    const filtered = filterBlocksForTask([block('T1', 'Keep src/server.ts stable.')], task, {
      recencyFloor: 0,
    })

    expect(filtered).toEqual([])
  })
})

describe('taskRawOf', () => {
  test('returns only the requested task block', () => {
    const tasksText = `## T1: First
- Files: one.ts

## T2: Second
- Files: two.ts
`

    const raw = taskRawOf(tasksText, 'T1')

    expect(raw).toContain('## T1: First')
    expect(raw).not.toContain('## T2: Second')
  })

  test('throws when the requested task is missing', () => {
    expect(() => taskRawOf('## T1: First\n- Files: one.ts\n', 'T2')).toThrow(/T2 is missing/)
  })
})

describe('stalenessOf', () => {
  const gitState = { headSha: 'head456', changedFiles: [], dirtyFiles: [] }

  test('returns verify when the block has no anchor', () => {
    const result = stalenessOf({ anchor: null, raw: 'See src/config.ts:10.' }, gitState)

    expect(result).toBe('verify')
  })

  test('returns verify when a referenced file changed after the anchor', () => {
    const block = { anchor: 'abc123', raw: 'Re-check src/config.ts:10 before editing.' }

    const result = stalenessOf(block, { ...gitState, changedFiles: ['src/config.ts'] })

    expect(result).toBe('verify')
  })

  test('returns verify when a referenced file is dirty', () => {
    const block = { anchor: 'abc123', raw: 'Re-check tests/contextSlice.test.ts:90.' }

    const result = stalenessOf(block, { ...gitState, dirtyFiles: ['tests/contextSlice.test.ts'] })

    expect(result).toBe('verify')
  })

  test('returns verify when a referenced changed filename contains spaces', () => {
    // Arrange
    const block = { anchor: 'abc123', raw: 'Re-check committed file.ts before editing.' }

    // Act
    const result = stalenessOf(block, { ...gitState, changedFiles: ['committed file.ts'] })

    // Assert
    expect(result).toBe('verify')
  })

  test('returns fresh when referenced files have not changed', () => {
    const block = { anchor: 'abc123', raw: 'Contract at scripts/context-slice.mjs:40.' }

    const result = stalenessOf(block, { ...gitState, changedFiles: ['src/server.ts'] })

    expect(result).toBe('fresh')
  })
})

describe('tokensOf', () => {
  test('rounds character estimates up to whole tokens and exports fixed budgets', () => {
    expect(tokensOf('')).toBe(0)
    expect(tokensOf('1234')).toBe(1)
    expect(tokensOf('12345')).toBe(2)
    expect(TASK_SLICE_TOKEN_BUDGET).toBe(4000)
    expect(RESUME_TOKEN_BUDGET).toBe(8000)
    expect(MANDATORY_TIER_CEILING).toBe(2000)
    expect(CONTRACTS_INDEX_TOKEN_CAP).toBe(600)
    expect(CONTRACTS_INDEX_LINE_CHAR_CAP).toBe(160)
  })

  test('rejects non-string input', () => {
    expect(() => tokensOf(1234)).toThrow(/text must be a string/)
  })
})

describe('sliceForTask', () => {
  test('always includes a stamped Contracts index and marks a contract verify when its file is dirty', () => {
    // Arrange
    const plan = `## Contracts
- C1: Parser behavior lives in scripts/contract.ts. Additional detail is omitted.
- C2: Review behavior lives in tests/review.test.ts. More detail is omitted.

## Decision log
### T1 — Establish contracts
- Decision: Establish the initial contracts.
- Why: Downstream tasks need stable boundaries.
- Constraint for later tasks: Preserve scripts/contract.ts and tests/review.test.ts.
- Contracts touched: C1, C2.
- Anchor: ${FRESH_ANCHOR}
`
    const tasks = `## T8: Unrelated task
- Files: src/unrelated.ts
- Status: pending
`
    const dirtyGit = { ...FAKE_GIT, dirtyFiles: () => ['scripts/contract.ts'] }

    // Act
    const fresh = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })
    const dirty = sliceForTask(plan, tasks, 'T8', { git: dirtyGit })

    // Assert
    expect(fresh.markdown).toContain('## Contracts index')
    expect(fresh.markdown).toContain('- C1: [fresh] Parser behavior lives in scripts/contract.ts.')
    expect(fresh.markdown).toContain('- C2: [fresh] Review behavior lives in tests/review.test.ts.')
    expect(dirty.markdown).toContain('- C1: [verify] Parser behavior lives in scripts/contract.ts.')
    expect(dirty.markdown).toContain('- C2: [fresh] Review behavior lives in tests/review.test.ts.')
  })

  test('uses a verify-stamped Contracts-section pointer when no contract labels or anchors are detectable', () => {
    // Arrange
    const plan = `## Contracts
The parser must preserve deterministic output without a numbered label.
`
    const tasks = `## T8: Pointer fallback
- Files: src/unrelated.ts
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('## Contracts index')
    expect(result.markdown).toContain('- Contracts: [verify] See .codex-flow/PLAN.md Contracts section.')
    expect(result.dropped).not.toContain('Contracts index')
  })

  test('marks a contract verify when its file changed after the earliest decision anchor', () => {
    const plan = `## Contracts
- C1: Parser behavior lives in scripts/contract.ts.

## Decision log
### T1 — Establish contracts
- Decision: Establish C1.
- Why: The parser needs a stable contract.
- Constraint for later tasks: Preserve scripts/contract.ts.
- Contracts touched: C1.
- Anchor: ${FRESH_ANCHOR}

### T2 — Later decision
- Decision: Confirm unrelated behavior.
- Why: Later work completed.
- Constraint for later tasks: —
- Contracts touched: —
- Anchor: ${CHANGED_ANCHOR}
`
    const tasks = `## T8: Consumer
- Files: src/unrelated.ts
- Status: pending
`
    const changedGit = {
      ...FAKE_GIT,
      changedFilesSince: (sha: string) => sha === FRESH_ANCHOR ? ['scripts/contract.ts'] : [],
    }

    const result = sliceForTask(plan, tasks, 'T8', { git: changedGit })

    expect(result.markdown).toContain('- C1: [verify] Parser behavior lives in scripts/contract.ts.')
  })

  test('marks contract index entries verify when the plan has no valid decision anchors', () => {
    const plan = `## Contracts
- C1: Parser behavior lives in scripts/contract.ts.
`
    const tasks = `## T8: Consumer
- Files: src/unrelated.ts
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    expect(result.markdown).toContain('- C1: [verify] Parser behavior lives in scripts/contract.ts.')
  })

  test('caps contract index lines and degrades an oversized global index to one pointer', () => {
    const longPlan = `## Contracts
- C1: ${'Long contract detail '.repeat(40)}.

## Decision log
### T1 — Establish contracts
- Decision: Establish C1.
- Why: Required.
- Constraint for later tasks: —
- Contracts touched: C1.
- Anchor: ${FRESH_ANCHOR}
`
    const oversizedPlan = `## Contracts
${Array.from({ length: 100 }, (_, index) => `- C${index + 1}: ${'Contract detail '.repeat(20)}.`).join('\n')}

## Decision log
### T1 — Establish contracts
- Decision: Establish the contract set.
- Why: Required.
- Constraint for later tasks: —
- Contracts touched: all.
- Anchor: ${FRESH_ANCHOR}
`
    const tasks = `## T8: Consumer
- Files: src/unrelated.ts
- Status: pending
`

    const longLineResult = sliceForTask(longPlan, tasks, 'T8', { git: FAKE_GIT })
    const oversizedResult = sliceForTask(oversizedPlan, tasks, 'T8', { git: FAKE_GIT })
    const contractLine = longLineResult.markdown.split('\n').find((line) => line.startsWith('- C1:'))

    expect(contractLine).toHaveLength(CONTRACTS_INDEX_LINE_CHAR_CAP)
    expect(contractLine).toMatch(/…$/)
    expect(oversizedResult.markdown).toContain(
      '- Contracts: [verify] See .codex-flow/PLAN.md Contracts section (index too large).',
    )
    expect(oversizedResult.dropped).not.toContain('Contracts index')
  })

  test('excerpts relevant Contracts paragraphs and fences with a restorable remainder pointer', () => {
    // Arrange
    const plan = `## Contracts
API2 governs scripts/context-slice.mjs and its deterministic output.

\`\`\`text
API2 requires atomic replacement for scripts/context-slice.mjs.
\`\`\`

DB4 governs src/database.ts and its migrations.

\`\`\`text
UI3 governs src/dashboard.ts.
\`\`\`
`
    const tasks = `## T8: Refine the slicer
- Files: scripts/context-slice.mjs
- Contract: API2
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('API2 governs scripts/context-slice.mjs')
    expect(result.markdown).toContain('API2 requires atomic replacement')
    expect(result.markdown).not.toContain('DB4 governs src/database.ts')
    expect(result.markdown).not.toContain('UI3 governs src/dashboard.ts')
    expect(result.dropped).toContain('Contracts remainder')
    expect(result.markdown).toMatch(/lower-priority items omitted — read \.codex-flow\/PLAN\.md Contracts/)
  })

  test('keeps an unlabeled fence with its relevant introductory Contracts paragraph', () => {
    // Arrange
    const plan = `## Contracts
API2 is defined in scripts/context-slice.mjs:

\`\`\`ts
export function sliceForTask() {}
\`\`\`

DB4 governs src/database.ts.
`
    const tasks = `## T8: Refine the slicer
- Files: scripts/context-slice.mjs
- Contract: API2
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('API2 is defined in scripts/context-slice.mjs:')
    expect(result.markdown).toContain('```ts\nexport function sliceForTask() {}\n```')
    expect(result.markdown).not.toContain('DB4 governs src/database.ts.')
  })

  test('keeps or drops each Contracts subheading with all of its body content', () => {
    // Arrange
    const plan = `## Contracts
### API2 slicer

The implementation lives in scripts/context-slice.mjs.

\`\`\`ts
export function sliceForTask() {}
\`\`\`

### DB4 database

The implementation lives in src/database.ts.

Migration details belong to this database contract.
`
    const tasks = `## T8: Refine the slicer
- Files: scripts/context-slice.mjs
- Contract: API2
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('### API2 slicer')
    expect(result.markdown).toContain('```ts\nexport function sliceForTask() {}\n```')
    expect(result.markdown).not.toContain('### DB4 database')
    expect(result.markdown).not.toContain('Migration details belong to this database contract.')
  })

  test('keeps the whole Contracts section when it has no detectable sub-structure', () => {
    // Arrange
    const plan = `## Contracts
API2 governs scripts/context-slice.mjs while DB4 governs src/database.ts in the same paragraph.
`
    const tasks = `## T8: Refine the slicer
- Files: scripts/context-slice.mjs
- Contract: API2
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('API2 governs scripts/context-slice.mjs')
    expect(result.markdown).toContain('DB4 governs src/database.ts')
    expect(result.dropped).not.toContain('Contracts remainder')
  })

  test('includes and excerpts Contracts units that reference only the task id', () => {
    // Arrange
    const plan = `## Contracts
T8 owns atomic output behavior.

T7 owns legacy output behavior.
`
    const tasks = `## T8: Refine the slicer
- Files: unrelated.ts
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('## Contracts\nT8 owns atomic output behavior.')
    expect(result.markdown).not.toContain('T7 owns legacy output behavior.')
    expect(result.dropped).toContain('Contracts remainder')
  })

  test('keeps info-string-like lines inside an open Contracts fence', () => {
    // Arrange
    const plan = `## Contracts
\`\`\`text
T8 owns fenced output behavior.
\`\`\`js
This line remains inside the fence.
\`\`\`

T7 owns legacy output behavior.
`
    const tasks = `## T8: Refine the slicer
- Files: unrelated.ts
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T8', { git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('```js\nThis line remains inside the fence.\n```')
    expect(result.markdown).not.toContain('T7 owns legacy output behavior.')
    expect(result.dropped).toContain('Contracts remainder')
  })

  test('includes Out of scope and points to omitted or truncated plan sections', () => {
    const plan = `## Context
Primary context.

Additional context detail.

## Architecture
Use the existing parser boundary.

## Out of scope
Do not change the task parser.

## Acceptance criteria
The focused tests pass.
`
    const tasks = `## T1: Focused change
- Files: scripts/context-slice.mjs
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T1', { git: FAKE_GIT })

    expect(result.markdown).toContain('## Out of scope\nDo not change the task parser.')
    expect(result.markdown).not.toContain('## Architecture\nUse the existing parser boundary.')
    expect(result.dropped).toContain('Architecture')
    expect(result.markdown).toMatch(/lower-priority items omitted — read \.codex-flow\/PLAN\.md [^\n]*Architecture/)
  })

  test('keeps Context convention bullets in the digest and points only to later content', () => {
    const plan = `## Context
This project uses a generated context slice.

- Keep scripts dependency-free.
- Mirror command documentation byte-for-byte.

Implementation history belongs in the full plan.
`
    const tasks = `## T1: Preserve conventions
- Files: scripts/context-slice.mjs
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T1', { git: FAKE_GIT })

    expect(result.markdown).toContain(
      '## Context\nThis project uses a generated context slice.\n\n- Keep scripts dependency-free.\n- Mirror command documentation byte-for-byte.',
    )
    expect(result.markdown).not.toContain('Implementation history belongs in the full plan.')
    expect(result.dropped).toContain('Context remainder')

    const withoutRemainder = sliceForTask(
      plan.replace('\nImplementation history belongs in the full plan.\n', '\n'),
      tasks,
      'T1',
      { git: FAKE_GIT },
    )
    expect(withoutRemainder.dropped).not.toContain('Context remainder')
  })

  test('compacts Known-red identifiers and retains them after decisions are squeezed out', () => {
    // Arrange
    const plan = `## Known-red baseline
FAIL tests/legacy.test.ts > legacy suite > preserves output
Error: expected true to be false
    at tests/legacy.test.ts:42:7
stdout | noisy setup log

## Decision log
### T1 — Verbose decision
- Decision: Preserve src/legacy.ts behavior.
- Why: ${'Decision detail consumes the slice budget. '.repeat(12)}
- Constraint for later tasks: Re-check src/legacy.ts.
- Contracts touched: C1.
- Anchor: ${FRESH_ANCHOR}
`
    const tasks = `## T9: Budgeted task
- Files: src/unrelated.ts
- Status: pending
`

    // Act
    const result = sliceForTask(plan, tasks, 'T9', { tokenBudget: 180, git: FAKE_GIT })

    // Assert
    expect(result.markdown).toContain('FAIL tests/legacy.test.ts > legacy suite > preserves output')
    expect(result.markdown).not.toContain('expected true to be false')
    expect(result.markdown).not.toContain('at tests/legacy.test.ts:42:7')
    expect(result.markdown).not.toContain('noisy setup log')
    expect(result.dropped).toContain('Decision T1')
    expect(result.dropped).not.toContain('Known-red baseline')
  })

  test('fits a long task slice to budget and keeps high-priority state with git stamps', () => {
    const result = sliceForTask(LARGE_PLAN, LARGE_TASKS, 'T2', { git: FAKE_GIT })

    expect(result.tokens).toBe(tokensOf(result.markdown))
    expect(result.tokens).toBeLessThanOrEqual(TASK_SLICE_TOKEN_BUDGET)
    expect(result.markdown).toContain('generated by context-slice.mjs')
    expect(result.markdown).toContain(`anchor: ${HEAD_SHA}`)
    expect(result.markdown).toContain('## T2: Task 2')
    expect(result.markdown).toContain('## Contracts')
    expect(result.markdown).toContain('[fresh]')
    expect(result.markdown).toContain('[verify]')
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(result.markdown).toMatch(/\(\+\d+ lower-priority items omitted — read \.codex-flow\/PLAN\.md/)
  })

  test('throws with a measured token count when the mandatory tier exceeds its ceiling', () => {
    const tasks = `## T1: Oversized
- Files: src/task.ts
- Details: ${'x'.repeat(8_200)}
- Status: pending
`

    expect(() => sliceForTask('## Context\nSmall.\n', tasks, 'T1', { git: FAKE_GIT }))
      .toThrow(/mandatory slice content exceeds tokenBudget 2000 \(measured \d+ tokens\)/)
  })

  test('drops oversized optional content while retaining mandatory task text', () => {
    const plan = `## Context
${'optional context '.repeat(1_500)}
`
    const tasks = `## T1: Required task
- Files: src/task.ts
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T1', { git: FAKE_GIT })

    expect(result.markdown).toContain('## T1: Required task')
    expect(result.markdown).not.toContain('optional context')
    expect(result.dropped).toContain('Context digest')
    expect(result.markdown).toContain('lower-priority items omitted')
  })

  test('evicts oldest equally ranked decisions first while rendering retained decisions chronologically', () => {
    const decisions = Array.from({ length: 6 }, (_, index) => `### T${index + 1} — Decision ${index + 1}
- Decision: Keep src/shared.ts:10 stable.
- Why: ${'decision detail '.repeat(24)}
- Constraint for later tasks: Preserve C1.
- Contracts touched: C1 confirmed.
- Anchor: ${FRESH_ANCHOR}
`).join('\n')
    const plan = `## Decision log\n${decisions}`
    const tasks = `## T9: Consumer
- Files: unrelated.ts
- Contract: C1
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T9', { tokenBudget: 400, git: FAKE_GIT })

    expect(result.markdown).not.toContain('T1 — Decision 1')
    expect(result.markdown).toContain('T5 — Decision 5')
    expect(result.markdown).toContain('T6 — Decision 6')
    expect(result.markdown.indexOf('T5 — Decision 5')).toBeLessThan(result.markdown.indexOf('T6 — Decision 6'))
    expect(result.dropped).toContain('Decision T1')
    expect(result.dropped).not.toContain('Decision T6')
    expect(result.markdown).toContain('(dropped blocks: T1')
  })

  test('keeps an old explicitly scoped decision under pressure while newer unrelated decisions drop', () => {
    const decisions = Array.from({ length: 4 }, (_, index) => `### T${index + 1} — Decision ${index + 1}
- Decision: Preserve decision ${index + 1}.
- Why: ${'Budget pressure detail. '.repeat(16)}
- Constraint for later tasks: —
- Contracts touched: —
- Anchor: ${FRESH_ANCHOR}
${index === 0 ? '- Applies to: T9\n' : ''}`).join('\n')
    const plan = `## Decision log\n${decisions}`
    const tasks = `## T9: Scoped consumer
- Files: src/unrelated.ts
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T9', { tokenBudget: 250, git: FAKE_GIT })

    expect(result.markdown).toContain('T1 — Decision 1')
    expect(result.markdown).not.toContain('T4 — Decision 4')
    expect(result.dropped).not.toContain('Decision T1')
    expect(result.dropped).toContain('Decision T4')
  })

  test('names at most ten relevance-filtered decision ids and summarizes the remainder', () => {
    const decisions = Array.from({ length: 14 }, (_, index) => `### T${index + 1} — Decision ${index + 1}
- Decision: Preserve unrelated behavior.
- Why: Required.
- Constraint for later tasks: —
- Contracts touched: —
- Anchor: ${FRESH_ANCHOR}
`).join('\n')
    const plan = `## Decision log\n${decisions}`
    const tasks = `## T20: Consumer
- Files: src/unrelated.ts
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T20', { git: FAKE_GIT })

    expect(result.markdown).toContain(
      '(dropped blocks: T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, +1 more)',
    )
    expect(result.markdown).not.toContain('dropped blocks: T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11')
  })

  test('passes taskRawOf output into contract-label filtering', () => {
    const plan = `## Contracts
C7 defines the unrelated contract.

## Decision log
### T1 — Contract decision
- Decision: Keep the contract.
- Why: Required by T7.
- Constraint for later tasks: Preserve C7.
- Contracts touched: C7 confirmed.
- Anchor: ${FRESH_ANCHOR}
`
    const tasks = `## T7: Consumer
- Files: unrelated.ts
- Contract: C7
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T7', { git: FAKE_GIT })

    expect(result.markdown).toContain('### [fresh] T1 — Contract decision')
  })

  test('marks every legacy pre-Anchor block verify without crashing', () => {
    const legacyPlan = PLAN.replace(/^- Anchor:.*\n/gm, '')
    const tasks = `## T1: Legacy
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`

    const result = sliceForTask(legacyPlan, tasks, 'T1', { git: FAKE_GIT })

    expect(result.markdown).toContain('### [verify] T1 — Add the parser')
    expect(result.markdown).toContain('### [verify] Final review — Legacy event')
    expect(result.markdown).not.toContain('### [fresh]')
  })

  test('marks a block verify when git comparison fails', () => {
    const failedGit = {
      headSha: () => HEAD_SHA,
      isAncestor: () => true,
      changedFilesSince: () => null,
      dirtyFiles: () => [],
    }
    const tasks = `## T1: Compare
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`

    const result = sliceForTask(PLAN, tasks, 'T1', { git: failedGit })

    expect(result.markdown).toContain('### [verify] T1 — Add the parser')
    expect(result.markdown).not.toContain('### [fresh] T1 — Add the parser')
  })

  test('marks anchored blocks verify when dirty-file discovery fails', () => {
    const failedDirtyGit = {
      headSha: () => HEAD_SHA,
      isAncestor: () => true,
      changedFilesSince: () => [],
      dirtyFiles: () => null,
    }
    const tasks = `## T1: Dirty probe
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`

    const result = sliceForTask(PLAN, tasks, 'T1', { git: failedDirtyGit })

    expect(result.markdown).toContain('### [verify] T1 — Add the parser')
    expect(result.markdown).not.toContain('### [fresh] T1 — Add the parser')
  })

  test.each([
    ['is not an ancestor', false],
    ['ancestry cannot be determined', null],
  ])('marks anchored blocks verify when the anchor %s', (_label, ancestry) => {
    let comparisonCalls = 0
    const unverifiableGit = {
      headSha: () => HEAD_SHA,
      isAncestor: () => ancestry,
      changedFilesSince: () => {
        comparisonCalls += 1
        return []
      },
      dirtyFiles: () => [],
    }
    const tasks = `## T1: Ancestry probe
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`

    const result = sliceForTask(PLAN, tasks, 'T1', { git: unverifiableGit })

    expect(result.markdown).toContain('### [verify] T1 — Add the parser')
    expect(result.markdown).not.toContain('### [fresh] T1 — Add the parser')
    expect(comparisonCalls).toBe(0)
  })

  test('rejects an option-like anchor without invoking git or writing a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-anchor-'))
    tempDirectories.push(directory)
    const targetPath = join(directory, 'injected-output')
    let unsafeComparisonCalls = 0
    const maliciousGit = {
      headSha: () => HEAD_SHA,
      isAncestor: (sha: string) => {
        if (sha !== HEAD_SHA) unsafeComparisonCalls += 1
        return true
      },
      changedFilesSince: (sha: string) => {
        if (sha !== HEAD_SHA) unsafeComparisonCalls += 1
        return []
      },
      dirtyFiles: () => [],
    }
    const plan = `## Decision log
### T1 — Unsafe anchor
- Decision: Keep src/task.ts:1 stable.
- Why: Test validation.
- Constraint for later tasks: Preserve src/task.ts.
- Contracts touched: C1.
- Anchor: --output=${targetPath}
`
    const tasks = `## T1: Consumer
- Files: src/task.ts
- Status: pending
`

    const result = sliceForTask(plan, tasks, 'T1', { git: maliciousGit })

    expect(result.markdown).toContain('### [verify] T1 — Unsafe anchor')
    expect(result.markdown).not.toContain('### [fresh]')
    expect(unsafeComparisonCalls).toBe(0)
    expect(existsSync(targetPath)).toBe(false)
  })

  test('rejects an invalid token budget', () => {
    expect(() => sliceForTask(PLAN, LARGE_TASKS, 'T1', { tokenBudget: 0, git: FAKE_GIT }))
      .toThrow(/tokenBudget must be a positive integer/)
  })
})

describe('sliceForResume', () => {
  test('opens with the interruption warning, includes Out of scope, and points to never-candidate sections', () => {
    // Arrange
    const plan = `## Architecture
Keep parser boundaries stable.

## Risk & blast radius
Only generated slices may change.

## Skills plan
Use the TypeScript execution skill.

## Component → files
Slicer: scripts/context-slice.mjs.

## Experimental notes
This unrecognized section is intentionally omitted.

## Out of scope
Do not change public signatures.
`
    const tasks = `## T1: Resume pointers
- Files: scripts/context-slice.mjs
- Status: pending
`

    // Act
    const result = sliceForResume(plan, tasks, { git: FAKE_GIT })

    // Assert
    expect(result.markdown.startsWith(
      '> Assume interruption: read this file fully before acting; treat [verify] blocks as hypotheses to re-confirm against the current code.\n',
    )).toBe(true)
    expect(result.markdown).toContain('## Out of scope\nDo not change public signatures.')
    expect(result.markdown).toMatch(/lower-priority items omitted[^\n]*Architecture/)
    expect(result.markdown).toMatch(/lower-priority items omitted[^\n]*Risk & blast radius/)
    expect(result.markdown).toMatch(/lower-priority items omitted[^\n]*Skills plan/)
    expect(result.markdown).toMatch(/lower-priority items omitted[^\n]*Component → files/)
    expect(result.markdown).toMatch(/lower-priority items omitted[^\n]*Experimental notes/)
  })

  test('selects the first task whose status is not done', () => {
    const tasks = `## T1: Active task
- Files: src/active.ts
- Status: in_progress

## T2: Pending task
- Files: src/pending.ts
- Status: pending
`

    const result = sliceForResume('## Objective\nContinue unfinished work.\n', tasks, { git: FAKE_GIT })

    expect(result.markdown).toContain('## T1: Active task')
    expect(result.markdown).not.toContain('## T2: Pending task')
  })

  test('includes Session lineage for every in-progress task in the status list', () => {
    const tasks = `## T1: First active task
- Files: src/first.ts
- Session: session-first (cwd: /worktrees/first, base: abc1234)
- Status: in-progress

## T2: Second active task
- Files: src/second.ts
- Session: launching (base: def5678, worktree: /worktrees/second, branch: task-t2)
- Status: in-progress

## T3: Pending task
- Files: src/pending.ts
- Session: —
- Status: pending
`

    const result = sliceForResume('## Objective\nContinue unfinished work.\n', tasks, { git: FAKE_GIT })

    expect(result.markdown).toContain(
      '- T1 — Status: in-progress — Session: session-first (cwd: /worktrees/first, base: abc1234)',
    )
    expect(result.markdown).toContain(
      '- T2 — Status: in-progress — Session: launching (base: def5678, worktree: /worktrees/second, branch: task-t2)',
    )
    expect(result.markdown).toContain('- T3 — Status: pending')
    expect(result.markdown).not.toContain('- T3 — Status: pending — Session:')
    expect(result.markdown).not.toContain('## T2: Second active task')
  })

  test('treats done-ish as unknown rather than completed', () => {
    const tasks = `## T1: Not actually done
- Files: src/active.ts
- Status: done-ish

## T2: Pending task
- Files: src/pending.ts
- Status: pending
`

    const result = sliceForResume('## Objective\nContinue unfinished work.\n', tasks, { git: FAKE_GIT })

    expect(result.markdown).toContain('- T1 — Status: unknown')
    expect(result.markdown).toContain('## T1: Not actually done')
  })

  test('treats a missing Status line as pending', () => {
    const tasks = `## T1: Completed
- Files: src/done.ts
- Status: done

## T2: Legacy pending task
- Files: src/pending.ts
`

    const result = sliceForResume('## Objective\nContinue unfinished work.\n', tasks, { git: FAKE_GIT })

    expect(result.markdown).toContain('- T2 — Status: pending')
    expect(result.markdown).toContain('## T2: Legacy pending task')
  })

  test('fits a long resume slice to budget with statuses and the next pending task', () => {
    const result = sliceForResume(LARGE_PLAN, LARGE_TASKS, { git: FAKE_GIT })

    expect(result.tokens).toBe(tokensOf(result.markdown))
    expect(result.tokens).toBeLessThanOrEqual(RESUME_TOKEN_BUDGET)
    expect(result.markdown).toContain('- T1 — Status: done')
    expect(result.markdown).toContain('- T20 — Status: pending')
    expect(result.markdown).toContain('## T2: Task 2')
    expect(result.markdown).toContain('[fresh]')
    expect(result.markdown).toContain('[verify]')
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(result.markdown).toMatch(/\(\+\d+ lower-priority items omitted — read \.codex-flow\/PLAN\.md/)
  })

  test('throws instead of dropping oversized mandatory next-task text', () => {
    const tasks = `## T1: Oversized pending task
- Files: src/task.ts
- Details: ${'x'.repeat(33_000)}
- Status: pending
`

    expect(() => sliceForResume('## Objective\nSmall.\n', tasks, { git: FAKE_GIT }))
      .toThrow(/mandatory slice content exceeds tokenBudget 8000/)
  })

  test('keeps Contracts ahead of Objective under budget pressure', () => {
    const plan = `## Objective
${'objective '.repeat(50)}

## Contracts
${'contract '.repeat(50)}
`
    const tasks = `## T1: Pending
- Files: src/task.ts
- Status: pending
`

    const result = sliceForResume(plan, tasks, { tokenBudget: 250, git: FAKE_GIT })

    expect(result.markdown).toContain('## Contracts')
    expect(result.markdown).not.toContain('## Objective')
    expect(result.dropped).toContain('Objective')
    expect(result.dropped).not.toContain('Contracts')
  })

  test('keeps the mandatory stamped Contracts index in a tight resume slice', () => {
    const plan = `## Objective
${'objective '.repeat(80)}

## Contracts
- C1: Task behavior lives in src/task.ts.
`
    const tasks = `## T1: Pending
- Files: src/task.ts
- Status: pending
`

    const result = sliceForResume(plan, tasks, { tokenBudget: 190, git: FAKE_GIT })

    expect(result.markdown).toContain('## Contracts index')
    expect(result.markdown).toContain('- C1: [verify] Task behavior lives in src/task.ts.')
    expect(result.dropped).not.toContain('Contracts index')
  })

  test('handles a pre-Anchor legacy plan with every included block marked verify', () => {
    const legacyPlan = PLAN.replace(/^- Anchor:.*\n/gm, '')
    const tasks = `## T1: Legacy resume
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`

    const result = sliceForResume(legacyPlan, tasks, { git: FAKE_GIT })

    expect(result.markdown).toContain('### [verify] T1 — Add the parser')
    expect(result.markdown).toContain('### [verify] Final review — Legacy event')
    expect(result.markdown).not.toContain('[fresh]')
  })
})

describe('defaultGit', () => {
  test('degrades to null values outside a git repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-nogit-'))
    tempDirectories.push(directory)

    const git = defaultGit(directory)

    expect(git.headSha()).toBeNull()
    expect(git.isAncestor('abc123')).toBeNull()
    expect(git.changedFilesSince('abc123')).toBeNull()
    expect(git.dirtyFiles()).toBeNull()
  })

  test('rejects an option-like revision without creating its output target', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-git-option-'))
    tempDirectories.push(directory)
    const targetPath = join(directory, 'git-output')
    const git = defaultGit(directory)

    const changedFiles = git.changedFilesSince(`--output=${targetPath}`)
    const isAncestor = git.isAncestor(`--output=${targetPath}`)

    expect(changedFiles).toBeNull()
    expect(isAncestor).toBeNull()
    expect(existsSync(targetPath)).toBe(false)
  })
})

describe.skipIf(!GIT_AVAILABLE)('defaultGit filename parsing', () => {
  test('preserves spaces in committed, staged, unstaged, and untracked filenames', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-git-paths-'))
    tempDirectories.push(directory)
    initializeGitRepository(directory)
    const committedPath = 'committed file.ts'
    const stagedPath = ' staged-file.ts'
    const unstagedPath = 'unstaged file.ts'
    const untrackedPath = 'untracked file.ts'
    for (const filePath of [committedPath, stagedPath, unstagedPath]) {
      writeFileSync(join(directory, filePath), 'initial\n')
    }
    runGit(directory, ['add', '--all'])
    runGit(directory, ['commit', '--quiet', '-m', 'initial files'])
    const anchor = runGit(directory, ['rev-parse', 'HEAD'])
    writeFileSync(join(directory, committedPath), 'committed change\n')
    runGit(directory, ['add', '--', committedPath])
    runGit(directory, ['commit', '--quiet', '-m', 'committed filename change'])
    writeFileSync(join(directory, stagedPath), 'staged change\n')
    runGit(directory, ['add', '--', stagedPath])
    writeFileSync(join(directory, unstagedPath), 'unstaged change\n')
    writeFileSync(join(directory, untrackedPath), 'untracked\n')
    const git = defaultGit(directory)

    // Act
    const changedFiles = git.changedFilesSince(anchor)
    const dirtyFiles = git.dirtyFiles()

    // Assert
    expect(changedFiles).toEqual([committedPath])
    expect(new Set(dirtyFiles)).toEqual(new Set([stagedPath, unstagedPath, untrackedPath]))
  })

  test.skipIf(process.platform === 'win32')('preserves newlines and trailing spaces in filenames', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-git-posix-paths-'))
    tempDirectories.push(directory)
    initializeGitRepository(directory)
    const committedPath = 'committed\nfile.ts'
    const unstagedPath = 'unstaged\nfile.ts'
    const untrackedPath = 'untracked file.ts '
    for (const filePath of [committedPath, unstagedPath]) {
      writeFileSync(join(directory, filePath), 'initial\n')
    }
    runGit(directory, ['add', '--all'])
    runGit(directory, ['commit', '--quiet', '-m', 'initial POSIX files'])
    const anchor = runGit(directory, ['rev-parse', 'HEAD'])
    writeFileSync(join(directory, committedPath), 'committed change\n')
    runGit(directory, ['add', '--', committedPath])
    runGit(directory, ['commit', '--quiet', '-m', 'committed POSIX filename change'])
    writeFileSync(join(directory, unstagedPath), 'unstaged change\n')
    writeFileSync(join(directory, untrackedPath), 'untracked\n')
    const git = defaultGit(directory)

    // Act
    const changedFiles = git.changedFilesSince(anchor)
    const dirtyFiles = git.dirtyFiles()

    // Assert
    expect(changedFiles).toEqual([committedPath])
    expect(new Set(dirtyFiles)).toEqual(new Set([unstagedPath, untrackedPath]))
  })
})

describe('context-slice CLI', () => {
  test('preserves a symlink target and cleans up its sibling temp file after atomic failure', async () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-atomic-'))
    tempDirectories.push(directory)
    const outputDirectory = join(directory, 'derived')
    const outputPath = join(outputDirectory, 'CONTEXT-T1.md')
    const externalTarget = join(directory, 'external.md')
    mkdirSync(outputDirectory)
    writeFileSync(externalTarget, 'previous complete output\n')
    symlinkSync(externalTarget, outputPath)

    // Act
    const write = writeFileAtomically(outputPath, 'partial replacement\n')

    // Assert
    await expect(write).rejects.toThrow(/output file is a symlink — refusing to write through it/)
    expect(readFileSync(externalTarget, 'utf8')).toBe('previous complete output\n')
    expect(readdirSync(outputDirectory)).toEqual(['CONTEXT-T1.md'])
  })

  test('writes task and resume files with generated headers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-cli-'))
    tempDirectories.push(directory)
    const planPath = join(directory, 'PLAN.md')
    const tasksPath = join(directory, 'TASKS.md')
    const outputDirectory = join(directory, 'derived')
    writeFileSync(planPath, PLAN)
    writeFileSync(tasksPath, `## T1: CLI task
- Files: scripts/context-slice.mjs
- Contract: C1
- Status: pending
`)

    const commonArgs = ['--plan', planPath, '--tasks', tasksPath, '--out', outputDirectory]
    const taskOutput = execFileSync(process.execPath, [CONTEXT_SLICE_SCRIPT, '--task', 'T1', ...commonArgs], {
      cwd: directory,
      encoding: 'utf8',
    }).trim()
    const resumeOutput = execFileSync(process.execPath, [CONTEXT_SLICE_SCRIPT, '--resume', ...commonArgs], {
      cwd: directory,
      encoding: 'utf8',
    }).trim()

    expect(taskOutput).toBe(join(outputDirectory, 'CONTEXT-T1.md'))
    expect(resumeOutput).toBe(join(outputDirectory, 'RESUME.md'))
    expect(existsSync(taskOutput)).toBe(true)
    expect(existsSync(resumeOutput)).toBe(true)
    expect(readFileSync(taskOutput, 'utf8')).toMatch(/^<!-- generated by context-slice\.mjs.*anchor: null -->/)
    expect(readFileSync(resumeOutput, 'utf8')).toMatch(
      /^> Assume interruption: read this file fully before acting; treat \[verify\] blocks as hypotheses to re-confirm against the current code\.\n\n<!-- generated by context-slice\.mjs.*anchor: null -->/,
    )
  })

  test('exits one with a one-line error when no mode is provided', () => {
    const result = spawnSync(process.execPath, [CONTEXT_SLICE_SCRIPT], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toMatch(/^context-slice: provide exactly one of --task T<n> or --resume$/)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })

  test('refuses to write through a symlinked output file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-symlink-'))
    tempDirectories.push(directory)
    const planPath = join(directory, 'PLAN.md')
    const tasksPath = join(directory, 'TASKS.md')
    const outputDirectory = join(directory, 'derived')
    const externalTarget = join(directory, 'external.md')
    mkdirSync(outputDirectory)
    writeFileSync(planPath, PLAN)
    writeFileSync(tasksPath, `## T1: Symlink test
- Files: scripts/context-slice.mjs
- Status: pending
`)
    writeFileSync(externalTarget, 'unchanged')
    symlinkSync(externalTarget, join(outputDirectory, 'CONTEXT-T1.md'))

    const result = spawnSync(process.execPath, [
      CONTEXT_SLICE_SCRIPT,
      '--task', 'T1',
      '--plan', planPath,
      '--tasks', tasksPath,
      '--out', outputDirectory,
    ], { cwd: directory, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toMatch(/^context-slice: output file is a symlink — refusing to write through it$/)
    expect(readFileSync(externalTarget, 'utf8')).toBe('unchanged')
  })

  test('refuses to write through a symlinked output directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-dir-symlink-'))
    tempDirectories.push(directory)
    const planPath = join(directory, 'PLAN.md')
    const tasksPath = join(directory, 'TASKS.md')
    const externalDirectory = join(directory, 'external')
    const outputDirectory = join(directory, 'derived')
    mkdirSync(externalDirectory)
    writeFileSync(planPath, PLAN)
    writeFileSync(tasksPath, `## T1: Directory symlink test
- Files: scripts/context-slice.mjs
- Status: pending
`)
    symlinkSync(externalDirectory, outputDirectory)

    const result = spawnSync(process.execPath, [
      CONTEXT_SLICE_SCRIPT,
      '--task', 'T1',
      '--plan', planPath,
      '--tasks', tasksPath,
      '--out', outputDirectory,
    ], { cwd: directory, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toMatch(/^context-slice: output directory is a symlink — refusing to write through it$/)
    expect(existsSync(join(externalDirectory, 'CONTEXT-T1.md'))).toBe(false)
  })
})

describe.skipIf(!GIT_AVAILABLE)('context-slice CLI git staleness', () => {
  test('flips a decision block from fresh to verify after its referenced file becomes dirty', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'context-slice-e2e-'))
    tempDirectories.push(directory)
    const flowDirectory = join(directory, '.codex-flow')
    const sourceDirectory = join(directory, 'src')
    const planPath = join(flowDirectory, 'PLAN.md')
    const tasksPath = join(flowDirectory, 'TASKS.md')
    const sourcePath = join(sourceDirectory, 'referenced.ts')
    const outputDirectory = join(directory, 'derived')
    mkdirSync(flowDirectory)
    mkdirSync(sourceDirectory)
    initializeGitRepository(directory)
    writeFileSync(sourcePath, 'export const value = 1\n')
    writeFileSync(tasksPath, `## T1: E2E staleness
- Files: src/referenced.ts
- Status: pending
`)
    runGit(directory, ['add', '--all'])
    runGit(directory, ['commit', '--quiet', '-m', 'anchor source and task'])
    const anchor = runGit(directory, ['rev-parse', 'HEAD'])
    writeFileSync(planPath, `## Decision log
### T1 — Keep the referenced source stable
- Decision: Preserve src/referenced.ts:1.
- Why: The task depends on its current behavior.
- Constraint for later tasks: Re-check src/referenced.ts before editing.
- Contracts touched: src/referenced.ts remains the task contract.
- Anchor: ${anchor}
`)
    runGit(directory, ['add', '--all'])
    runGit(directory, ['commit', '--quiet', '-m', 'record anchored decision'])
    const cliArgs = [
      CONTEXT_SLICE_SCRIPT,
      '--task', 'T1',
      '--plan', planPath,
      '--tasks', tasksPath,
      '--out', outputDirectory,
    ]

    // Act
    execFileSync(process.execPath, cliArgs, { cwd: directory, encoding: 'utf8' })
    const freshSlice = readFileSync(join(outputDirectory, 'CONTEXT-T1.md'), 'utf8')
    writeFileSync(sourcePath, 'export const value = 2\n')
    execFileSync(process.execPath, cliArgs, { cwd: directory, encoding: 'utf8' })
    const dirtySlice = readFileSync(join(outputDirectory, 'CONTEXT-T1.md'), 'utf8')

    // Assert
    expect(freshSlice).toContain('### [fresh] T1 — Keep the referenced source stable')
    expect(freshSlice).not.toContain('### [verify] T1 — Keep the referenced source stable')
    expect(dirtySlice).toContain('### [verify] T1 — Keep the referenced source stable')
    expect(dirtySlice).not.toContain('### [fresh] T1 — Keep the referenced source stable')
  })
})
