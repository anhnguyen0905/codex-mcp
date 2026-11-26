import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { buildAblationPrompts, compareGrades, main } from '../scripts/skill-ablation.mjs'

const validCase = (id: string, text: string) => ({ id, profile: 'design', language: 'en', domain: 'game', request: 'Draft a concept.', split: 'dev', source: 'synthetic', deliverableText: text })
const casesFile = 'tests/fixtures/ablation/cases.json'
const withoutFile = 'tests/fixtures/ablation/without-cases.json'
const rulesFile = 'tests/fixtures/ablation/rules.md'
const runCli = (args: string[]) => spawnSync(process.execPath, ['scripts/skill-ablation.mjs', ...args], { encoding: 'utf8' })

describe('skill ablation', () => {
  it('builds paired prompts with a deterministic manifest', () => {
    // Arrange
    const cases = [validCase('alpha', '# Goal\nA goal.')]

    // Act
    const prompts = buildAblationPrompts(cases, 'Rule one.')

    // Assert
    expect(prompts).toEqual([{ id: 'alpha', with: 'Draft a concept.\n\nRules:\nRule one.', without: 'Draft a concept.' }])
  })

  it('writes prompt files and manifest', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-'))
    const casesFile = join(dir, 'cases.json')
    const blockFile = join(dir, 'rules.md')
    const out = join(dir, 'out')
    writeFileSync(casesFile, JSON.stringify([validCase('alpha', '# Goal\nA goal.')]))
    writeFileSync(blockFile, 'Rule one.')

    // Act
    main(['prompts', '--cases', casesFile, '--block', blockFile, '--out', out])

    // Assert
    expect(readFileSync(join(out, 'alpha.with.prompt.txt'), 'utf8')).toContain('Rules:')
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toEqual([{ id: 'alpha', with: 'alpha.with.prompt.txt', without: 'alpha.without.prompt.txt' }])
  })

  it('compares mechanical rates and ignores n/a rubric items', () => {
    // Arrange
    const withCases = [validCase('alpha', '# Goal\nA goal.\n# Core Loop\nPlay.')]
    const withoutCases = [validCase('alpha', 'No headings.')]

    // Act
    const result = compareGrades(withCases, withoutCases)

    // Assert
    expect(result.cases[0]).toMatchObject({ id: 'alpha', withRate: 1 / 3, withoutRate: 0, delta: 1 / 3 })
    expect(result.aggregate).toEqual({ withRate: 1 / 3, withoutRate: 0, delta: 1 / 3 })
  })

  it('pairs equal id sets in with-file order', () => {
    // Arrange
    const withCases = [validCase('alpha', '# Goal\nA goal.'), validCase('beta', '# Goal\nA goal.')]
    const withoutCases = [validCase('beta', '# Goal\nA goal.'), validCase('alpha', '# Goal\nA goal.')]

    // Act
    const result = compareGrades(withCases, withoutCases)

    // Assert
    expect(result.cases.map((row) => row.id)).toEqual(['alpha', 'beta'])
  })

  it('rejects duplicate ids', () => {
    // Arrange
    const withCases = [validCase('alpha', '# Goal\nA goal.'), validCase('alpha', '# Goal\nA goal.')]
    const withoutCases = [validCase('alpha', '# Goal\nA goal.')]

    // Act
    const action = () => compareGrades(withCases, withoutCases)

    // Assert
    expect(action).toThrow('duplicate id')
  })

  it('rejects mismatched case ids', () => {
    // Arrange
    const withCases = [validCase('alpha', '# Goal\nA goal.')]
    const withoutCases = [validCase('beta', '# Goal\nA goal.')]

    // Act
    const action = () => compareGrades(withCases, withoutCases)

    // Assert
    expect(action).toThrow('same id set')
  })

  it('rejects unsafe prompt ids before writing', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-'))
    const casesFile = join(dir, 'cases.json')
    const blockFile = join(dir, 'rules.md')
    writeFileSync(casesFile, JSON.stringify([validCase('../escape', '# Goal\nA goal.')]))
    writeFileSync(blockFile, 'Rule.')

    // Act
    const action = () => main(['prompts', '--cases', casesFile, '--block', blockFile, '--out', join(dir, 'out')])

    // Assert
    expect(action).toThrow('safe file-name tokens')
  })

  it('rejects malformed case files', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-'))
    const casesFile = join(dir, 'cases.json')
    const blockFile = join(dir, 'rules.md')
    writeFileSync(casesFile, '{"cases": "not a list"}')
    writeFileSync(blockFile, 'Rule.')

    // Act
    const action = () => main(['prompts', '--cases', casesFile, '--block', blockFile, '--out', join(dir, 'out')])

    // Assert
    expect(action).toThrow('case file')
  })

  it('contains no network or child-process imports', () => {
    // Arrange
    const source = readFileSync('scripts/skill-ablation.mjs', 'utf8')

    // Act
    const forbidden = /node:(?:http|https|net|child_process)|fetch\(/u.test(source)

    // Assert
    expect(forbidden).toBe(false)
  })

  it('returns exit 0 and writes prompts through the CLI', () => {
    // Arrange
    const out = mkdtempSync(join(tmpdir(), 'ablation-prompts-'))

    // Act
    const result = runCli(['prompts', '--cases', casesFile, '--block', rulesFile, '--out', out])

    // Assert
    expect(result.status).toBe(0)
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toContain('alpha.with.prompt.txt')
  })

  it('returns exit 2 and one stderr line for mismatched ids', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-cli-'))
    const otherFile = join(dir, 'other.json')
    writeFileSync(otherFile, JSON.stringify([validCase('gamma', '# Goal\nA goal.')]))

    // Act
    const result = runCli(['compare', '--with', casesFile, '--without', otherFile])

    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toEqual(['skill-ablation: with and without cases must have the same id set'])
  })

  it('returns exit 2 for an invalid case file', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-cli-'))
    const invalidFile = join(dir, 'invalid.json')
    writeFileSync(invalidFile, '{"cases": "invalid"}')

    // Act
    const result = runCli(['compare', '--with', invalidFile, '--without', withoutFile])

    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr.trim()).toMatch(/^skill-ablation: /u)
  })

  it('prints deterministic JSON compare output with aggregate rates', () => {
    // Arrange
    const expected = compareGrades(JSON.parse(readFileSync(casesFile, 'utf8')), JSON.parse(readFileSync(withoutFile, 'utf8')))

    // Act
    const result = runCli(['compare', '--with', casesFile, '--without', withoutFile, '--json'])

    // Assert
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expected)
  })

  it('prints one text row per case and an aggregate line', () => {
    // Arrange
    const caseCount = JSON.parse(readFileSync(casesFile, 'utf8')).length

    // Act
    const result = runCli(['compare', '--with', casesFile, '--without', withoutFile])

    // Assert
    expect(result.stdout.trim().split('\n')).toHaveLength(caseCount + 1)
    expect(result.stdout).toContain('aggregate ')
  })

  it('reports null rates and excludes an empty comparison from aggregate means', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'ablation-null-'))
    const emptyFile = join(dir, 'empty.json')
    writeFileSync(emptyFile, '[]')

    // Act
    const result = runCli(['compare', '--with', emptyFile, '--without', emptyFile])
    const parsed = JSON.parse(runCli(['compare', '--with', emptyFile, '--without', emptyFile, '--json']).stdout)

    // Assert
    expect(parsed).toEqual({ cases: [], aggregate: { withRate: null, withoutRate: null, delta: null } })
    expect(result.stdout).toContain('n/a cases are excluded from aggregate means')
  })

  it('reports a clear missing-flag error', () => {
    // Arrange
    const result = runCli(['prompts', '--block', rulesFile, '--out', mkdtempSync(join(tmpdir(), 'ablation-missing-'))])

    // Act
    const message = result.stderr.trim()

    // Assert
    expect(result.status).toBe(2)
    expect(message).toBe('skill-ablation: prompts requires --cases, --block, and --out')
  })
})
