import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import { lintSkillText } from '../scripts/skill-lint.mjs'

const SKILL_LINT_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'skill-lint.mjs',
)
const VALID_SKILL = `---
name: authored-skill
description: Apply the authored workflow safely.
---

# Authored skill

Serves: authored workflow — R4.1, R4.2

## Core method

Follow the grounded method. Source: REQUIREMENTS.md R4.1.

## Failure modes

- Stop on invalid input; derived, unverified.

## Reviewer checklist

- Confirm the output. Source: REQUIREMENTS.md R4.2.

## Provenance

- Source: REQUIREMENTS.md R4.1.
- Rule is derived, unverified.
`
const tempDirectories: string[] = []

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

describe('lintSkillText', () => {
  test('accepts a fully conforming skill', () => {
    // Arrange
    const text = VALID_SKILL

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toEqual([])
  })

  test('rejects a skill without opening frontmatter', () => {
    // Arrange
    const text = VALID_SKILL.replace('---\n', '')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations[0]).toBe('frontmatter must start with a `---` line')
  })

  test('rejects a frontmatter block without a closing delimiter', () => {
    // Arrange
    const text = VALID_SKILL.replace('\n---\n\n# Authored skill', '\n\n# Authored skill')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('frontmatter must be closed by a `---` line')
  })

  test('rejects a name outside the lowercase kebab-case format', () => {
    // Arrange
    const text = VALID_SKILL.replace('name: authored-skill', 'name: Authored_Skill')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('frontmatter name must match /^[a-z0-9][a-z0-9-]*$/')
  })

  test('rejects an empty frontmatter name', () => {
    // Arrange
    const text = VALID_SKILL.replace('name: authored-skill', 'name:')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('frontmatter name is required')
  })

  test('rejects a missing frontmatter description', () => {
    // Arrange
    const text = VALID_SKILL.replace('description: Apply the authored workflow safely.\n', '')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      'frontmatter description is required and must be single-line',
    )
  })

  test('rejects a YAML block-scalar frontmatter description', () => {
    // Arrange
    const texts = ['>', '|'].map((indicator) => VALID_SKILL.replace(
      'description: Apply the authored workflow safely.',
      `description: ${indicator}\n  Apply the authored workflow safely.`,
    ))

    // Act
    const violations = texts.map((text) => lintSkillText(text))

    // Assert
    expect(violations.every((findings) => (
      findings.includes('description must be a single-line literal value')
    ))).toBe(true)
  })

  test('rejects a tagged YAML block-scalar frontmatter description', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      'description: Apply the authored workflow safely.',
      'description: !!str |\n  Apply the authored workflow safely.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('description must be a single-line literal value')
  })

  test.each([
    ['missing', 'Serves: authored workflow — R4.1, R4.2\n', ''],
    ['malformed', 'Serves: authored workflow — R4.1, R4.2', 'Serves: authored workflow - R4.1'],
  ])('rejects a %s Serves line', (_case, original, replacement) => {
    // Arrange
    const text = VALID_SKILL.replace(original, replacement)

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      'body must contain a Serves line matching /^Serves: \\S.* — R\\d+\\.\\d+(, R\\d+\\.\\d+)*$/',
    )
  })

  test('rejects a Serves line present only inside a fenced code block', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      'Serves: authored workflow — R4.1, R4.2',
      '```text\nServes: authored workflow — R4.1, R4.2\n```',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      'body must contain a Serves line matching /^Serves: \\S.* — R\\d+\\.\\d+(, R\\d+\\.\\d+)*$/',
    )
  })

  test.each([
    '## Core method',
    '## Failure modes',
    '## Reviewer checklist',
    '## Provenance',
  ])('rejects a skill missing the required %s section', (section) => {
    // Arrange
    const text = VALID_SKILL.replace(`${section}\n`, '')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(`missing required section: ${section}`)
  })

  test('rejects a required heading present only inside a fenced code block', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '## Core method\n\nFollow the grounded method. Source: REQUIREMENTS.md R4.1.',
      '```markdown\n## Core method\n```',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('missing required section: ## Core method')
  })

  test('rejects a required heading inside a tilde fence despite a backtick fence line', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '## Core method\n\nFollow the grounded method. Source: REQUIREMENTS.md R4.1.',
      '~~~markdown\n```\n## Core method\n~~~',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('missing required section: ## Core method')
  })

  test('does not truncate a real section at a code-fenced fake heading', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      'Follow the grounded method. Source: REQUIREMENTS.md R4.1.',
      '```markdown\n## Failure modes\n```\n\nFollow the grounded method. Source: REQUIREMENTS.md R4.1.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toEqual([])
  })

  test('rejects an empty Provenance section', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '- Source: REQUIREMENTS.md R4.1.\n- Rule is derived, unverified.\n',
      'No provenance entries yet.\n',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain('## Provenance must contain at least one top-level bullet')
  })

  test('rejects every top-level Provenance bullet without an allowed label', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '- Source: REQUIREMENTS.md R4.1.\n- Rule is derived, unverified.',
      '- REQUIREMENTS.md R4.1.\n- Locally inferred rule.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toEqual([
      '## Provenance bullet must contain Source: or derived, unverified: - REQUIREMENTS.md R4.1.',
      '## Provenance bullet must contain Source: or derived, unverified: - Locally inferred rule.',
    ])
  })

  test('rejects Core method without a provenance label', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      'Follow the grounded method. Source: REQUIREMENTS.md R4.1.',
      'Follow the grounded method.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      '## Core method carries no provenance label (Source: or "derived, unverified")',
    )
  })

  test('rejects Failure modes without a provenance label', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '- Stop on invalid input; derived, unverified.',
      '- Stop on invalid input.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      '## Failure modes carries no provenance label (Source: or "derived, unverified")',
    )
  })

  test('rejects Reviewer checklist without a provenance label', () => {
    // Arrange
    const text = VALID_SKILL.replace(
      '- Confirm the output. Source: REQUIREMENTS.md R4.2.',
      '- Confirm the output.',
    )

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toContain(
      '## Reviewer checklist carries no provenance label (Source: or "derived, unverified")',
    )
  })

  test('collects independent violations in contract order', () => {
    // Arrange
    const text = `---
name: Invalid_Name
description:
---

## Provenance
- Unlabelled provenance.
`

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toEqual([
      'frontmatter name must match /^[a-z0-9][a-z0-9-]*$/',
      'frontmatter description is required and must be single-line',
      'body must contain a Serves line matching /^Serves: \\S.* — R\\d+\\.\\d+(, R\\d+\\.\\d+)*$/',
      'missing required section: ## Core method',
      'missing required section: ## Failure modes',
      'missing required section: ## Reviewer checklist',
      '## Provenance bullet must contain Source: or derived, unverified: - Unlabelled provenance.',
    ])
  })

  test('accepts CRLF line endings', () => {
    // Arrange
    const text = VALID_SKILL.replaceAll('\n', '\r\n')

    // Act
    const violations = lintSkillText(text)

    // Assert
    expect(violations).toEqual([])
  })

  test('rejects non-string input at the pure-function boundary', () => {
    // Arrange
    const text = undefined

    // Act
    const lint = () => lintSkillText(text)

    // Assert
    expect(lint).toThrow(/skill text must be a string/)
  })
})

