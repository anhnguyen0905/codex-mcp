import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import {
  BRIEF_TOKEN_BUDGET,
  facetSlug,
  fitBrief,
  renderBrief,
  runCli,
  selectCriteria,
} from '../scripts/skill-brief.mjs'

const SKILL_BRIEF_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'skill-brief.mjs',
)
const tempDirectories: string[] = []

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

function createFixture(prefix = 'skill-brief-') {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  const flowDirectory = join(directory, '.codex-flow')
  mkdirSync(flowDirectory)
  return {
    directory,
    requirementsPath: join(flowDirectory, 'REQUIREMENTS.md'),
    planPath: join(flowDirectory, 'PLAN.md'),
  }
}

function writeStandardInputs(requirementsPath: string, planPath: string) {
  writeFileSync(requirementsPath, `# Requirements

## R2: Skill briefs
- R2.1: Payment workflows cite their source material.
- R2.2: API output remains stable for consumers.
- R2.3: Audit records include selected identifiers.
`)
  writeFileSync(planPath, `# Plan

## Context

This project uses Node ESM helpers and Vitest coverage.

- Preserve the repository's concise markdown conventions.

## Objective

Generate grounded skill briefs.
`)
}

const requirements = [
  {
    id: 'R1',
    title: 'Matching',
    criteria: [
      { id: 'R1.1', clause: 'The API client has a stable response.' },
      { id: 'R1.2', clause: 'A rapid response remains available.' },
      { id: 'R1.3', clause: 'A prepayment workflow is supported.' },
    ],
  },
]

describe('selectCriteria', () => {
  test('matches short facet tokens on word boundaries and long tokens by substring', () => {
    // Arrange
    const facet = 'api-payment'

    // Act
    const selected = selectCriteria(requirements, facet)

    // Assert
    expect(selected).toEqual([
      { id: 'R1.1', clause: 'The API client has a stable response.' },
      { id: 'R1.3', clause: 'A prepayment workflow is supported.' },
    ])
  })

  test('uses explicit R-IDs in requested order instead of facet matching', () => {
    // Arrange
    const explicitRids = ['r1.3', 'R1.1']

    // Act
    const selected = selectCriteria(requirements, 'unmatched', explicitRids)

    // Assert
    expect(selected.map(({ id }: { id: string }) => id)).toEqual(['R1.3', 'R1.1'])
  })

  test('returns an empty selection for an empty effective requirement set', () => {
    // Arrange
    const emptyRequirements: never[] = []

    // Act
    const selected = selectCriteria(emptyRequirements, 'payment')

    // Assert
    expect(selected).toEqual([])
  })

  test('rejects unknown and duplicate explicit R-IDs', () => {
    // Arrange
    const selectUnknown = () => selectCriteria(requirements, 'payment', ['R9.9'])
    const selectDuplicate = () => selectCriteria(requirements, 'payment', ['R1.1', 'r1.1'])

    // Act / Assert
    expect(selectUnknown).toThrow(/unknown --rids ID R9\.9/)
    expect(selectDuplicate).toThrow(/duplicate --rids ID R1\.1/)
  })
})

describe('facetSlug', () => {
  test('lowercases, replaces whitespace, and strips non-slug characters', () => {
    // Arrange
    const facet = 'API & Data!'

    // Act
    const slug = facetSlug(facet)

    // Assert
    expect(slug).toBe('api--data')
  })

  test('preserves hyphens and returns an empty slug when every character is stripped', () => {
    // Arrange
    const hyphenated = 'Skill--Lint'

    // Act
    const slug = facetSlug(hyphenated)
    const empty = facetSlug('!!!')

    // Assert
    expect(slug).toBe('skill--lint')
    expect(empty).toBe('')
  })
})

describe('renderBrief', () => {
  test('exposes the complete C1 CLI contract export', () => {
    // Arrange / Act / Assert
    expect(runCli).toBeTypeOf('function')
  })

  test('renders contract sections in order with verbatim criteria and provenance rules', () => {
    // Arrange
    const input = {
      facet: 'payment',
      criteria: [{ id: 'R2.1', clause: 'Keep **this clause** verbatim.' }],
      projectContext: 'Project-specific terminology belongs here.',
      warnings: ['A degraded condition occurred.'],
      headSha: 'abc123',
    }

    // Act
    const markdown = renderBrief(input)

    // Assert
    expect(markdown).toContain('anchor: abc123 -->')
    expect(markdown).toContain('- R2.1: Keep **this clause** verbatim.')
    expect(markdown).toContain('Cite the source')
    expect(markdown).toContain('`Source: <URL or reference>`')
    expect(markdown).toContain('`derived, unverified`')
    expect(markdown.indexOf('## Warning')).toBeLessThan(markdown.indexOf('## Facet gap'))
    expect(markdown.indexOf('## Facet gap')).toBeLessThan(markdown.indexOf('## Project context'))
    expect(markdown.indexOf('## Project context')).toBeLessThan(markdown.indexOf('## Provenance'))
  })
})

