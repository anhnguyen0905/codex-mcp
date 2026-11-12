import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SKILL_PATH = path.resolve('skills', 'brainstorm-lenses', 'SKILL.md')

function readSkill(): string {
  return readFileSync(SKILL_PATH, 'utf8').replace(/\r\n/g, '\n')
}

function fencedBlocks(skill: string): string[] {
  return [...skill.matchAll(/```\n([\s\S]*?)\n```/g)].map((match) => match[1])
}

describe('brainstorm-lenses skill', () => {
  test('has the required frontmatter', () => {
    // Arrange
    const skill = readSkill()
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1]

    // Act
    const lines = frontmatter?.split('\n') ?? []

    // Assert
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('name: brainstorm-lenses')
    expect(lines[1]).toMatch(/^description: \S(?:.*\S)?$/)
  })

  test('lists the four lenses in order', () => {
    // Arrange
    const skill = readSkill()

    // Act
    const headings = [...skill.matchAll(/^### (.+)$/gm)].map((match) => match[1])

    // Assert
    expect(headings).toEqual(['Frame lens', 'Map lens', 'Reason lens', 'Feasibility lens'])
  })

  test('requires a source suffix on every lens bullet', () => {
    // Arrange
    const blocks = fencedBlocks(readSkill())
    const bulletLines = blocks.flatMap((block) => block.split('\n').filter((line) => line.startsWith('- ')))

    // Act
    const unsourcedLines = bulletLines.filter((line) => !/\([^()\n]+\)$/.test(line))

    // Assert
    expect(blocks).toHaveLength(4)
    expect(unsourcedLines).toEqual([])
  })

  test('contains no forbidden wording', () => {
    // Arrange
    const skill = readSkill()

    // Act
    const forbiddenMatches = skill.match(/fall back|continue without|PDCA/gi)

    // Assert
    expect(forbiddenMatches).toBeNull()
  })

  test('stays within the LF byte budget', () => {
    // Arrange
    const skill = readSkill()

    // Act
    const byteLength = Buffer.byteLength(skill, 'utf8')

    // Assert
    expect(byteLength).toBeLessThanOrEqual(10_000)
  })
})
