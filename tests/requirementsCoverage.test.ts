import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import {
  coverageOf,
  parsePlanAcceptance,
  parseRequirements,
  planCoverageOf,
} from '../scripts/requirements-coverage.mjs'

const REQUIREMENTS_COVERAGE_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'requirements-coverage.mjs',
)
const tempDirectories: string[] = []

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

describe('parseRequirements', () => {
  test('parses ordered requirements and criteria without deltas', () => {
    // Arrange
    const text = `# Requirements

## R1: Authentication
- R1.1: A signed-out visitor is redirected to login.
- R1.2: A signed-in user can open the dashboard.

## R2: Audit
- R2.1: A successful login is recorded.
`

    // Act
    const requirements = parseRequirements(text)

    // Assert
    expect(requirements).toEqual([
      {
        id: 'R1',
        title: 'Authentication',
        criteria: [
          { id: 'R1.1', clause: 'A signed-out visitor is redirected to login.' },
          { id: 'R1.2', clause: 'A signed-in user can open the dashboard.' },
        ],
      },
      {
        id: 'R2',
        title: 'Audit',
        criteria: [{ id: 'R2.1', clause: 'A successful login is recorded.' }],
      },
    ])
  })

  test('appends requirements and criteria from ADDED deltas', () => {
    // Arrange
    const text = `## R1: Existing
- R1.1: Existing criterion.

## Deltas
### 2026-08-07 ADDED R1.2
Added under the existing requirement.
### 2026-08-08 ADDED R2
New requirement
### 2026-08-08 ADDED R2.1
Added under the new requirement.
`

    // Act
    const requirements = parseRequirements(text)

    // Assert
    expect(requirements).toEqual([
      {
        id: 'R1',
        title: 'Existing',
        criteria: [
          { id: 'R1.1', clause: 'Existing criterion.' },
          { id: 'R1.2', clause: 'Added under the existing requirement.' },
        ],
      },
      {
        id: 'R2',
        title: 'New requirement',
        criteria: [{ id: 'R2.1', clause: 'Added under the new requirement.' }],
      },
    ])
  })

  test('replaces requirement titles and criterion clauses from MODIFIED deltas', () => {
    // Arrange
    const text = `## R1: Original title
- R1.1: Original clause.

## Deltas
### 2026-08-07 MODIFIED R1
Revised title
### 2026-08-08 MODIFIED R1.1
Revised clause.
`

    // Act
    const requirements = parseRequirements(text)

    // Assert
    expect(requirements).toEqual([
      {
        id: 'R1',
        title: 'Revised title',
        criteria: [{ id: 'R1.1', clause: 'Revised clause.' }],
      },
    ])
  })

  test('drops criteria and whole requirements from REMOVED deltas', () => {
    // Arrange
    const text = `## R1: Keep
- R1.1: Keep this criterion.
- R1.2: Remove this criterion.

## R2: Remove
- R2.1: Remove with its requirement.

## Deltas
### 2026-08-07 REMOVED R1.2
### 2026-08-08 REMOVED R2
`

    // Act
    const requirements = parseRequirements(text)

    // Assert
    expect(requirements).toEqual([
      {
        id: 'R1',
        title: 'Keep',
        criteria: [{ id: 'R1.1', clause: 'Keep this criterion.' }],
      },
    ])
  })

  test('rejects an empty requirements file instead of accepting zero criteria', () => {
    // Arrange
    const text = ''

    // Act
    const parse = () => parseRequirements(text)

    // Assert
    expect(parse).toThrow(/effective requirement set has zero criteria/)
  })

  test('rejects an effective requirement with no criteria', () => {
    // Arrange
    const text = `## R1: Criterion-less requirement
This requirement has no criterion bullets.
`

    // Act
    const parse = () => parseRequirements(text)

    // Assert
    expect(parse).toThrow(/requirement R1 has no criteria/)
  })

  test('rejects an R-like criterion bullet with malformed syntax', () => {
    // Arrange
    const text = `## R1: Malformed criterion
- R1.1 missing colon
`

    // Act
    const parse = () => parseRequirements(text)

    // Assert
    expect(parse).toThrow(/malformed criterion R1\.1/)
  })

  test('rejects structural headings after the Deltas section starts', () => {
    // Arrange
    const text = `## R1: Existing
- R1.1: Existing criterion.

## Deltas
### 2026-08-07 MODIFIED R1.1
Revised criterion.
## Unexpected section
This must not become part of the revised clause.
`

    // Act
    const parse = () => parseRequirements(text)

    // Assert
    expect(parse).toThrow(/invalid structure in Deltas section: ## Unexpected section/)
  })
})

describe('coverageOf', () => {
  const requirements = parseRequirements(`## R1: Account
- R1.1: Create an account.
- R1.2: Delete an account.

## R2: Profile
- R2.1: Edit a profile.
`)

  test('reports effective criterion IDs cited by no task', () => {
    // Arrange
    const tasks = `## T1: Create accounts
- Requirements: R1.1
`

    // Act
    const coverage = coverageOf(requirements, tasks)

    // Assert
    expect(coverage).toEqual({ uncovered: ['R1.2', 'R2.1'], unknown: [] })
  })

  test('reports task citations that are not effective criterion IDs', () => {
    // Arrange
    const tasks = `## T1: Account work
- Requirements: R1.1, R9.9

## T2: Profile work
- Requirements: R2, R2.1
`

    // Act
    const coverage = coverageOf(requirements, tasks)

    // Assert
    expect(coverage.unknown).toEqual([
      { taskId: 'T1', id: 'R9.9' },
      { taskId: 'T2', id: 'R2' },
    ])
  })

  test('returns no violations when all criteria are covered by known IDs', () => {
    // Arrange
    const tasks = `## T1: Account work
- Requirements: R1.1, R1.2

## T2: Profile work
- Requirements: R2.1
`

    // Act
    const coverage = coverageOf(requirements, tasks)

    // Assert
    expect(coverage).toEqual({ uncovered: [], unknown: [] })
  })

  test('ignores tasks without a Requirements field while giving them no coverage', () => {
    // Arrange
    const tasks = `## T1: No traceability field
- Files: src/account.ts
- Steps: Implement R99.9 in prose only.
`

    // Act
    const coverage = coverageOf(requirements, tasks)

    // Assert
    expect(coverage).toEqual({ uncovered: ['R1.1', 'R1.2', 'R2.1'], unknown: [] })
  })

  test('rejects a zero-criterion requirement set supplied directly by a caller', () => {
    // Arrange
    const emptyRequirements: Array<{ id: string, title: string, criteria: never[] }> = []

    // Act
    const cover = () => coverageOf(emptyRequirements, '')

    // Assert
    expect(cover).toThrow(/effective requirement set has zero criteria/)
  })
})

describe('requirements-coverage CLI', () => {
  test('exits one with violations and zero with a short OK line after coverage is fixed', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-'))
    tempDirectories.push(directory)
    const requirementsPath = join(directory, 'REQUIREMENTS.md')
    const tasksPath = join(directory, 'TASKS.md')
    writeFileSync(requirementsPath, `## R1: CLI behavior
- R1.1: The helper reports coverage.
- R1.2: The helper rejects unknown IDs.
`)
    writeFileSync(tasksPath, `## T1: Incomplete task
- Requirements: R1.1, R9.9
`)
    const args = ['--requirements', requirementsPath, '--tasks', tasksPath]

    // Act
    const failing = spawnSync(
      process.execPath,
      [REQUIREMENTS_COVERAGE_SCRIPT, ...args],
      { encoding: 'utf8' },
    )
    writeFileSync(tasksPath, `## T1: Complete task
- Requirements: R1.1, R1.2
`)
    const passing = spawnSync(
      process.execPath,
      [REQUIREMENTS_COVERAGE_SCRIPT, ...args],
      { encoding: 'utf8' },
    )

    // Assert
    expect(failing.status).toBe(1)
    expect(failing.stderr).toContain('uncovered criterion R1.2')
    expect(failing.stderr).toContain('T1 cites unknown criterion R9.9')
    expect(passing.status).toBe(0)
    expect(passing.stdout.trim()).toMatch(
      /^requirements-coverage: OK — 2 effective criteria covered; no unknown citations$/,
    )
    expect(passing.stderr).toBe('')
  })

  test('exits one with a clear parse error for an empty requirements file', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-empty-'))
    tempDirectories.push(directory)
    const requirementsPath = join(directory, 'REQUIREMENTS.md')
    const tasksPath = join(directory, 'TASKS.md')
    writeFileSync(requirementsPath, '')
    writeFileSync(tasksPath, `## T1: No requirements to cite
- Files: src/example.ts
`)

    // Act
    const result = spawnSync(process.execPath, [
      REQUIREMENTS_COVERAGE_SCRIPT,
      '--requirements',
      requirementsPath,
      '--tasks',
      tasksPath,
    ], { encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('effective requirement set has zero criteria')
  })
})

describe('parsePlanAcceptance', () => {
  test('parses ordered acceptance entries with their covered criteria and commands', () => {
    // Arrange
    const plan = `## Acceptance criteria

- A1 (covers R1.1, R1.2): \`npx vitest run tests/a.test.ts && npm run build\`.
- A2 (covers R2.1): manual probe: open the dashboard and confirm the banner.
`

    // Act
    const entries = parsePlanAcceptance(plan)

    // Assert
    expect(entries).toEqual([
      {
        id: 'A1',
        covers: ['R1.1', 'R1.2'],
        command: '`npx vitest run tests/a.test.ts && npm run build`.',
      },
      {
        id: 'A2',
        covers: ['R2.1'],
        command: 'manual probe: open the dashboard and confirm the banner.',
      },
    ])
  })

  test('rejects an A-like bullet whose covers clause is malformed', () => {
    // Arrange
    const plan = `## Acceptance criteria

- A1: \`npx vitest run tests/a.test.ts\`.
`

    // Act
    const parse = () => parsePlanAcceptance(plan)

    // Assert
    expect(parse).toThrow(/malformed acceptance entry A1/)
  })

  test('rejects an acceptance entry with an empty command or probe', () => {
    // Arrange — the \u0020 escapes are the whitespace-only command under test;
    // written literally they would be trailing whitespace and fail `git diff --check`.
    const plan = `## Acceptance criteria

- A1 (covers R1.1):\u0020\u0020\u0020
`

    // Act
    const parse = () => parsePlanAcceptance(plan)

    // Assert
    expect(parse).toThrow(/malformed acceptance entry A1/)
  })

  test('rejects a duplicate acceptance entry ID', () => {
    // Arrange
    const plan = `## Acceptance criteria

- A1 (covers R1.1): \`first\`.
- A1 (covers R1.2): \`second\`.
`

    // Act
    const parse = () => parsePlanAcceptance(plan)

    // Assert
    expect(parse).toThrow(/duplicate acceptance entry A1/)
  })

  test('rejects a plan with no acceptance entries at all', () => {
    // Arrange
    const plan = `## Acceptance criteria

To be decided.
`

    // Act
    const parse = () => parsePlanAcceptance(plan)

    // Assert
    expect(parse).toThrow(/plan has zero acceptance entries/)
  })
})

describe('planCoverageOf', () => {
  const entries = [
    { id: 'A1', covers: ['R1.1'], command: '`npx vitest run tests/a.test.ts`' },
    { id: 'A2', covers: ['R1.2'], command: '`npx vitest run tests/b.test.ts`' },
  ]
  const effectiveIds = ['R1.1', 'R1.2']

  test('reports no violations when every acceptance entry is cited by a task', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1

## T2: Second
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: [], unknown: [], unknownRequirements: [] })
  })

  test('reports an acceptance entry that no task cites as an orphan', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage.orphans).toEqual(['A2'])
  })

  test('reports task citations of acceptance IDs the plan does not define', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1, A9

## T2: Second
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage.unknown).toEqual([{ taskId: 'T1', id: 'A9' }])
  })

  test('reports acceptance entries that cover criterion IDs outside the effective set', () => {
    // Arrange
    const entriesWithUnknownCriterion = [
      { id: 'A1', covers: ['R1.1', 'R9.9'], command: '`npx vitest run tests/a.test.ts`' },
    ]
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`

    // Act
    const coverage = planCoverageOf(entriesWithUnknownCriterion, tasks, effectiveIds)

    // Assert
    expect(coverage.unknownRequirements).toEqual([{ acceptanceId: 'A1', criterionId: 'R9.9' }])
  })

  test('reports a satisfies token that is not a bare acceptance ID instead of crediting it', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1foo

## T2: Second
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({
      orphans: ['A1'],
      unknown: [{ taskId: 'T1', id: 'A1foo' }],
      unknownRequirements: [],
    })
  })

  test('reports a malformed token in a comma-separated citation list', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1, A2foo
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({
      orphans: ['A2'],
      unknown: [{ taskId: 'T1', id: 'A2foo' }],
      unknownRequirements: [],
    })
  })

  test('ignores an Acceptance field without a literal satisfies citation', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`

## T2: Second
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: ['A1'], unknown: [], unknownRequirements: [] })
  })
})

