import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  parseAwesomeList,
  renderCatalog,
  parseRepoTarget,
  collectCloneTargets,
  cloneRepos,
  runCli as runSyncCli,
} from '../scripts/sync-awesome-skills.mjs'
import { execFileSync } from 'node:child_process'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseCatalog, mergeRemoteEntries, runCli as runIndexCli } from '../scripts/build-skills-index.mjs'

const SAMPLE_AWESOME = `# Awesome Claude Skills

## Resources

- [What are Skills?](https://support.claude.com/articles/what-are-skills) - Plain resource link, not a skill

## Official Skills

- **[pdf](https://github.com/anthropics/skills/tree/main/skills/pdf)** - Comprehensive PDF manipulation toolkit
- **[docx](https://github.com/anthropics/skills/tree/main/skills/docx)** - Create and edit Word documents
  - [Sub-bullet note](https://example.com/note) - should be ignored

### Individual Skills

| Skill | Description |
| --- | --- |
| **[playwright-skill](https://github.com/lackeyjb/playwright-skill)** | General-purpose browser automation using Playwright |
| **[claude-d3js-skill](https://github.com/chrisvoncsefalvay/claude-d3js-skill)** | Visualizations in d3.js |
`

describe('parseAwesomeList', () => {
  test('extracts bold-linked bullet and table entries with descriptions', () => {
    // Act
    const entries = parseAwesomeList(SAMPLE_AWESOME)

    // Assert
    expect(entries.map((e: { name: string }) => e.name)).toEqual([
      'pdf',
      'docx',
      'playwright-skill',
      'claude-d3js-skill',
    ])
    expect(entries[0]).toEqual({
      name: 'pdf',
      description: 'Comprehensive PDF manipulation toolkit',
      url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    })
    expect(entries[2].description).toBe('General-purpose browser automation using Playwright')
  })

  test('ignores plain (non-bold) resource links', () => {
    const entries = parseAwesomeList(SAMPLE_AWESOME)

    const urls = entries.map((e: { url: string }) => e.url)
    expect(urls).not.toContain('https://support.claude.com/articles/what-are-skills')
    expect(urls).not.toContain('https://example.com/note')
  })

  test('deduplicates entries by url', () => {
    const doubled = SAMPLE_AWESOME + '\n- **[pdf](https://github.com/anthropics/skills/tree/main/skills/pdf)** - Duplicate\n'

    const entries = parseAwesomeList(doubled)

    expect(entries.filter((e: { name: string }) => e.name === 'pdf')).toHaveLength(1)
  })
})

describe('parseRepoTarget', () => {
  test('resolves a github tree URL to the repo root clone target', () => {
    const target = parseRepoTarget('https://github.com/anthropics/skills/tree/main/skills/pdf')

    expect(target).toEqual({
      cloneUrl: 'https://github.com/anthropics/skills.git',
      dir: 'anthropics__skills',
    })
  })

  test('resolves a plain github repo URL', () => {
    const target = parseRepoTarget('https://github.com/lackeyjb/playwright-skill')

    expect(target).toEqual({
      cloneUrl: 'https://github.com/lackeyjb/playwright-skill.git',
      dir: 'lackeyjb__playwright-skill',
    })
  })

  test('returns null for non-github URLs', () => {
    expect(parseRepoTarget('https://ui.shadcn.com/docs/skills')).toBeNull()
  })
})

describe('collectCloneTargets', () => {
  test('deduplicates entries pointing into the same repo and separates pointers', () => {
    // Arrange
    const entries = parseAwesomeList(SAMPLE_AWESOME).concat([
      { name: 'shadcn', description: 'Docs only.', url: 'https://ui.shadcn.com/docs/skills' },
    ])

    // Act
    const { targets, pointers } = collectCloneTargets(entries)

    // Assert — pdf + docx share anthropics/skills; two individual repos; shadcn is a pointer
    expect(targets.map((t: { dir: string }) => t.dir)).toEqual([
      'anthropics__skills',
      'lackeyjb__playwright-skill',
      'chrisvoncsefalvay__claude-d3js-skill',
    ])
    expect(pointers.map((p: { name: string }) => p.name)).toEqual(['shadcn'])
  })
})

