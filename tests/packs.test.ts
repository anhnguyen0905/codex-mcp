import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import rubrics from './fixtures/quality/rubrics.json'
import dev from './fixtures/quality/dev-cases.json'
import manifest from './fixtures/quality/holdout-manifest.json'
// @ts-expect-error — plain .mjs script
import { LANGUAGE_TERMS } from '../scripts/language-terms.mjs'
// @ts-expect-error — plain .mjs script
import { loadPackMetadata } from '../scripts/profile-router.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pack = JSON.parse(readFileSync(path.join(root, 'packs/game-analytics/pack.json'), 'utf8'))
describe('game analytics pack', () => {
  it('has valid references and manifest shape', () => {
    // Arrange
    const rubricIds = Object.values(rubrics.profiles).flat().map((x) => x.id)
    const devIds = dev.cases.filter((x) => x.profile === 'data').map((x) => x.id)
    const termIds = LANGUAGE_TERMS.map((x) => x.en)
    // Act
    const actual = pack
    // Assert
    expect(actual.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pack.rubricIds.every((id) => rubricIds.includes(id))).toBe(true)
    expect(pack.termIds.every((id) => termIds.includes(id))).toBe(true)
    expect(pack.devCaseIds).toEqual(devIds)
    expect(pack.holdoutCaseIds).toEqual(manifest.cases.map((x) => x.id).filter((id) => !['h18','h19','h20','h21'].includes(id)))
    expect(existsSync(path.join(root, 'skills', `${pack.skill}`, 'SKILL.md'))).toBe(true)
  })

  it('rejects malformed pack metadata clearly', () => {
    // Arrange
    const packsDir = mkdtempSync(path.join(os.tmpdir(), 'packs-'))
    mkdirSync(path.join(packsDir, 'broken'))
    writeFileSync(path.join(packsDir, 'broken', 'pack.json'), JSON.stringify({ name: 'wrong' }))
    // Act / Assert
    expect(() => loadPackMetadata(packsDir)).toThrow(/invalid pack metadata: .*broken[\\/]pack\.json/)
  })
})