describe('requirements-coverage CLI --plan', () => {
  const writeControlFiles = (directory: string, tasks: string, plan: string) => {
    const requirementsPath = join(directory, 'REQUIREMENTS.md')
    const tasksPath = join(directory, 'TASKS.md')
    const planPath = join(directory, 'PLAN.md')
    writeFileSync(requirementsPath, `## R1: CLI behavior
- R1.1: The helper reports coverage.
- R1.2: The helper lints plan acceptance entries.
`)
    writeFileSync(tasksPath, tasks)
    writeFileSync(planPath, plan)
    return { requirementsPath, tasksPath, planPath }
  }

  const runHelper = (args: string[]) => spawnSync(
    process.execPath,
    [REQUIREMENTS_COVERAGE_SCRIPT, ...args],
    { encoding: 'utf8' },
  )

  test('exits zero and keeps the legacy OK line when every acceptance entry is cited', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-plan-ok-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath, planPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1

## T2: Plan lint
- Requirements: R1.2
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`,
      `## Acceptance criteria

- A1 (covers R1.1): \`npx vitest run tests/a.test.ts\`.
- A2 (covers R1.2): \`npx vitest run tests/b.test.ts\`.
`,
    )

    // Act
    const result = runHelper([
      '--requirements', requirementsPath,
      '--tasks', tasksPath,
      '--plan', planPath,
    ])

    // Assert
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(
      'requirements-coverage: OK — 2 effective criteria covered; no unknown citations',
    )
    expect(result.stdout).toContain(
      'requirements-coverage: OK — 2 plan acceptance entries cited by tasks',
    )
  })

  test('exits one naming each orphan acceptance entry the tasks never cite', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-plan-orphan-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath, planPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1, R1.2
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1, A9
`,
      `## Acceptance criteria

- A1 (covers R1.1): \`npx vitest run tests/a.test.ts\`.
- A2 (covers R1.2, R9.9): \`npx vitest run tests/b.test.ts\`.
`,
    )

    // Act
    const result = runHelper([
      '--requirements', requirementsPath,
      '--tasks', tasksPath,
      '--plan', planPath,
    ])

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requirements-coverage: orphan plan acceptance A2')
    expect(result.stderr).toContain('T1 cites unknown acceptance entry A9')
    expect(result.stderr).toContain('A2 covers unknown criterion R9.9')
    expect(result.stdout).toBe('')
  })

  test('exits one with a read error when the plan path does not exist', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-plan-missing-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1, R1.2
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`,
      `## Acceptance criteria

- A1 (covers R1.1, R1.2): \`npx vitest run tests/a.test.ts\`.
`,
    )

    // Act
    const result = runHelper([
      '--requirements', requirementsPath,
      '--tasks', tasksPath,
      '--plan', join(directory, 'MISSING.md'),
    ])

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read')
  })

  test('leaves the no-plan output unchanged when --plan is absent', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-plan-absent-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1, R1.2
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`,
      `## Acceptance criteria

- A1 (covers R1.1): \`npx vitest run tests/a.test.ts\`.
- A2 (covers R1.2): \`npx vitest run tests/b.test.ts\`.
`,
    )

    // Act
    const result = runHelper(['--requirements', requirementsPath, '--tasks', tasksPath])

    // Assert
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      'requirements-coverage: OK — 2 effective criteria covered; no unknown citations\n',
    )
  })

  test('exits one naming an unknown argument instead of silently skipping plan validation', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-unknown-flag-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath, planPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1, R1.2
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`,
      `## Acceptance criteria

- A1 (covers R1.1, R1.2): \`npx vitest run tests/a.test.ts\`.
`,
    )

    // Act
    const result = runHelper([
      '--requirements', requirementsPath,
      '--tasks', tasksPath,
      '--planx', planPath,
    ])

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requirements-coverage: unknown argument --planx')
    expect(result.stdout).toBe('')
  })

  test('exits one when --plan is given more than once', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'requirements-coverage-plan-repeated-'))
    tempDirectories.push(directory)
    const { requirementsPath, tasksPath, planPath } = writeControlFiles(
      directory,
      `## T1: Coverage
- Requirements: R1.1, R1.2
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
`,
      `## Acceptance criteria

- A1 (covers R1.1, R1.2): \`npx vitest run tests/a.test.ts\`.
`,
    )

    // Act
    const result = runHelper([
      '--requirements', requirementsPath,
      '--tasks', tasksPath,
      '--plan', planPath,
      '--plan', planPath,
    ])

    // Assert
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--plan requires exactly one path')
  })
})

