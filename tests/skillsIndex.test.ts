import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseSkillMeta, buildIndex, renderIndex, runCli } from '../scripts/build-skills-index.mjs'

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skills-index-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function addSkill(rel: string, content: string): Promise<void> {
  const dir = path.join(root, rel)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), content, 'utf8')
}

describe('parseSkillMeta', () => {
  test('extracts name and description from frontmatter', () => {
    // Arrange
    const content = SKILL('api-design', 'REST API patterns for production APIs.')

    // Act
    const meta = parseSkillMeta(content)

    // Assert
    expect(meta).toEqual({
      name: 'api-design',
      description: 'REST API patterns for production APIs.',
    })
  })

  test('strips surrounding quotes from frontmatter values', () => {
    const meta = parseSkillMeta('---\nname: "quoted"\ndescription: \'also quoted\'\n---\n')

    expect(meta).toEqual({ name: 'quoted', description: 'also quoted' })
  })

  test('falls back to first heading and paragraph when frontmatter is missing', () => {
    const meta = parseSkillMeta('# My Skill\n\nDoes a useful thing.\n')

    expect(meta).toEqual({ name: 'My Skill', description: 'Does a useful thing.' })
  })

  test('returns null fields for empty content', () => {
    expect(parseSkillMeta('')).toEqual({ name: null, description: null })
  })

  test('joins YAML folded and literal block scalar descriptions', () => {
    const folded = '---\nname: folded\ndescription: >\n  A multi-line\n  description here.\n---\n'
    const literal = '---\nname: literal\ndescription: |-\n  Line one.\n  Line two.\n---\n'

    expect(parseSkillMeta(folded).description).toBe('A multi-line description here.')
    expect(parseSkillMeta(literal).description).toBe('Line one. Line two.')
  })
})

describe('buildIndex', () => {
  test('collects nested SKILL.md files with directory-name fallback for the name', async () => {
    // Arrange
    await addSkill('api-design', SKILL('api-design', 'REST API patterns.'))
    await addSkill('nested/deeper/go-idioms', '---\ndescription: Go idioms.\n---\n')

    // Act
    const { entries, warnings } = await buildIndex([root])

    // Assert
    expect(warnings).toEqual([])
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['api-design', 'go-idioms'])
    expect(entries[1].description).toBe('Go idioms.')
    expect(entries[0].file).toBe(path.join(root, 'api-design', 'SKILL.md'))
  })

  test('skips node_modules and .git directories', async () => {
    await addSkill('real-skill', SKILL('real-skill', 'Real.'))
    await addSkill('node_modules/dep-skill', SKILL('dep-skill', 'Should not appear.'))
    await addSkill('.git/hooks-skill', SKILL('hooks-skill', 'Should not appear.'))

    const { entries } = await buildIndex([root])

    expect(entries.map((e: { name: string }) => e.name)).toEqual(['real-skill'])
  })

  test('warns about missing roots instead of throwing', async () => {
    const missing = path.join(root, 'does-not-exist')

    const { entries, warnings } = await buildIndex([missing])

    expect(entries).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('does-not-exist')
  })
})

describe('renderIndex', () => {
  test('renders one grep-friendly line per skill and sanitizes pipes/newlines', () => {
    // Arrange
    const entries = [
      { name: 'a-skill', description: 'Line one\nwith | pipe.', file: '/tmp/a/SKILL.md' },
    ]

    // Act
    const output = renderIndex(entries)

    // Assert
    const lines = output.trimEnd().split('\n')
    const last = lines[lines.length - 1]
    expect(last).toBe('a-skill | Line one with / pipe. | /tmp/a/SKILL.md')
    expect(output).toContain('# Format: <name> | <description> | <SKILL.md path>')
  })
})

describe('runCli', () => {
  test('writes the index file for the given roots and --out path', async () => {
    // Arrange
    await addSkill('cli-skill', SKILL('cli-skill', 'From the CLI test.'))
    const out = path.join(root, 'out', 'INDEX.md')

    // Act
    const summary = await runCli([root, '--out', out])

    // Assert
    const written = await readFile(out, 'utf8')
    expect(written).toContain('cli-skill | From the CLI test.')
    expect(summary.count).toBe(1)
    expect(summary.out).toBe(out)
  })

  test('defaults the output path to CODEX_FLOW_SKILLS_INDEX when set', async () => {
    // Arrange
    await addSkill('env-skill', SKILL('env-skill', 'Env override.'))
    const envOut = path.join(root, 'env', 'INDEX.md')
    process.env.CODEX_FLOW_SKILLS_INDEX = envOut

    try {
      // Act
      const summary = await runCli([root])

      // Assert
      expect(summary.out).toBe(envOut)
      expect(await readFile(envOut, 'utf8')).toContain('env-skill | Env override.')
    } finally {
      delete process.env.CODEX_FLOW_SKILLS_INDEX
    }
  })

  test('fails with a clear error when no roots exist', async () => {
    const missing = path.join(root, 'nope')

    await expect(runCli([missing, '--out', path.join(root, 'INDEX.md')])).rejects.toThrow(
      /no skills found/i,
    )
  })
})