describe('fitBrief', () => {
  test('drops project context before whole criteria from the last selected backward', () => {
    // Arrange
    const criteria = Array.from({ length: 6 }, (_, index) => ({
      id: `R1.${index + 1}`,
      clause: `criterion-${index + 1}-${'x'.repeat(1800)}`,
    }))
    const input = {
      facet: 'budget',
      criteria,
      projectContext: `context-${'y'.repeat(9000)}`,
      warnings: [],
      headSha: null,
    }

    // Act
    const fitted = fitBrief(input)

    // Assert
    expect(fitted.tokens).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET)
    expect(fitted.dropped[0]).toBe('Project context')
    expect(fitted.dropped.slice(1)).toEqual(['R1.6', 'R1.5'])
    expect(fitted.markdown).toContain('criterion-1-')
    expect(fitted.markdown).toContain('criterion-3-')
    expect(fitted.markdown).toContain('criterion-4-')
    expect(fitted.markdown).not.toContain('criterion-5-')
    expect(fitted.markdown).not.toContain('## Project context')
    expect(fitted.markdown).toContain(
      `- (+${fitted.dropped.length} lower-priority items omitted — read .codex-flow/PLAN.md and REQUIREMENTS.md)`,
    )
  })

  test('keeps a brief at the budget boundary and rejects impossible mandatory content', () => {
    // Arrange
    const input = {
      facet: 'boundary',
      criteria: [],
      projectContext: null,
      warnings: [],
      headSha: null,
    }
    const rendered = renderBrief(input)
    const exactBudget = Math.ceil(rendered.length / 4)

    // Act
    const fitted = fitBrief(input, exactBudget)
    const impossible = () => fitBrief(input, 1)

    // Assert
    expect(fitted.markdown).toBe(rendered)
    expect(fitted.tokens).toBe(exactBudget)
    expect(impossible).toThrow(/mandatory brief content exceeds tokenBudget 1/)
  })
})

