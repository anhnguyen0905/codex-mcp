import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { PD_RULES, SCHEMES } from '../scripts/debate-parse.mjs'

const SKILL_PATH = fileURLToPath(new URL('../skills/brainstorm-argumentation/SKILL.md', import.meta.url))

function readSkill(): string {
  return readFileSync(SKILL_PATH, 'utf8').replace(/\r\n/g, '\n')
}

function debateBlock(skill: string): string {
  return skill.match(/### Debate block\n\n```\n([\s\S]*?)\n```/)?.[1] ?? ''
}

describe('brainstorm-argumentation skill', () => {
  test('has the required frontmatter and debate block', () => {
    // Arrange
    const skill = readSkill()
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1]?.split('\n') ?? []

    // Act
    const block = debateBlock(skill)

    // Assert
    expect(frontmatter).toHaveLength(2)
    expect(frontmatter[0]).toBe('name: brainstorm-argumentation')
    expect(frontmatter[1]).toMatch(/^description: \S(?:.*\S)?$/)
    expect(block.startsWith('Debate block\n')).toBe(true)
  })

  test('sources every bullet', () => {
    // Arrange
    const lines = debateBlock(readSkill()).split('\n').filter((line) => /^\s*- /.test(line))

    // Act
    const unsourced = lines.filter((line) => !/\([^()\n]+\)$/.test(line))

    // Assert
    expect(unsourced).toEqual([])
  })

  test('matches parser schemes and critical-question counts', () => {
    // Arrange
    const lines = debateBlock(readSkill()).split('\n')

    // Act
    const counts = Object.fromEntries(Object.keys(SCHEMES).map((scheme, index, schemes) => {
      const start = lines.findIndex((line) => line.startsWith(`- ${scheme} (`))
      const next = index + 1 < schemes.length
        ? lines.findIndex((line) => line.startsWith(`- ${schemes[index + 1]} (`))
        : lines.length
      return [scheme, lines.slice(start, next).filter((line) => /CQ\d+/.test(line)).length]
    }))

    // Assert
    expect(Object.keys(counts)).toEqual(Object.keys(SCHEMES))
    expect(counts).toEqual(SCHEMES)
    expect(lines.filter((line) => /^- (?:PD\d+)/.test(line)).map((line) => line.match(/PD\d+/)?.[0])).toEqual(PD_RULES)
  })

  test('names every Toulmin target and stays within the byte cap', () => {
    // Arrange
    const skill = readSkill()

    // Act
    const targets = ['claim', 'data', 'warrant', 'backing', 'qualifier', 'rebuttal']

    // Assert
    expect(targets.every((target) => skill.includes(target))).toBe(true)
    expect(Buffer.byteLength(skill, 'utf8')).toBeLessThanOrEqual(10_000)
  })
})