describe('skill-lint CLI', () => {
  test('exits zero for a conforming file and one with prefixed findings for an invalid file', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'skill-lint-'))
    tempDirectories.push(directory)
    const validPath = join(directory, 'valid-SKILL.md')
    const invalidPath = join(directory, 'invalid-SKILL.md')
    writeFileSync(validPath, VALID_SKILL)
    writeFileSync(invalidPath, VALID_SKILL.replace('## Core method\n', ''))

    // Act
    const passing = spawnSync(process.execPath, [SKILL_LINT_SCRIPT, validPath], {
      encoding: 'utf8',
    })
    const failing = spawnSync(process.execPath, [SKILL_LINT_SCRIPT, invalidPath], {
      encoding: 'utf8',
    })

    // Assert
    expect(passing.status).toBe(0)
    expect(passing.stdout.trim()).toBe(`skill-lint: OK ${validPath}`)
    expect(passing.stderr).toBe('')
    expect(failing.status).toBe(1)
    expect(failing.stdout).toBe('')
    expect(failing.stderr.trim().split('\n')).toEqual([
      'skill-lint: missing required section: ## Core method',
    ])
  })

  test.each([
    { caseName: 'missing path', args: [] },
    { caseName: 'extra path', args: ['one.md', 'two.md'] },
  ])(
    'exits one with a usage error for $caseName',
    ({ args }) => {
      // Arrange
      const command = [SKILL_LINT_SCRIPT, ...args]

      // Act
      const result = spawnSync(process.execPath, command, { encoding: 'utf8' })

      // Assert
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe(
        'skill-lint: usage: node scripts/skill-lint.mjs <SKILL.md path>',
      )
    },
  )

  test('exits one with a prefixed error for a missing file', () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'skill-lint-'))
    tempDirectories.push(directory)
    const missingPath = join(directory, 'missing-SKILL.md')

    // Act
    const result = spawnSync(process.execPath, [SKILL_LINT_SCRIPT, missingPath], {
      encoding: 'utf8',
    })

    // Assert
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`skill-lint: cannot read ${missingPath}:`)
  })
})
