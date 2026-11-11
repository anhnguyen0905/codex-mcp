import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes, unlink, symlink, readdir, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  indexStaleness,
  parseCatalog,
} from '../scripts/build-skills-index.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { selectSkills } from '../scripts/skill-match.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT = path.resolve('scripts/build-skills-index.mjs')

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

async function snapshotIndex(out: string, library: string) {
  return { bytes: await readFile(out), mtime: (await stat(out)).mtimeMs, listing: await readdir(library) }
}

async function expectUntouched(snapshot: { bytes: Buffer; mtime: number; listing: string[] }, out: string, library: string) {
  expect(await readFile(out)).toEqual(snapshot.bytes)
  expect((await stat(out)).mtimeMs).toBe(snapshot.mtime)
  expect(await readdir(library)).toEqual(snapshot.listing)
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

  test('adds only the roots header beyond the rebuilt timestamp', () => {
    const entries = [{ name: 'a', description: 'A', file: '/tmp/a/SKILL.md' }]
    const normalize = (text: string) => text.replace(/^# Rebuilt: .*$/m, '# Rebuilt: normalized')
    const withoutRoots = normalize(renderIndex(entries)).replace(/^<!-- roots: .*\n/m, '')
    const withRoots = normalize(renderIndex(entries, ['/tmp/root']))
      .replace('<!-- roots: ["/tmp/root"] -->', '<!-- roots: [] -->')
    expect(withRoots).toBe(normalize(renderIndex(entries)))
    expect(withoutRoots).not.toContain('<!-- roots:')
  })
})

