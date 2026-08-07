import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import { coverageOf, parseRequirements } from '../scripts/requirements-coverage.mjs'

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