describe('cloneRepos', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'clone-repos-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('clones a new repo and updates it on the second run', async () => {
    // Arrange — a local origin repo with one skill
    const origin = path.join(root, 'origin')
    await mkdir(path.join(origin, 'my-skill'), { recursive: true })
    await writeFile(
      path.join(origin, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: From origin.\n---\n',
      'utf8',
    )
    const git = (...args: string[]) => execFileSync('git', ['-C', origin, ...args])
    execFileSync('git', ['init', '-q', origin])
    git('config', 'user.email', 't@t.local')
    git('config', 'user.name', 't')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const dest = path.join(root, 'lib', 'remote')
    const targets = [{ cloneUrl: origin, dir: 'origin__repo' }]

    // Act
    const first = await cloneRepos(targets, dest)
    const second = await cloneRepos(targets, dest)

    // Assert
    expect(first).toEqual({ cloned: 1, updated: 0, failed: [] })
    expect(second).toEqual({ cloned: 0, updated: 1, failed: [] })
    expect(
      await readFile(path.join(dest, 'origin__repo', 'my-skill', 'SKILL.md'), 'utf8'),
    ).toContain('From origin.')
  }, 30000)

  test('collects failures without aborting the batch', async () => {
    const dest = path.join(root, 'lib', 'remote')
    const targets = [{ cloneUrl: path.join(root, 'does-not-exist'), dir: 'broken__repo' }]

    const result = await cloneRepos(targets, dest)

    expect(result.cloned).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toContain('broken__repo')
  })
})

describe('catalog round-trip and merge', () => {
  test('renderCatalog output is parseable by parseCatalog', () => {
    // Arrange
    const entries = parseAwesomeList(SAMPLE_AWESOME)

    // Act
    const parsed = parseCatalog(renderCatalog(entries))

    // Assert
    expect(parsed).toHaveLength(4)
    expect(parsed[0]).toEqual({
      name: 'pdf',
      description: 'Comprehensive PDF manipulation toolkit',
      file: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    })
  })

  test('mergeRemoteEntries appends remote entries but local names shadow remote ones', () => {
    // Arrange
    const local = [{ name: 'pdf', description: 'My vetted local pdf skill.', file: '/local/pdf/SKILL.md' }]
    const catalog = renderCatalog(parseAwesomeList(SAMPLE_AWESOME))

    // Act
    const merged = mergeRemoteEntries(local, catalog)

    // Assert
    const pdfEntries = merged.filter((e: { name: string }) => e.name.toLowerCase() === 'pdf')
    expect(pdfEntries).toHaveLength(1)
    expect(pdfEntries[0].file).toBe('/local/pdf/SKILL.md')
    expect(merged.map((e: { name: string }) => e.name)).toContain('playwright-skill')
  })
})

describe('cli integration', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'awesome-sync-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('sync writes REMOTE.md from a local source file', async () => {
    // Arrange
    const source = path.join(root, 'awesome.md')
    await writeFile(source, SAMPLE_AWESOME, 'utf8')
    const out = path.join(root, 'lib', 'REMOTE.md')

    // Act
    const summary = await runSyncCli(['--from', source, '--out', out])

    // Assert
    expect(summary.count).toBe(4)
    expect(await readFile(out, 'utf8')).toContain(
      'playwright-skill | General-purpose browser automation using Playwright | https://github.com/lackeyjb/playwright-skill',
    )
  })

  test('build-skills-index merges REMOTE.md living next to the output file', async () => {
    // Arrange
    const skillsRoot = path.join(root, 'skills')
    await mkdir(path.join(skillsRoot, 'local-skill'), { recursive: true })
    await writeFile(
      path.join(skillsRoot, 'local-skill', 'SKILL.md'),
      '---\nname: local-skill\ndescription: Local one.\n---\n',
      'utf8',
    )
    const outDir = path.join(root, 'index')
    await mkdir(outDir, { recursive: true })
    const source = path.join(root, 'awesome.md')
    await writeFile(source, SAMPLE_AWESOME, 'utf8')
    await runSyncCli(['--from', source, '--out', path.join(outDir, 'REMOTE.md')])

    // Act
    const summary = await runIndexCli([skillsRoot, '--out', path.join(outDir, 'INDEX.md')])

    // Assert
    const index = await readFile(path.join(outDir, 'INDEX.md'), 'utf8')
    expect(index).toContain('local-skill | Local one.')
    expect(index).toContain('pdf | Comprehensive PDF manipulation toolkit | https://github.com/')
    expect(summary.count).toBe(5)
  })
})