describe('parsePlanAcceptance edge cases', () => {
  test('parses a CRLF plan without leaking carriage returns into commands', () => {
    // Arrange
    const plan = [
      '## Acceptance criteria',
      '',
      '- A1 (covers R1.1): `npx vitest run tests/a.test.ts`.',
      '- A2 (covers R2.1, R2.2): manual probe: open the dashboard.',
      '',
    ].join('\r\n')

    // Act
    const entries = parsePlanAcceptance(plan)

    // Assert
    expect(entries).toEqual([
      { id: 'A1', covers: ['R1.1'], command: '`npx vitest run tests/a.test.ts`.' },
      { id: 'A2', covers: ['R2.1', 'R2.2'], command: 'manual probe: open the dashboard.' },
    ])
  })

  test('normalizes whitespace variants inside a covers list', () => {
    // Arrange — extra spaces and a tab around the separators
    const plan = '- A1 (covers   R1.1 ,\tR1.2  ,R2.1): `npx vitest run tests/a.test.ts`.\n'

    // Act
    const entries = parsePlanAcceptance(plan)

    // Assert
    expect(entries).toEqual([
      {
        id: 'A1',
        covers: ['R1.1', 'R1.2', 'R2.1'],
        command: '`npx vitest run tests/a.test.ts`.',
      },
    ])
  })

  test('rejects a covers list whose closing parenthesis is preceded by whitespace', () => {
    // Arrange
    const plan = '- A1 (covers R1.1 ): `npx vitest run tests/a.test.ts`.\n'

    // Act
    const parse = () => parsePlanAcceptance(plan)

    // Assert
    expect(parse).toThrow(/malformed acceptance entry A1/)
  })
})

