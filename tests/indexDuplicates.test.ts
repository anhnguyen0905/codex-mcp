import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { buildIndex } from '../scripts/build-skills-index.mjs'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'skill-dups-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function writeSkill(root: string, name: string, description: string) {
  const dir = path.join(tmp, root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  )
}

describe('buildIndex duplicate names', () => {
  test('warns when the same skill name is indexed from several roots', async () => {
    // dual-review IMP-D: the live index carried 11 duplicate names silently;
    // duplicates distort selection and averages, so the builder must surface them.
    writeSkill('rootA', 'xlsx', 'Excel toolkit copy A.')
    writeSkill('rootB', 'xlsx', 'Excel toolkit copy B.')
    writeSkill('rootA', 'unique-skill', 'Only one of these.')

    const { entries, warnings } = await buildIndex([
      path.join(tmp, 'rootA'),
      path.join(tmp, 'rootB'),
    ])

    expect(entries.filter((e: { name: string }) => e.name === 'xlsx').length).toBe(2)
    expect(warnings.some((w: string) => w.includes('duplicate skill name "xlsx" (2 entries)'))).toBe(true)
    expect(warnings.some((w: string) => w.includes('unique-skill'))).toBe(false)
  })
})