describe('skill-brief CLI', () => {
  test('writes a conforming default brief with selected criteria and project context', () => {
    // Arrange
    const fixture = createFixture()
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payment'],
      { cwd: fixture.directory, encoding: 'utf8' },
    )
    const outputPath = join(fixture.directory, '.codex-flow', 'SKILL-BRIEF-payment.md')
    const markdown = readFileSync(outputPath, 'utf8')

    // Assert
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(markdown).toMatch(/^<!-- generated by skill-brief\.mjs — do not hand-edit;/)
    expect(markdown).toContain('anchor: null -->')
    expect(markdown).toContain('# Skill authoring brief — payment')
    expect(markdown).toContain('- R2.1: Payment workflows cite their source material.')
    expect(markdown).toContain('This project uses Node ESM helpers and Vitest coverage.')
    expect(markdown).not.toContain('## Warning')
  })

  test('lets --rids override facet matching and validates IDs against the effective set', () => {
    // Arrange
    const fixture = createFixture('skill-brief-rids-')
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)
    const outputPath = join(fixture.directory, 'override.md')

    // Act
    const passing = spawnSync(process.execPath, [
      SKILL_BRIEF_SCRIPT,
      '--facet',
      'payment',
      '--rids',
      'R2.3,R2.2',
      '--out',
      outputPath,
    ], { cwd: fixture.directory, encoding: 'utf8' })
    const markdown = readFileSync(outputPath, 'utf8')
    const failing = spawnSync(process.execPath, [
      SKILL_BRIEF_SCRIPT,
      '--facet',
      'payment',
      '--rids',
      'R9.9',
    ], { cwd: fixture.directory, encoding: 'utf8' })

    // Assert
    expect(passing.status).toBe(0)
    expect(markdown.indexOf('- R2.3:')).toBeLessThan(markdown.indexOf('- R2.2:'))
    expect(markdown).not.toContain('- R2.1:')
    expect(failing.status).toBe(1)
    expect(failing.stdout).toBe('')
    expect(failing.stderr).toMatch(/^skill-brief: unknown --rids ID R9\.9/m)
  })

  test('renders added criteria and omits removed criteria from the effective requirement set', () => {
    // Arrange
    const fixture = createFixture('skill-brief-deltas-')
    writeFileSync(fixture.requirementsPath, `## R2: Payment workflow
- R2.1: Legacy payment handling remains available.
- R2.2: Stable API output remains available.

## Deltas
### 2026-08-07 ADDED R2.3
New payment handling records audit identifiers.

### 2026-08-07 REMOVED R2.1
`)
    writeFileSync(fixture.planPath, '## Context\nUse the effective requirements.\n')

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payment'],
      { cwd: fixture.directory, encoding: 'utf8' },
    )
    const markdown = readFileSync(
      join(fixture.directory, '.codex-flow', 'SKILL-BRIEF-payment.md'),
      'utf8',
    )

    // Assert
    expect(result.status).toBe(0)
    expect(markdown).toContain('- R2.3: New payment handling records audit identifiers.')
    expect(markdown).not.toContain('R2.1')
    expect(markdown).not.toContain('Legacy payment handling remains available.')
  })

  test('fits oversized CLI inputs and writes the exact restoration pointer', () => {
    // Arrange
    const fixture = createFixture('skill-brief-budget-')
    const criteria = Array.from({ length: 6 }, (_, index) =>
      `- R1.${index + 1}: budget-criterion-${index + 1}-${'x'.repeat(1800)}`,
    ).join('\n')
    writeFileSync(fixture.requirementsPath, `## R1: Budget\n${criteria}\n`)
    writeFileSync(
      fixture.planPath,
      `## Context\nproject-context-marker-${'y'.repeat(9000)}\n\n## Objective\nFit the brief.\n`,
    )
    const outputPath = join(fixture.directory, 'budget-brief.md')

    // Act
    const result = spawnSync(process.execPath, [
      SKILL_BRIEF_SCRIPT,
      '--facet',
      'budget',
      '--out',
      outputPath,
    ], { cwd: fixture.directory, encoding: 'utf8' })
    const markdown = readFileSync(outputPath, 'utf8')

    // Assert
    expect(result.status).toBe(0)
    expect(Math.ceil(markdown.length / 4)).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET)
    expect(markdown).not.toContain('## Project context')
    expect(markdown).not.toContain('project-context-marker-')
    expect(markdown).toContain('- R1.4: budget-criterion-4-')
    expect(markdown).not.toContain('- R1.5: budget-criterion-5-')
    expect(markdown).toContain(
      '- (+3 lower-priority items omitted — read .codex-flow/PLAN.md and REQUIREMENTS.md)',
    )
  })

  test('rejects output paths that collide with inputs without modifying either input', () => {
    // Arrange
    const fixture = createFixture('skill-brief-collision-')
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)
    const originalRequirements = readFileSync(fixture.requirementsPath, 'utf8')
    const originalPlan = readFileSync(fixture.planPath, 'utf8')

    // Act
    const results = [fixture.requirementsPath, fixture.planPath].map((outputPath) => spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payment', '--out', outputPath],
      { cwd: fixture.directory, encoding: 'utf8' },
    ))

    // Assert
    expect(results.every(({ status }) => status === 1)).toBe(true)
    expect(results.every(({ stderr }) => stderr.startsWith('skill-brief: --out must not overwrite')))
      .toBe(true)
    expect(readFileSync(fixture.requirementsPath, 'utf8')).toBe(originalRequirements)
    expect(readFileSync(fixture.planPath, 'utf8')).toBe(originalPlan)
  })

  test('rejects a symlinked --out without modifying its target', () => {
    // Arrange
    const fixture = createFixture('skill-brief-symlink-')
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)
    const targetPath = join(fixture.directory, 'target.md')
    const outputPath = join(fixture.directory, 'brief.md')
    const originalTarget = 'do not overwrite\n'
    writeFileSync(targetPath, originalTarget)
    symlinkSync(targetPath, outputPath)

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payment', '--out', outputPath],
      { cwd: fixture.directory, encoding: 'utf8' },
    )

    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('skill-brief: --out must not be a symlink\n')
    expect(readFileSync(targetPath, 'utf8')).toBe(originalTarget)
  })

  test('atomically writes a normal --out path', () => {
    // Arrange
    const fixture = createFixture('skill-brief-atomic-')
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)
    const outputPath = join(fixture.directory, 'brief.md')
    writeFileSync(outputPath, 'replace this regular file\n')

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payment', '--out', outputPath],
      { cwd: fixture.directory, encoding: 'utf8' },
    )

    // Assert
    expect(result.status).toBe(0)
    expect(readFileSync(outputPath, 'utf8')).toContain('# Skill authoring brief — payment')
    expect(existsSync(`${outputPath}.tmp-${result.pid}`)).toBe(false)
  })

  test('rejects control characters in a facet before rendering Markdown', () => {
    // Arrange
    const fixture = createFixture('skill-brief-injected-facet-')
    writeStandardInputs(fixture.requirementsPath, fixture.planPath)
    const outputPath = join(fixture.directory, 'injected.md')
    const facet = 'demo\n## Injected'

    // Act
    const result = spawnSync(process.execPath, [
      SKILL_BRIEF_SCRIPT,
      '--facet',
      facet,
      '--out',
      outputPath,
    ], { cwd: fixture.directory, encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^skill-brief: facet must not contain control characters/m)
    expect(existsSync(outputPath)).toBe(false)
  })

  test('degrades missing requirements and plan inputs to warning bullets and exit zero', () => {
    // Arrange
    const fixture = createFixture('skill-brief-missing-')

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'demo'],
      { cwd: fixture.directory, encoding: 'utf8' },
    )
    const markdown = readFileSync(
      join(fixture.directory, '.codex-flow', 'SKILL-BRIEF-demo.md'),
      'utf8',
    )

    // Assert
    expect(result.status).toBe(0)
    expect(markdown).toContain('## Warning')
    expect(markdown).toContain('- REQUIREMENTS.md is missing;')
    expect(markdown).toContain('- PLAN.md is missing;')
    expect(markdown).toContain('- No matching R-IDs were found for facet "demo".')
  })

  test('degrades zero facet matches and a missing Context section without failing', () => {
    // Arrange
    const fixture = createFixture('skill-brief-no-match-')
    writeFileSync(fixture.requirementsPath, `## R1: Existing
- R1.1: Authentication is available.
`)
    writeFileSync(fixture.planPath, `# Plan

## Objective
No Context section is present.
`)

    // Act
    const result = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'payments'],
      { cwd: fixture.directory, encoding: 'utf8' },
    )
    const markdown = readFileSync(
      join(fixture.directory, '.codex-flow', 'SKILL-BRIEF-payments.md'),
      'utf8',
    )

    // Assert
    expect(result.status).toBe(0)
    expect(markdown).toContain('PLAN.md has no non-empty ## Context section;')
    expect(markdown).toContain('No matching R-IDs were found for facet "payments".')
    expect(markdown).not.toContain('## Project context')
  })

  test('fails malformed requirements and unreadable existing inputs with prefixed errors', () => {
    // Arrange
    const malformed = createFixture('skill-brief-malformed-')
    writeFileSync(malformed.requirementsPath, '')
    writeFileSync(malformed.planPath, '## Context\nAvailable context.\n')
    const unreadable = createFixture('skill-brief-unreadable-')
    mkdirSync(join(unreadable.directory, 'requirements-directory'))

    // Act
    const malformedResult = spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, '--facet', 'demo'],
      { cwd: malformed.directory, encoding: 'utf8' },
    )
    const unreadableResult = spawnSync(process.execPath, [
      SKILL_BRIEF_SCRIPT,
      '--facet',
      'demo',
      '--requirements',
      join(unreadable.directory, 'requirements-directory'),
    ], { cwd: unreadable.directory, encoding: 'utf8' })

    // Assert
    expect(malformedResult.status).toBe(1)
    expect(malformedResult.stderr).toMatch(
      /^skill-brief: effective requirement set has zero criteria/m,
    )
    expect(unreadableResult.status).toBe(1)
    expect(unreadableResult.stderr).toMatch(/^skill-brief: cannot read /m)
  })

  test('fails empty, duplicate, unknown, and malformed CLI arguments', () => {
    // Arrange
    const fixture = createFixture('skill-brief-args-')
    const invocations = [
      [],
      ['--facet', 'demo', '--facet', 'again'],
      ['--facet', 'demo', '--unknown', 'value'],
      ['--facet', 'demo', '--rids', 'R2'],
      ['--facet', ''],
    ]

    // Act
    const results = invocations.map((args) => spawnSync(
      process.execPath,
      [SKILL_BRIEF_SCRIPT, ...args],
      { cwd: fixture.directory, encoding: 'utf8' },
    ))

    // Assert
    expect(results.every(({ status }) => status === 1)).toBe(true)
    expect(results.every(({ stderr }) => stderr.startsWith('skill-brief: '))).toBe(true)
  })
})
