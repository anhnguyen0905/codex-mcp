import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  parseSkillMeta,
  buildIndex,
  renderIndex,
  runCli,
  compareVersionDirs,
  pluginSkillRoots,
  defaultRoots,
} from '../scripts/build-skills-index.mjs'

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

describe('compareVersionDirs', () => {
  test('orders numeric version dirs newest-last, not lexically', () => {
    // Arrange
    const versions = ['0.9.0', '0.13.0', '0.10.0', '0.3.0']

    // Act
    const sorted = [...versions].sort(compareVersionDirs)

    // Assert
    expect(sorted).toEqual(['0.3.0', '0.9.0', '0.10.0', '0.13.0'])
  })

  test('falls back to a lexical compare for non-numeric names', () => {
    expect([...['main', 'dev']].sort(compareVersionDirs)).toEqual(['dev', 'main'])
  })
})

describe('pluginSkillRoots', () => {
  const addPluginSkill = async (rel: string, name: string) => {
    const dir = path.join(root, '.claude', 'plugins', 'cache', rel, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), SKILL(name, `${name} description.`), 'utf8')
  }

  test('returns only the newest version of each installed plugin', async () => {
    // Arrange
    await addPluginSkill('mkt/plugin-a/0.9.0/skills', 'old-skill')
    await addPluginSkill('mkt/plugin-a/0.10.0/skills', 'new-skill')

    // Act
    const roots = await pluginSkillRoots(root)

    // Assert
    expect(roots).toEqual([
      path.join(root, '.claude', 'plugins', 'cache', 'mkt', 'plugin-a', '0.10.0', 'skills'),
    ])
  })

  test('supports plugins whose skills dir is not nested under a version', async () => {
    await addPluginSkill('mkt/plugin-b/skills', 'flat-skill')

    const roots = await pluginSkillRoots(root)

    expect(roots).toEqual([
      path.join(root, '.claude', 'plugins', 'cache', 'mkt', 'plugin-b', 'skills'),
    ])
  })

  test("includes the flow's own cached plugin so exec-* language skills stay selectable", async () => {
    await addPluginSkill('codex-mcp/codex-flow/0.13.0/skills', 'exec-python')

    expect(await pluginSkillRoots(root)).toEqual([
      path.join(root, '.claude', 'plugins', 'cache', 'codex-mcp', 'codex-flow', '0.13.0', 'skills'),
    ])
  })

  test('returns an empty list when no plugin cache exists', async () => {
    expect(await pluginSkillRoots(root)).toEqual([])
  })

  test('indexes plugin skills as trusted (no vetted flag)', async () => {
    // Arrange
    await addPluginSkill('mkt/plugin-c/1.0.0/skills', 'market-research')

    // Act
    const { entries } = await buildIndex(await pluginSkillRoots(root))

    // Assert
    expect(entries).toEqual([
      expect.objectContaining({ name: 'market-research', description: 'market-research description.' }),
    ])
    expect(entries[0]).not.toHaveProperty('vetted')
  })
})

describe('defaultRoots', () => {
  test('scans the user skills dir, the library, and installed plugin skills', async () => {
    // Arrange
    const pluginSkills = path.join(root, '.claude', 'plugins', 'cache', 'mkt', 'p', '1.0.0', 'skills')
    await mkdir(path.join(pluginSkills, 'x'), { recursive: true })
    await writeFile(path.join(pluginSkills, 'x', 'SKILL.md'), SKILL('x', 'X.'), 'utf8')

    // Act
    const roots = await defaultRoots(root)

    // Assert
    expect(roots).toEqual([
      path.join(root, '.claude', 'skills'),
      path.join(root, 'claude-skill-library'),
      pluginSkills,
    ])
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
