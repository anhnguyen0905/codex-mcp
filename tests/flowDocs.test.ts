import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTEXT_DISCIPLINE_PATH = path.join(REPO_ROOT, 'skills', 'context-discipline', 'SKILL.md')
const PARALLEL_EXECUTION_PATH = path.join(REPO_ROOT, 'skills', 'parallel-execution', 'SKILL.md')
const PLAN_ARCHITECTURE_PATH = path.join(REPO_ROOT, 'skills', 'plan-architecture', 'SKILL.md')
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'codex-flow.md')
const CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'codex-flow.md')
const COMMAND_TOKEN_ALLOWLIST = new Set(['codex-flow:codex-flow'])

function readText(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Required flow document does not exist: ${filePath}`)
  }

  return readFileSync(filePath, 'utf8')
}

function extractFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) {
    throw new Error('Expected markdown to start with YAML frontmatter')
  }

  return match[1]
}

function extractPhaseSection(command: string, phaseNumber: number): string {
  const phaseHeading = new RegExp(`^## Phase ${phaseNumber}(?:[ \\t]+.*)?$`, 'm').exec(command)
  if (!phaseHeading) {
    throw new Error(`Phase ${phaseNumber} section is missing from commands/codex-flow.md`)
  }

  const phaseStart = phaseHeading.index
  const bodyStart = command.indexOf('\n', phaseStart)
  if (bodyStart === -1) {
    return command.slice(phaseStart)
  }

  const remainingCommand = command.slice(bodyStart + 1)
  const nextHeadingOffset = remainingCommand.search(/^## /m)
  const phaseEnd = nextHeadingOffset === -1 ? command.length : bodyStart + 1 + nextHeadingOffset

  return command.slice(phaseStart, phaseEnd)
}

function extractLoadSkillsText(phaseSection: string, phaseNumber: number): string {
  const match = phaseSection.match(/^\*\*Load skills? first(?: \(code tasks\))?\*\*:[\s\S]*?(?=\r?\n\r?\n)/m)
  if (!match) {
    throw new Error(`Phase ${phaseNumber} load-skills text is missing from commands/codex-flow.md`)
  }

  return match[0]
}

describe('context-discipline skill documentation', () => {
  test('exists at the documented skill path', () => {
    const skillExists = existsSync(CONTEXT_DISCIPLINE_PATH)

    expect(skillExists).toBe(true)
  })

  test('declares name and description fields in YAML frontmatter', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    const frontmatter = extractFrontmatter(skill)

    expect(frontmatter).toMatch(/^name:\s*context-discipline\s*$/m)
    expect(frontmatter).toMatch(/^description:\s*\S.+$/m)
  })

  test('documents the B1 threshold and the B3 no-mid-task rule', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    expect(skill).toMatch(/(?<![0-9])400(?![0-9])/)
    expect(skill).toContain('NEVER compact mid-task')
    expect(skill).toMatch(/Tell the user this is a\s+safe compaction point and suggest running `\/compact`/)
  })

  test('includes the tiered AGENTS.md section and guidance', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)
    const agentsReferences = skill.match(/AGENTS\.md/g) ?? []

    expect(skill).toMatch(/^## .*AGENTS\.md.*$/m)
    expect(agentsReferences.length).toBeGreaterThanOrEqual(3)
  })
})

describe('plan-architecture Decision log schema', () => {
  test('defines all four handoff fields', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)

    expect(skill).toMatch(/^- Decision:/m)
    expect(skill).toMatch(/^- Why:/m)
    expect(skill).toMatch(/^- Constraint for later tasks:/m)
    expect(skill).toMatch(/^- Contracts touched:/m)
  })
})

describe('parallel-execution worktree branch points', () => {
  test('branches Wave 1 from the current integration branch HEAD', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH)

    expect(skill).toMatch(/\*\*Wave 1\*\*: branch from the CURRENT integration branch HEAD/)
  })
})

describe('codex-flow command structure', () => {
  test.each([2, 4, 5])('names context-discipline in the Phase %i load list', (phaseNumber) => {
    const command = readText(COMMAND_PATH)
    const phaseSection = extractPhaseSection(command, phaseNumber)

    const loadSkillsText = extractLoadSkillsText(phaseSection, phaseNumber)

    expect(loadSkillsText).toMatch(/codex-flow:context-discipline(?![a-z0-9-])/)
  })

  test('keeps the Claude command mirror byte-identical', () => {
    const command = readFileSync(COMMAND_PATH)
    const claudeCommand = readFileSync(CLAUDE_COMMAND_PATH)

    const commandsAreIdentical = command.equals(claudeCommand)

    expect(commandsAreIdentical).toBe(true)
  })

  test('resolves every referenced skill token to an existing SKILL.md', () => {
    const command = readText(COMMAND_PATH)
    const referencedTokens = [...new Set(command.match(/codex-flow:[a-z0-9-]+/g) ?? [])]
    const referencedTokenCandidates = [
      ...new Set(command.match(/codex-flow:[A-Za-z0-9-]+/g) ?? []),
    ]

    const malformedTokens = referencedTokenCandidates.filter(
      (token) => !/^codex-flow:[a-z0-9-]+$/.test(token),
    )
    const missingSkills = referencedTokens
      .filter((token) => !COMMAND_TOKEN_ALLOWLIST.has(token))
      .map((token) => token.slice('codex-flow:'.length))
      .filter((skillName) => !existsSync(path.join(REPO_ROOT, 'skills', skillName, 'SKILL.md')))

    expect(malformedTokens).toEqual([])
    expect(missingSkills).toEqual([])
  })
})