describe('indexStaleness', () => {
  const scanned = [{ file: '/tmp/skills/a/SKILL.md', mtimeMs: 9 }]
  const indexed = [{ name: 'a', description: 'A', file: scanned[0].file }]

  test('reports current with no reason', () => {
    // Act
    const result = indexStaleness({ indexEntries: indexed, indexMtimeMs: 10, scanned })

    // Assert
    expect(result).toEqual({ stale: false, reason: null })
  })

  test('reports an indexed skill gone from disk', () => {
    const result = indexStaleness({ indexEntries: indexed, indexMtimeMs: 10, scanned: [] })

    expect(result).toEqual({
      stale: true,
      reason: '1 indexed skill(s) no longer on disk (e.g. /tmp/skills/a/SKILL.md)',
    })
  })

  test('reports a newer skill file', () => {
    const result = indexStaleness({ indexEntries: indexed, indexMtimeMs: 8, scanned })

    expect(result).toEqual({
      stale: true,
      reason: '1 skill file(s) modified at or after the index (e.g. /tmp/skills/a/SKILL.md)',
    })
  })

  test('treats an equal mtime as possibly newer', () => {
    const result = indexStaleness({ indexEntries: indexed, indexMtimeMs: 9, scanned })
    expect(result.reason).toContain('modified at or after the index')
  })

  test('reports a skill on disk that is not indexed', () => {
    const result = indexStaleness({ indexEntries: [], indexMtimeMs: 10, scanned })

    expect(result).toEqual({
      stale: true,
      reason: '1 skill(s) on disk not in the index (e.g. /tmp/skills/a/SKILL.md)',
    })
  })

  test('ignores URL catalog entries', () => {
    const result = indexStaleness({
      indexEntries: [...indexed, { file: 'https://example.com/remote' }],
      indexMtimeMs: 10,
      scanned,
    })

    expect(result).toEqual({ stale: false, reason: null })
  })

  test('uses newer-file precedence over set differences', () => {
    const result = indexStaleness({ indexEntries: [], indexMtimeMs: 1, scanned })
    expect(result).toEqual({
      stale: true,
      reason: '1 skill file(s) modified at or after the index (e.g. /tmp/skills/a/SKILL.md)',
    })
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

  test('checks without writing and reports each stale condition', async () => {
    await addSkill('check-skill', SKILL('check-skill', 'Check.'))
    const out = path.join(root, 'check', 'INDEX.md')
    await runCli([root, '--out', out])
    const before = await readFile(out, 'utf8')
    const beforeMtime = (await stat(out)).mtimeMs

    await expect(runCli([root, '--out', out, '--check'])).resolves.toMatchObject({ stale: false })
    const skillFile = path.join(root, 'check-skill', 'SKILL.md')
    const future = new Date(Date.now() + 10_000)
    await utimes(skillFile, future, future)
    await expect(runCli([root, '--out', out, '--check'])).resolves.toMatchObject({
      stale: true,
      reason: expect.stringContaining('modified at or after the index'),
    })
    await expect(runCli([root, '--out', out, '--check', '--vet', skillFile])).rejects.toThrow(/cannot be combined/)
    expect(await readFile(out, 'utf8')).toBe(before)
    expect((await stat(out)).mtimeMs).toBe(beforeMtime)
    await unlink(out)
    await expect(runCli([root, '--out', out, '--check'])).resolves.toMatchObject({
      stale: true,
      reason: expect.stringContaining('index missing'),
    })
  })

  test.skipIf(process.platform === 'win32')('canonicalizes symlinked roots during check', async () => {
    await addSkill('linked', SKILL('linked', 'Linked.'))
    const link = path.join(root, 'root-link')
    await symlink(root, link)
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    await expect(runCli([link, '--out', out, '--check'])).resolves.toMatchObject({ stale: false })
  })

  test('records roots, detects root changes, and preserves the catalog parser contract', async () => {
    await addSkill('rooted', SKILL('rooted', 'Rooted.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const content = await readFile(out, 'utf8')
    expect(parseCatalog(content)).toEqual(parseCatalog(content.replace(/^<!-- roots:.*\n/m, '')))
    const before = await readFile(out, 'utf8')
    const listing = await readdir(root)
    const result = await runCli([path.join(root, 'rooted'), '--out', out, '--check'])
    expect(result.reason).toContain('scanned roots differ from the index')
    expect(await readFile(out, 'utf8')).toBe(before)
    expect(await readdir(root)).toEqual(listing)
  })

  test('reports unreadable and missing indexes without throwing', async () => {
    const out = path.join(root, 'missing', 'INDEX.md')
    await expect(runCli([root, '--out', out, '--check'])).resolves.toMatchObject({
      stale: true,
      reason: `index missing: ${out}`,
    })
    await addSkill('unreadable', SKILL('unreadable', 'Unreadable.'))
    await runCli([root, '--out', out])
    await unlink(path.join(root, 'unreadable', 'SKILL.md'))
    const result = await runCli([root, '--out', out, '--check'])
    expect(result.stale).toBe(true)
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports an unreadable scanned skill', async () => {
    await addSkill('locked', SKILL('locked', 'Locked.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const snapshot = await snapshotIndex(out, root)
    const skill = path.join(root, 'locked', 'SKILL.md')
    await chmod(skill, 0o000)
    try {
      const result = await runCli([root, '--out', out, '--check'])
      expect(result.reason).toBe(`unreadable: ${skill} (EACCES)`)
      await expectUntouched(snapshot, out, root)
    } finally { await chmod(skill, 0o644) }
  })

  test('reports an index directory as unreadable', async () => {
    await addSkill('index-dir', SKILL('index-dir', 'Index.'))
    const out = path.join(root, 'INDEX')
    await mkdir(out)
    const result = await runCli([root, '--out', out, '--check'])
    expect(result.reason).toBe(`unreadable: ${out} (EISDIR)`)
  })

  test('reports an unreadable REMOTE directory', async () => {
    await addSkill('remote-dir', SKILL('remote-dir', 'Remote.'))
    const remote = path.join(root, 'REMOTE.md')
    const source = path.join(root, 'remote-source.md')
    await writeFile(source, '', 'utf8')
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out, '--remote', source])
    await unlink(source)
    await mkdir(remote)
    const snapshot = await snapshotIndex(out, root)
    const result = await runCli([root, '--out', out, '--check', '--remote', remote])
    expect(result.reason).toBe(`unreadable: ${remote} (EISDIR)`)
    await expectUntouched(snapshot, out, root)
  })

  test('does not diagnose roots when the older index has no roots header', async () => {
    await addSkill('legacy', SKILL('legacy', 'Legacy.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const content = (await readFile(out, 'utf8')).replace(/^<!-- roots: .*\n/m, '')
    await writeFile(out, content, 'utf8')
    const result = await runCli([path.join(root, 'legacy'), '--out', out, '--check'])
    expect(result.reason ?? '').not.toContain('scanned roots differ')
  })

  test.each([
    ['a non-array roots header', '<!-- roots: {"a":1} -->'],
    ['an unparsable roots header', '<!-- roots: [oops -->'],
  ])('ignores %s instead of crashing', async (_label, header) => {
    // Arrange
    await addSkill('legacy', SKILL('legacy', 'Legacy.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    await utimes(path.join(root, 'legacy', 'SKILL.md'), new Date(1), new Date(1))
    await writeFile(out, (await readFile(out, 'utf8')).replace(/^<!-- roots: .*$/m, header), 'utf8')

    // Act
    const result = await runCli([root, '--out', out, '--check'])

    // Assert
    expect(result.stale).toBe(false)
  })

  test('reads the roots header from an index with CRLF line endings', async () => {
    // Arrange
    await addSkill('crlf', SKILL('crlf', 'Crlf.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    await writeFile(out, (await readFile(out, 'utf8')).replace(/\n/g, '\r\n'), 'utf8')

    // Act
    const result = await runCli([path.join(root, 'crlf'), '--out', out, '--check'])

    // Assert
    expect(result.reason).toContain('scanned roots differ from the index')
  })

  test('compares roots as an order-insensitive set', async () => {
    const first = path.join(root, 'first-root')
    const second = path.join(root, 'second-root')
    await mkdir(path.join(first, 'first-skill'), { recursive: true })
    await writeFile(path.join(first, 'first-skill', 'SKILL.md'), SKILL('first-skill', 'First.'), 'utf8')
    await mkdir(path.join(second, 'second-skill'), { recursive: true })
    await writeFile(path.join(second, 'second-skill', 'SKILL.md'), SKILL('second-skill', 'Second.'), 'utf8')
    const out = path.join(root, 'INDEX.md')
    await runCli([first, second, '--out', out])
    const result = await runCli([second, first, '--out', out, '--check'])
    expect(result.stale).toBe(false)
  })

  test('detects remote catalog changes and reports merged counts', async () => {
    await addSkill('local', SKILL('local', 'Local.'))
    const remote = path.join(root, 'REMOTE.md')
    await writeFile(remote, 'remote-a | Remote A | https://example.com/a\n', 'utf8')
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out, '--remote', remote])
    await utimes(path.join(root, 'local', 'SKILL.md'), new Date(1), new Date(1))
    await writeFile(remote, 'remote-b | Remote B | https://example.com/b\n', 'utf8')
    const result = await runCli([root, '--out', out, '--check', '--remote', remote])
    expect(result.reason).toBe('remote catalog changed: +1 −1')
  })

  test('reports remote additions, removals, and unchanged counts', async () => {
    await addSkill('local', SKILL('local', 'Local.'))
    const remote = path.join(root, 'REMOTE.md')
    const out = path.join(root, 'INDEX.md')
    await writeFile(remote, 'remote | Remote | https://example.com/r\n', 'utf8')
    await runCli([root, '--out', out, '--remote', remote])
    await utimes(path.join(root, 'local', 'SKILL.md'), new Date(1), new Date(1))
    const current = await runCli([root, '--out', out, '--check', '--remote', remote])
    expect(current).toMatchObject({ stale: false, count: 2, remote: 1 })
    await writeFile(remote, 'remote | Remote | https://example.com/r\nnew | New | https://example.com/n\n', 'utf8')
    expect((await runCli([root, '--out', out, '--check', '--remote', remote])).reason).toBe('remote catalog changed: +1 −0')
    await runCli([root, '--out', out, '--remote', remote])
    await writeFile(remote, 'new | New | https://example.com/n\n', 'utf8')
    expect((await runCli([root, '--out', out, '--check', '--remote', remote])).reason).toBe('remote catalog changed: +0 −1')
  })

  test('detects a description-only change in the remote catalog', async () => {
    // Arrange
    await addSkill('local', SKILL('local', 'Local.'))
    const remote = path.join(root, 'REMOTE.md')
    const out = path.join(root, 'INDEX.md')
    await writeFile(remote, 'remote | Remote | https://example.com/r\n', 'utf8')
    await runCli([root, '--out', out, '--remote', remote])
    await utimes(path.join(root, 'local', 'SKILL.md'), new Date(1), new Date(1))
    await writeFile(remote, 'remote | Remote, reworded | https://example.com/r\n', 'utf8')

    // Act
    const result = await runCli([root, '--out', out, '--check', '--remote', remote])

    // Assert
    expect(result.reason).toBe('remote catalog changed: +1 −1')
  })

  test('a build still treats an unreadable remote catalog as empty', async () => {
    // Arrange
    await addSkill('local', SKILL('local', 'Local.'))
    const remote = path.join(root, 'REMOTE.md')
    await mkdir(remote)
    const out = path.join(root, 'INDEX.md')

    // Act
    const result = await runCli([root, '--out', out, '--remote', remote])

    // Assert
    expect(result).toMatchObject({ count: 1, local: 1 })
  })

  test('does not count a local skill shadowing a remote pointer as a remote change', async () => {
    await addSkill('shared', SKILL('shared', 'Shared local.'))
    const remote = path.join(root, 'REMOTE.md')
    const out = path.join(root, 'INDEX.md')
    await writeFile(remote, 'shared | Shared remote | https://example.com/shared\n', 'utf8')
    await runCli([root, '--out', out, '--remote', remote])
    await utimes(path.join(root, 'shared', 'SKILL.md'), new Date(1), new Date(1))
    const result = await runCli([root, '--out', out, '--check', '--remote', remote])
    expect(result).toMatchObject({ stale: false, count: 1, remote: 0 })
  })

  test.skipIf(process.platform === 'win32')('checks through symlinked index locations in both directions', async () => {
    await addSkill('linked-index', SKILL('linked-index', 'Linked index.'))
    const realDir = path.join(root, 'real')
    const linkDir = path.join(root, 'link')
    await mkdir(realDir)
    await symlink(realDir, linkDir)
    const realOut = path.join(realDir, 'INDEX.md')
    const linkOut = path.join(linkDir, 'INDEX.md')
    await runCli([root, '--out', realOut])
    expect((await runCli([root, '--out', linkOut, '--check'])).stale).toBe(false)
    await unlink(realOut)
    await runCli([root, '--out', linkOut])
    expect((await runCli([root, '--out', realOut, '--check'])).stale).toBe(false)
  })

  test('parses and matches a header-bearing index exactly like a headerless index', async () => {
    await addSkill('matchable', SKILL('matchable', 'Useful matching terms.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const header = await readFile(out, 'utf8')
    const plain = header.replace(/^<!-- roots: .*\n/m, '')
    expect(parseCatalog(header)).toEqual(parseCatalog(plain))
    const entries = parseCatalog(header)
    expect(selectSkills(entries, ['matching']).map((entry: { name: string }) => entry.name))
      .toEqual(selectSkills(parseCatalog(plain), ['matching']).map((entry: { name: string }) => entry.name))
  })

  test('reports a new older skill and a deleted skill without writing', async () => {
    await addSkill('original', SKILL('original', 'Original.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const indexStat = await stat(out)
    const old = new Date(indexStat.mtimeMs - 10_000)

    await addSkill('added', SKILL('added', 'Added.'))
    await utimes(path.join(root, 'added', 'SKILL.md'), old, old)
    const added = await runCli([root, '--out', out, '--check'])
    expect(added.reason).toBe(
      `1 skill(s) on disk not in the index (e.g. ${path.join(root, 'added', 'SKILL.md')})`,
    )

    await runCli([root, '--out', out])
    await rm(path.join(root, 'original'), { recursive: true })
    const deleted = await runCli([root, '--out', out, '--check'])
    expect(deleted.reason).toBe(
      `1 indexed skill(s) no longer on disk (e.g. ${path.join(root, 'original', 'SKILL.md')})`,
    )
  })

  test('ignores quarantined skills and URL catalog entries', async () => {
    await addSkill('original', SKILL('original', 'Original.'))
    const out = path.join(root, 'INDEX.md')
    const remote = path.join(root, 'REMOTE.md')
    await writeFile(remote, 'remote | Remote | https://example.com/remote\n', 'utf8')
    await runCli([root, '--out', out, '--remote', remote])
    await addSkill('quarantine/quarantined', SKILL('quarantined', 'Quarantined.'))

    const result = await runCli([root, '--out', out, '--check'])
    expect(result).toMatchObject({ stale: false })
  })

  test('child process reports current and stale with exact exit behavior', async () => {
    await addSkill('process-skill', SKILL('process-skill', 'Process.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])
    const before = await readFile(out, 'utf8')
    const beforeMtime = (await stat(out)).mtimeMs
    const current = await execFileAsync(process.execPath, [SCRIPT, '--check', root, '--out', out])
    expect(current.stdout.trim()).toMatch(/^skills-index: current \(\d+ entries, \d+ remote, built .+\)$/)
    expect((await stat(out)).mtimeMs).toBe(beforeMtime)
    expect(await readFile(out, 'utf8')).toBe(before)

    const future = new Date(Date.now() + 10_000)
    await utimes(path.join(root, 'process-skill', 'SKILL.md'), future, future)
    await expect(execFileAsync(process.execPath, [SCRIPT, '--check', root, '--out', out])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringMatching(/^skills-index: stale — /),
    })
    expect((await stat(out)).mtimeMs).toBe(beforeMtime)
    expect(await readFile(out, 'utf8')).toBe(before)
  })

  test('child process reports --check vet usage errors', async () => {
    await addSkill('vet-skill', SKILL('vet-skill', 'Vet.'))
    const out = path.join(root, 'INDEX.md')
    await runCli([root, '--out', out])

    await expect(
      execFileAsync(process.execPath, [
        SCRIPT,
        '--check',
        root,
        '--out',
        out,
        '--vet',
        path.join(root, 'vet-skill', 'SKILL.md'),
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--check') })
  })
})
