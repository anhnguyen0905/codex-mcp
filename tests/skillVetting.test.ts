import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  buildIndex,
  renderIndex,
  parseCatalog,
  sha256Of,
  computeVetRecord,
  verifyVetRecord,
  resolveInsideRoot,
  runCli as runIndexCli,
} from '../scripts/build-skills-index.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { quarantineRemoteDir, runCli as runSyncCli } from '../scripts/sync-awesome-skills.mjs'

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skill-vetting-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function addSkill(rel: string, content: string): Promise<string> {
  const dir = path.join(root, rel)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  await writeFile(file, content, 'utf8')
  return file
}

describe('quarantine exclusion', () => {
  test('never indexes skills under a quarantine directory and warns about the skip', async () => {
    // Arrange
    await addSkill('local-skill', SKILL('local-skill', 'Trusted local skill.'))
    await addSkill(
      'quarantine/remote/evil__repo/bad-skill',
      SKILL('bad-skill', 'Unvetted third-party skill.'),
    )

    // Act
    const { entries, warnings } = await buildIndex([root])

    // Assert
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['local-skill'])
    expect(warnings.some((w: string) => w.includes('quarantine'))).toBe(true)
  })
})

describe('symlink hardening', () => {
  test('rejects a symlinked SKILL.md with a warning', async () => {
    // Arrange — real content lives outside the scan root
    const outside = await mkdtemp(path.join(tmpdir(), 'skill-outside-'))
    try {
      const target = path.join(outside, 'SKILL.md')
      await writeFile(target, SKILL('sneaky', 'Lives outside the root.'), 'utf8')
      const dir = path.join(root, 'sneaky-skill')
      await mkdir(dir, { recursive: true })
      await symlink(target, path.join(dir, 'SKILL.md'))

      // Act
      const { entries, warnings } = await buildIndex([root])

      // Assert
      expect(entries).toEqual([])
      expect(warnings.some((w: string) => w.includes('symlink'))).toBe(true)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('resolveInsideRoot rejects a file whose realpath escapes the root', async () => {
    // Arrange
    const outside = await mkdtemp(path.join(tmpdir(), 'skill-escape-'))
    try {
      const target = path.join(outside, 'SKILL.md')
      await writeFile(target, SKILL('escapee', 'Outside content.'), 'utf8')
      const dir = path.join(root, 'escape-skill')
      await mkdir(dir, { recursive: true })
      const link = path.join(dir, 'SKILL.md')
      await symlink(target, link)
      const rootReal = await realpath(root)

      // Act
      const escaped = await resolveInsideRoot(link, rootReal)
      const legit = await resolveInsideRoot(
        await addSkill('fine-skill', SKILL('fine', 'Inside.')),
        rootReal,
      )

      // Assert
      expect(escaped.real).toBeNull()
      expect(escaped.warning).toMatch(/outside|escape/i)
      expect(legit.warning).toBeNull()
      expect(legit.real).toContain(rootReal)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('vet records', () => {
  test('computeVetRecord pins the SKILL.md sha256 and timestamps the vetting', async () => {
    // Arrange
    const content = SKILL('pinned', 'Content to pin.')
    const file = await addSkill('remote/owner__repo/pinned', content)

    // Act
    const record = await computeVetRecord(file)

    // Assert
    expect(record.sha256).toBe(sha256Of(content))
    expect(new Date(record.vettedAt).toISOString()).toBe(record.vettedAt)
    expect(record).toHaveProperty('gitCommit')
  })

  test('verifyVetRecord matches identical content and rejects changed content', async () => {
    // Arrange
    const content = SKILL('verify-me', 'Original content.')
    const file = await addSkill('remote/owner__repo/verify-me', content)
    const record = await computeVetRecord(file)

    // Act + Assert
    expect(verifyVetRecord(record, content)).toBe(true)
    expect(verifyVetRecord(record, content + '\nInjected line.\n')).toBe(false)
    expect(verifyVetRecord(undefined, content)).toBe(false)
  })
})

describe('index vetting of remote-origin skills', () => {
  test('marks a remote skill vetted:true when the manifest hash matches', async () => {
    // Arrange
    const content = SKILL('remote-skill', 'A vetted remote skill.')
    const file = await addSkill('remote/owner__repo/remote-skill', content)
    const record = await computeVetRecord(file)
    await writeFile(
      path.join(root, 'vetted.json'),
      JSON.stringify({ [file]: record }, null, 2),
      'utf8',
    )

    // Act
    const { entries, warnings } = await buildIndex([root])

    // Assert
    expect(entries).toHaveLength(1)
    expect(entries[0].vetted).toBe(true)
    expect(warnings).toEqual([])
    expect(renderIndex(entries)).toContain(`remote-skill | A vetted remote skill. | ${file} | vetted:true`)
  })

  test('marks a remote skill vetted:false with a warning when content changed after vetting', async () => {
    // Arrange — vet, then tamper (simulates git pull changing content at the same path)
    const file = await addSkill(
      'remote/owner__repo/tampered',
      SKILL('tampered', 'Original description.'),
    )
    const record = await computeVetRecord(file)
    await writeFile(
      path.join(root, 'vetted.json'),
      JSON.stringify({ [file]: record }, null, 2),
      'utf8',
    )
    await writeFile(file, SKILL('tampered', 'Changed after vetting.'), 'utf8')

    // Act
    const { entries, warnings } = await buildIndex([root])

    // Assert
    expect(entries[0].vetted).toBe(false)
    expect(warnings.some((w: string) => w.includes('unvetted') && w.includes(file))).toBe(true)
    expect(renderIndex(entries)).toContain('| vetted:false')
  })

  test('marks a remote skill vetted:false when no manifest exists', async () => {
    await addSkill('remote/owner__repo/never-vetted', SKILL('never-vetted', 'No record.'))

    const { entries, warnings } = await buildIndex([root])

    expect(entries[0].vetted).toBe(false)
    expect(warnings.some((w: string) => w.includes('unvetted'))).toBe(true)
  })

  test('local skills are indexed exactly as before when no manifest exists', async () => {
    // Arrange
    await addSkill('plain-local', SKILL('plain-local', 'Local skill.'))

    // Act
    const { entries, warnings } = await buildIndex([root])

    // Assert — no vetted field, three-field index line, no warnings
    expect(entries).toEqual([
      {
        name: 'plain-local',
        description: 'Local skill.',
        file: path.join(root, 'plain-local', 'SKILL.md'),
      },
    ])
    expect(warnings).toEqual([])
    const line = renderIndex(entries).trimEnd().split('\n').pop() as string
    expect(line.split(' | ')).toHaveLength(3)
  })
})

describe('catalog round-trip with vetted field', () => {
  test('parseCatalog reads back the optional vetted field from renderIndex output', () => {
    // Arrange
    const entries = [
      { name: 'a', description: 'Local.', file: '/x/a/SKILL.md' },
      { name: 'b', description: 'Remote ok.', file: '/x/remote/r/b/SKILL.md', vetted: true },
      { name: 'c', description: 'Remote bad.', file: '/x/remote/r/c/SKILL.md', vetted: false },
    ]

    // Act
    const parsed = parseCatalog(renderIndex(entries))

    // Assert
    expect(parsed).toEqual([
      { name: 'a', description: 'Local.', file: '/x/a/SKILL.md' },
      { name: 'b', description: 'Remote ok.', file: '/x/remote/r/b/SKILL.md', vetted: true },
      { name: 'c', description: 'Remote bad.', file: '/x/remote/r/c/SKILL.md', vetted: false },
    ])
  })
})

describe('--vet CLI mode', () => {
  test('writes a pinned record into the manifest and the next index build trusts it', async () => {
    // Arrange
    const file = await addSkill('remote/owner__repo/cli-vetted', SKILL('cli-vetted', 'Via CLI.'))
    const manifest = path.join(root, 'vetted.json')

    // Act
    const summary = await runIndexCli(['--vet', file, '--manifest', manifest])
    const { entries } = await buildIndex([root])

    // Assert
    expect(summary.vetted).toBe(path.resolve(file))
    const written = JSON.parse(await readFile(manifest, 'utf8'))
    expect(written[path.resolve(file)].sha256).toBe(sha256Of(SKILL('cli-vetted', 'Via CLI.')))
    expect(entries[0].vetted).toBe(true)
  })

  test('derives the manifest location from the remote/ segment when --manifest is omitted', async () => {
    // Arrange
    const file = await addSkill('remote/owner__repo/derived', SKILL('derived', 'Derived manifest.'))

    // Act
    const summary = await runIndexCli(['--vet', file])

    // Assert — libDir is the parent of the remote/ segment
    expect(summary.manifest).toBe(path.join(path.resolve(root), 'vetted.json'))
    const written = JSON.parse(await readFile(summary.manifest, 'utf8'))
    expect(written[path.resolve(file)]).toBeDefined()
  })

  test('fails clearly for a non-remote path without --manifest', async () => {
    const file = await addSkill('plain-local', SKILL('plain-local', 'Local.'))

    await expect(runIndexCli(['--vet', file])).rejects.toThrow(/--manifest|remote/i)
  })
})

describe('sync clone quarantine destination', () => {
  test('quarantineRemoteDir places clones under <lib>/quarantine/remote', () => {
    expect(quarantineRemoteDir('/lib')).toBe(path.join('/lib', 'quarantine', 'remote'))
  })

  test('runCli --clone reports the quarantine destination (no GitHub targets needed)', async () => {
    // Arrange — bold non-GitHub entry parses as a pointer, so no network clone happens
    const source = path.join(root, 'awesome.md')
    await writeFile(
      source,
      '# List\n\n- **[shadcn](https://ui.shadcn.com/docs/skills)** - Docs pointer only\n',
      'utf8',
    )
    const lib = path.join(root, 'lib')

    // Act
    const summary = await runSyncCli([
      '--from', source,
      '--out', path.join(root, 'REMOTE.md'),
      '--clone',
      '--lib', lib,
    ])

    // Assert
    expect(summary.clone.dest).toBe(path.join(path.resolve(lib), 'quarantine', 'remote'))
    expect(summary.clone.repos).toBe(0)
  })
})