describe('planCoverageOf citation edge cases', () => {
  const entries = [
    { id: 'A1', covers: ['R1.1'], command: '`npx vitest run tests/a.test.ts`' },
    { id: 'A2', covers: ['R1.2'], command: '`npx vitest run tests/b.test.ts`' },
    { id: 'A3', covers: ['R1.3'], command: '`npx vitest run tests/c.test.ts`' },
  ]
  const effectiveIds = ['R1.1', 'R1.2', 'R1.3']

  test('reports every uncited entry in plan order when tasks cite only a subset', () => {
    // Arrange
    const tasks = `## T1: Second only
- Acceptance: \`npx vitest run tests/b.test.ts\`; satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({
      orphans: ['A1', 'A3'],
      unknown: [],
      unknownRequirements: [],
    })
  })

  test('reports a two-digit acceptance ID the plan never defines', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1, A99

## T2: Rest
- Acceptance: \`npx vitest run tests/bc.test.ts\`; satisfies A2, A3
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({
      orphans: [],
      unknown: [{ taskId: 'T1', id: 'A99' }],
      unknownRequirements: [],
    })
  })

  test('reports a trailing-semicolon token instead of crediting the entry', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1;
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage.orphans).toEqual(['A1', 'A2', 'A3'])
    expect(coverage.unknown).toEqual([{ taskId: 'T1', id: 'A1;' }])
  })

  test('reports a hyphenated token instead of crediting the entry', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A-1
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage.orphans).toEqual(['A1', 'A2', 'A3'])
    expect(coverage.unknown).toEqual([{ taskId: 'T1', id: 'A-1' }])
  })

  test('credits a lowercase acceptance ID because citations are case-insensitive', () => {
    // Arrange — `a1` is well-formed, not malformed: the script matches citation
    // tokens with `ACCEPTANCE_ID = /^A\d+$/i` and folds them through
    // `normalizedId`, the same case-insensitive rule it applies to R- and T-IDs.
    const tasks = `## T1: All three
- Acceptance: \`npx vitest run tests/abc.test.ts\`; satisfies a1, a2, a3
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: [], unknown: [], unknownRequirements: [] })
  })

  test('treats a second satisfies clause on one line as a single malformed token', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1 and satisfies A2
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage.orphans).toEqual(['A1', 'A2', 'A3'])
    expect(coverage.unknown).toEqual([{ taskId: 'T1', id: 'A1 and satisfies A2' }])
  })

  test('accumulates citations from multiple Acceptance fields in one task', () => {
    // Arrange
    const tasks = `## T1: Two acceptance fields
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1
- Acceptance: \`npx vitest run tests/bc.test.ts\`; satisfies A2, A3
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: [], unknown: [], unknownRequirements: [] })
  })

  test('accepts the same acceptance ID cited by more than one task', () => {
    // Arrange
    const tasks = `## T1: First
- Acceptance: \`npx vitest run tests/a.test.ts\`; satisfies A1, A2

## T2: Also first
- Acceptance: \`npx vitest run tests/a2.test.ts\`; satisfies A1, A3
`

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: [], unknown: [], unknownRequirements: [] })
  })

  test('credits citations from a CRLF tasks document', () => {
    // Arrange
    const tasks = [
      '## T1: All three',
      '- Acceptance: `npx vitest run tests/abc.test.ts`; satisfies A1, A2, A3',
      '',
    ].join('\r\n')

    // Act
    const coverage = planCoverageOf(entries, tasks, effectiveIds)

    // Assert
    expect(coverage).toEqual({ orphans: [], unknown: [], unknownRequirements: [] })
  })
})
