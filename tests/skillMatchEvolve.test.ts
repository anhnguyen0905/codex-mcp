import { createHash } from 'node:crypto'
import { cpSync, readFileSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { compareCandidates, evolve, formatReport, mulberry32, mutate, recommend, resolveRealOutput, validateTuning } from '../scripts/skill-match-evolve.mjs'
// @ts-expect-error — plain .mjs script
import { TUNING_BOUNDS, DEFAULT_TUNING } from '../scripts/skill-match.mjs'

const root = process.cwd()
const fixture = (name: string) => join(root, 'tests', 'fixtures', 'evolve', name)
const options = (seed: number) => ({ generations: 3, population: 32, seed, index: fixture('index.md'), dev: [fixture('dev.json')], holdout: fixture('holdout.json') })

describe('skill-match evolution', () => {
  it('produces a reproducible mulberry32 sequence', () => {
    // Arrange
    const first = mulberry32(42)
    const second = mulberry32(42)

    // Act
    const actual = [first(), first(), first()]
    const expected = [second(), second(), second()]

    // Assert
    expect(actual).toEqual(expected)
  })

  it('mutates a copy within bounds with one to three rounded keys', () => {
    // Arrange
    const original = { ...DEFAULT_TUNING }

    // Act
    const changed = mutate(original, mulberry32(7), TUNING_BOUNDS)
    const keys = Object.keys(TUNING_BOUNDS).filter((key) => changed[key] !== original[key])

    // Assert
    expect(keys.length).toBeGreaterThanOrEqual(1)
    expect(keys.length).toBeLessThanOrEqual(3)
    expect(changed).not.toBe(original)
    for (const [key, [min, max]] of Object.entries(TUNING_BOUNDS)) expect(changed[key]).toBeGreaterThanOrEqual(min)
    for (const key of keys) expect(changed[key] * 100 % 1).toBe(0)
  })

  it('keeps same-seed reports identical and changes candidates for another seed', async () => {
    // Arrange
    const first = await evolve(options(11))
    const second = await evolve(options(11))
    const other = await evolve(options(12))

    // Act
    const firstText = formatReport(first)
    const secondText = formatReport(second)

    // Assert
    expect(firstText).toBe(secondText)
    expect(first.candidates.length).toBeGreaterThanOrEqual(3)
    expect(first.candidates.map((candidate) => candidate.tuning)).not.toEqual(other.candidates.map((candidate) => candidate.tuning))
  })

  it('sorts tied candidates by canonical tuning', () => {
    // Arrange
    const candidates = [
      { fitness: 1, precisionAt1: 1, canonical: '{"nameWord":2}' },
      { fitness: 1, precisionAt1: 1, canonical: '{"nameWord":1}' },
    ]

    // Act
    const sorted = [...candidates].sort(compareCandidates)

    // Assert
    expect(sorted[0].canonical).toBe('{"nameWord":1}')
  })

  it('counts duplicate signatures before ranking', async () => {
    // Arrange

    // Act
    const report = await evolve(options(3))

    // Assert
    expect(report.rejectedDuplicates).toBeGreaterThan(0)
  })

  it('recommends only candidates that beat dev and do not lose held-out', async () => {
    // Arrange
    const baseline = { fitness: 2, heldOut: 3 }
    const candidates = [
      { fitness: 3, heldOut: 3, tuning: { nameWord: 6 } },
      { fitness: 3, heldOut: 2, tuning: { nameWord: 7 } },
      { fitness: 2, heldOut: 4, tuning: { nameWord: 8 } },
    ]

    // Act
    const recommendations = recommend(baseline, candidates)

    // Assert
    expect(recommendations).toEqual([candidates[0]])
  })

  it('does not rank a candidate with the baseline signature', async () => {
    // Arrange
    const report = await evolve(options(4))

    // Act
    const signatures = report.candidates.map((candidate) => candidate.signature)

    // Assert
    expect(signatures).not.toContain(report.baseline.signature)
  })

  it('rejects an out-of-bounds tuning with a RangeError', () => {
    // Arrange
    const invalid = { ...DEFAULT_TUNING, nameWord: 21 }

    // Act
    const attempt = () => validateTuning(invalid, TUNING_BOUNDS)

    // Assert
    expect(attempt).toThrow(RangeError)
  })

  it('resolves missing output segments from the nearest existing ancestor', async () => {
    // Arrange
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'evolve-resolve-')))
    const missingOutput = join(root, 'a', 'b', 'report.md')
    const existingFile = join(process.cwd(), 'scripts', 'skill-match.mjs')

    // Act
    const missingResult = await resolveRealOutput(missingOutput)
    const existingResult = await resolveRealOutput(existingFile)

    // Assert
    expect(missingResult).toBe(missingOutput)
    expect(existingResult).toBe(realpathSync(existingFile))
  })

  it.skipIf(process.platform === 'win32')('resolves missing output segments through a symlinked ancestor', async () => {
    // Arrange
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'evolve-link-root-')))
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'evolve-link-target-')))
    const link = join(root, 'link')
    symlinkSync(target, link)

    // Act
    const result = await resolveRealOutput(join(link, 'x', 'y', 'report.md'))

    // Assert
    expect(result).toBe(join(target, 'x', 'y', 'report.md'))
  })

  it('does not change skill-match.mjs after a CLI run', () => {
    // Arrange
    const before = createHash('sha256').update(readFileSync(join(root, 'scripts', 'skill-match.mjs'))).digest('hex')
    const out = join(mkdtempSync(join(tmpdir(), 'evolve-')), 'report.md')

    // Act
    execFileSync(process.execPath, ['scripts/skill-match-evolve.mjs', '--generations', '1', '--population', '2', '--seed', '1', '--index', fixture('index.md'), '--dev', fixture('dev.json'), '--holdout', fixture('holdout.json'), '--out', out], { cwd: root })
    const after = createHash('sha256').update(readFileSync(join(root, 'scripts', 'skill-match.mjs'))).digest('hex')

    // Assert
    expect(after).toBe(before)
  })

  it('rejects protected output and bad numeric arguments in a copied scripts directory', () => {
    // Arrange
    const copyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'evolve-scripts-')))
    const scriptsCopy = join(copyRoot, 'scripts')
    cpSync(join(root, 'scripts'), scriptsCopy, { recursive: true })
    const skillMatch = join(scriptsCopy, 'skill-match.mjs')
    const before = createHash('sha256').update(readFileSync(skillMatch)).digest('hex')
    const fixtureArgs = ['--index', fixture('index.md'), '--dev', fixture('dev.json'), '--holdout', fixture('holdout.json')]
    const command = (out: string, extra: string[] = []) => spawnSync(process.execPath, [join(scriptsCopy, 'skill-match-evolve.mjs'), '--generations', '1', '--population', '1', '--seed', '1', ...fixtureArgs, '--out', out, ...extra], { cwd: root, encoding: 'utf8' })
    const report = join(copyRoot, 'report.md')

    // Act
    const protectedOutput = command(skillMatch)
    const badNumber = spawnSync(process.execPath, [join(scriptsCopy, 'skill-match-evolve.mjs'), '--generations', '0', '--population', '1', '--seed', '1', ...fixtureArgs, '--out', report], { cwd: root, encoding: 'utf8' })
    const after = createHash('sha256').update(readFileSync(skillMatch)).digest('hex')

    // Assert
    expect(protectedOutput.status).toBe(2)
    expect(badNumber.status).toBe(2)
    expect(after).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('rejects case-variant and symlink protected outputs in a copied scripts directory', () => {
    // Arrange
    const copyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'evolve-scripts-')))
    const scriptsCopy = join(copyRoot, 'scripts')
    cpSync(join(root, 'scripts'), scriptsCopy, { recursive: true })
    const skillMatch = join(scriptsCopy, 'skill-match.mjs')
    const before = createHash('sha256').update(readFileSync(skillMatch)).digest('hex')
    const command = (out: string) => spawnSync(process.execPath, [join(scriptsCopy, 'skill-match-evolve.mjs'), '--generations', '1', '--population', '1', '--seed', '1', '--index', fixture('index.md'), '--dev', fixture('dev.json'), '--holdout', fixture('holdout.json'), '--out', out], { cwd: root, encoding: 'utf8' })
    const link = join(copyRoot, 'report.md')
    symlinkSync(skillMatch, link)

    // Act
    const caseVariant = command(join(scriptsCopy, 'SKILL-MATCH.mjs'))
    const symlinkOutput = command(link)
    const normalized = command(`${scriptsCopy}${sep}..${sep}scripts${sep}.${sep}skill-match.mjs`)
    const acceptedPath = join(copyRoot, 'my-skill-match.mjs')
    const accepted = command(acceptedPath)
    const nestedAcceptedPath = join(scriptsCopy, 'newdir', 'skill-match.mjs')
    const nestedAccepted = command(nestedAcceptedPath)
    const after = createHash('sha256').update(readFileSync(skillMatch)).digest('hex')

    // Assert
    expect(caseVariant.status).toBe(2)
    expect(symlinkOutput.status).toBe(2)
    expect(normalized.status).toBe(2)
    expect(accepted.status).toBe(0)
    expect(readFileSync(acceptedPath, 'utf8')).toContain('# Skill-match evolution')
    expect(nestedAccepted.status).toBe(0)
    expect(readFileSync(nestedAcceptedPath, 'utf8')).toContain('# Skill-match evolution')
    expect(after).toBe(before)
  })
})
