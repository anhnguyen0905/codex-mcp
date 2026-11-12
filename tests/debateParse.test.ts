import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  EXIT_FAILURE,
  EXIT_MALFORMED,
  EXIT_OK,
  extractLastJsonBlock,
  main,
  parseCliArgs,
  parseDebateOutput,
} from '../scripts/debate-parse.mjs'

const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const mapValue = () => ({
  kind: 'map', stocks: [{ id: 'S1', name: 'users' }],
  loops: [{ id: 'L1', type: 'R', chain: 'growth' }],
  delays: [{ id: 'D1', where: 'feedback' }], archetype: null,
  leverage: [{ id: 'P1', level: 12, point: 'rules' }],
})
const roundValue = () => ({
  round: 2,
  steelman: 'strongest version', counterThesis: null,
  challenges: [{ id: 'C1', type: 'LOGIC', severity: 'MAJOR', status: 'NEW',
    target: 'claim', scheme: 'cause-effect', cq: 'CQ1', claim: 'claim', evidence: 'REASON.md:2' }],
  contributions: [{ id: 'N1', claim: 'contribution' }],
  violations: [{ id: 'V1', rule: 'PD1', claim: 'claim' }], dissent: null,
})
const feasibilityValue = () => ({
  kind: 'feasibility', verdict: 'FEASIBLE', effort: 'M', reversible: 'yes',
  dependencies: ['owner'], risks: [{ id: 'K1', risk: 'risk' }],
  conditions: ['test'], firstStep: 'prototype',
})
const parse = (kind: string, value: unknown, round?: number) => parseDebateOutput(
  block(value), { kind, ...(round === undefined ? {} : { round }) },
)

describe('extractLastJsonBlock', () => {
  test('returns the last block and count', () => {
    // Arrange
    const input = `${block({ a: 1 })}\n${block({ b: 2 })}\n`

    // Act
    const result = extractLastJsonBlock(input)

    // Assert
    expect(result).toEqual({ raw: '{"b":2}', blockCount: 2, trailingText: false })
  })
  test('flags trailing text', () => {
    // Arrange
    const input = `${block({ a: 1 })}after`

    // Act
    const result = extractLastJsonBlock(input)

    // Assert
    expect(result.trailingText).toBe(true)
  })
  test('flags missing blocks', () => {
    // Arrange
    const input = 'plain'

    // Act
    const result = extractLastJsonBlock(input)

    // Assert
    expect(result).toEqual({ raw: null, blockCount: 0, trailingText: false })
  })
})

describe.each([
  ['map', mapValue, {}], ['round', roundValue, { round: 2 }],
  ['feasibility', feasibilityValue, {}],
])('%s kind', (kind, makeValue, options) => {
  test('parses valid input', () => {
    // Arrange
    const input = block(makeValue())

    // Act
    const result = parseDebateOutput(input, { kind, ...options })

    // Assert
    expect(result).toMatchObject({ kind, parsed: true, dropped: 0 })
  })
  test('fails malformed blocks', () => {
    // Arrange
    const input = 'prose only'

    // Act
    const result = parseDebateOutput(input, { kind, ...options })

    // Assert
    expect(result).toMatchObject({ parsed: false, parseError: expect.stringMatching(/no fenced/) })
  })
})

test('fails closed for invalid JSON', () => {
  // Arrange
  const input = '```json\n{"kind":\n```'

  // Act
  const result = parseDebateOutput(input, { kind: 'map' })

  // Assert
  expect(result.parseError).toMatch(/invalid json/)
})
test('fails closed for a non-object top level', () => {
  // Arrange
  const input = block([])

  // Act
  const result = parseDebateOutput(input, { kind: 'map' })

  // Assert
  expect(result.parseError).toBe('top level must be an object')
})
test('fails closed for multiple blocks', () => {
  // Arrange
  const input = `${block(mapValue())}\n${block(mapValue())}`

  // Act
  const result = parseDebateOutput(input, { kind: 'map' })

  // Assert
  expect(result.parseError).toMatch(/exactly one fenced json block/)
})
test('fails closed for trailing text', () => {
  // Arrange
  const input = `${block(mapValue())}\ntrailing`

  // Act
  const result = parseDebateOutput(input, { kind: 'map' })

  // Assert
  expect(result.parseError).toMatch(/text follows/)
})

test.each([
  ['map', { ...mapValue(), stocks: undefined }, undefined, 'missing required field: stocks'],
  ['round', { ...roundValue(), contributions: undefined }, 2, 'missing required field: contributions'],
  ['feasibility', { ...feasibilityValue(), risks: undefined }, undefined, 'missing required field: risks'],
])('fails closed when %s omits a required field', (kind, value, round, expected) => {
  // Arrange
  const input = { ...value }
  const missingKey = Object.keys(input).find((key) => input[key] === undefined)
  delete input[missingKey]

  // Act
  const result = parse(kind, input, round)

  // Assert
  expect(result).toMatchObject({ parsed: false, parseError: expected })
})

test('fails closed when the round does not match', () => {
  // Arrange
  const input = { ...roundValue(), round: 1 }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.parseError).toMatch(/round mismatch/)
})
test.each(['steelman', 'counterThesis'])('fails round 1 when %s is empty', (field) => {
  // Arrange
  const input = { ...roundValue(), round: 1, counterThesis: 'counter', [field]: '' }

  // Act
  const result = parse('round', input, 1)

  // Assert
  expect(result.parsed).toBe(false)
  expect(result.parseError).toBe(field === 'steelman'
    ? 'steelman must be a non-empty string'
    : 'counterThesis must be a non-empty string for round 1')
})
test('fails round parsing when steelman is missing', () => {
  // Arrange
  const input = { ...roundValue() }
  delete input.steelman

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result).toMatchObject({ parsed: false, parseError: 'missing required field: steelman' })
})
test('fails round parsing when violations are not an array', () => {
  // Arrange
  const input = { ...roundValue(), violations: {} }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result).toMatchObject({
    parsed: false,
    parseError: 'challenges, contributions and violations must be arrays',
  })
})
test('accepts null counterThesis from round 2', () => {
  // Arrange
  const input = { ...roundValue(), counterThesis: null }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.parsed).toBe(true)
})
test('rejects an empty counterThesis from round 2', () => {
  // Arrange
  const input = { ...roundValue(), counterThesis: '   ' }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result).toMatchObject({
    parsed: false,
    parseError: 'counterThesis must be null or a non-empty string for round 2 or later',
  })
})
test('accepts a non-empty counterThesis from round 3', () => {
  // Arrange
  const input = { ...roundValue(), round: 3, counterThesis: 'revised counter-thesis' }

  // Act
  const result = parse('round', input, 3)

  // Assert
  expect(result).toMatchObject({ parsed: true, counterThesis: 'revised counter-thesis' })
})
test('accepts a valid round 1 counterThesis', () => {
  // Arrange
  const input = { ...roundValue(), round: 1, counterThesis: 'counter' }

  // Act
  const result = parse('round', input, 1)

  // Assert
  expect(result).toMatchObject({ parsed: true, counterThesis: 'counter' })
})
test.each([
  ['target', 'bad', 'challenges[0].target'], ['scheme', 'bad', 'challenges[0].scheme'],
  ['cq', 'CQ4', 'challenges[0].cq'],
])('drops challenge with invalid %s', (field, value, reason) => {
  // Arrange
  const input = { ...roundValue(), challenges: [{ ...roundValue().challenges[0], [field]: value }] }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.droppedReasons).toContain(reason)
})
test.each([
  [{ id: 'bad', rule: 'PD1', claim: 'claim' }, 'violations[0].id'],
  [{ id: 'V1', rule: 'PD11', claim: 'claim' }, 'violations[0].rule'],
  [{ id: 'V1', rule: 'PD1', claim: '' }, 'violations[0].claim'],
])('drops invalid violations', (violation, reason) => {
  // Arrange
  const input = { ...roundValue(), violations: [violation] }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.droppedReasons).toContain(reason)
})
test('drops duplicate violation ids and projects valid violations', () => {
  // Arrange
  const input = { ...roundValue(), violations: [
    { id: 'V1', rule: 'PD1', claim: ' first ' }, { id: 'V1', rule: 'PD2', claim: 'second' },
  ] }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.violations).toEqual([{ id: 'V1', rule: 'PD1', claim: 'first' }])
  expect(result.droppedReasons).toContain('violations[1].id (duplicate)')
})
test('rejects direct round parsing outside the valid range', () => {
  // Arrange
  const input = block(roundValue())

  // Act
  const parseInvalidRound = () => parseDebateOutput(input, { kind: 'round', round: 4 })

  // Assert
  expect(parseInvalidRound).toThrow(/--round <n> is required for --kind round and must be 1-3/)
})
test('fails closed when map has the wrong kind', () => {
  // Arrange
  const input = { ...mapValue(), kind: 'round' }

  // Act
  const result = parse('map', input)

  // Assert
  expect(result.parseError).toMatch(/expected kind/)
})
test('fails closed when feasibility has the wrong kind', () => {
  // Arrange
  const input = { ...feasibilityValue(), kind: 'map' }

  // Act
  const result = parse('feasibility', input)

  // Assert
  expect(result.parseError).toMatch(/expected kind/)
})

test('drops invalid map entries in order', () => {
  // Arrange
  const value = { ...mapValue(), stocks: [{ id: 'bad', name: 'x' },
    { id: 'S1', name: ' ok ', extra: 'leak' }, { id: 'S1', name: 'dup' }],
    loops: [{ id: 'L1', type: 'X', chain: 'x' }], delays: [], leverage: [] }

  // Act
  const result = parse('map', value)

  // Assert
  expect(result.stocks).toEqual([{ id: 'S1', name: 'ok' }])
  expect(result.droppedReasons).toEqual([
    'stocks[0].id', 'stocks[2].id (duplicate)', 'loops[0].type',
  ])
})
test('drops leverage outside the valid range or non-integer', () => {
  // Arrange
  const value = { ...mapValue(), loops: [], leverage: [
    { id: 'P1', level: 0, point: 'x' }, { id: 'P2', level: 13, point: 'x' },
    { id: 'P3', level: 1.5, point: 'x' },
  ] }

  // Act
  const result = parse('map', value)

  // Assert
  expect(result.droppedReasons).toEqual([
    'leverage[0].level', 'leverage[1].level', 'leverage[2].level',
  ])
})
test('drops invalid round challenges', () => {
  // Arrange
  const value = { ...roundValue(), challenges: [{ ...roundValue().challenges[0], type: 'BAD' }] }

  // Act
  const result = parse('round', value, 2)

  // Assert
  expect(result.droppedReasons).toEqual(['challenges[0].type'])
})
test('drops invalid round contributions', () => {
  // Arrange
  const value = { ...roundValue(), contributions: [{ id: 'N1', claim: '' },
    { id: 'N1', claim: 'dup' }] }

  // Act
  const result = parse('round', value, 2)

  // Assert
  expect(result.droppedReasons).toEqual(['contributions[0].claim'])
})
test('drops duplicate contribution ids', () => {
  // Arrange
  const value = { ...roundValue(), contributions: [
    { id: 'N1', claim: 'first' }, { id: 'N1', claim: 'second' },
  ] }

  // Act
  const result = parse('round', value, 2)

  // Assert
  expect(result.contributions).toEqual([{ id: 'N1', claim: 'first' }])
  expect(result.droppedReasons).toEqual(['contributions[1].id (duplicate)'])
})
test('drops invalid feasibility list entries and risks', () => {
  // Arrange
  const value = { ...feasibilityValue(), dependencies: ['', 'ok', 2], conditions: [null, 'ready'],
    risks: [{ id: 'bad', risk: 'x' }, { id: 'K1', risk: '' }] }

  // Act
  const result = parse('feasibility', value)

  // Assert
  expect(result.droppedReasons).toEqual([
    'risks[0].id', 'risks[1].risk', 'dependencies[0]', 'dependencies[2]', 'conditions[0]',
  ])
  expect(result.dependencies).toEqual(['ok'])
})

test('fails feasibility on invalid verdict', () => {
  // Arrange
  const input = { ...feasibilityValue(), verdict: 'MAYBE' }

  // Act
  const result = parse('feasibility', input)

  // Assert
  expect(result).toMatchObject({ parsed: false, parseError: 'invalid verdict' })
})
test('fails round parsing when contributions are missing', () => {
  // Arrange
  const input = { ...roundValue(), contributions: undefined }

  // Act
  const result = parse('round', input, 1)

  // Assert
  expect(result).toMatchObject({ parsed: false, parseError: 'missing required field: contributions' })
})
test.each([
  ['effort', 'BAD', 'invalid effort'], ['reversible', 'maybe', 'invalid reversible'],
  ['firstStep', '', 'firstStep must be a non-empty string'],
])('fails feasibility on invalid %s', (field, value, expected) => {
  // Arrange
  const input = { ...feasibilityValue(), [field]: value }

  // Act
  const result = parse('feasibility', input)

  // Assert
  expect(result).toMatchObject({ parsed: false, parseError: expected })
})
test('fails feasibility when a list field is not an array', () => {
  // Arrange
  const input = { ...feasibilityValue(), dependencies: {} }

  // Act
  const result = parse('feasibility', input)

  // Assert
  expect(result).toMatchObject({ parsed: false,
    parseError: 'dependencies, risks and conditions must be arrays' })
})
test('projects round entries and trims text fields', () => {
  // Arrange
  const challenge = { ...roundValue().challenges[0], claim: '  claim  ',
    evidence: '  source  ', extra: 'leak' }
  const input = { ...roundValue(), challenges: [challenge] }

  // Act
  const result = parse('round', input, 2)

  // Assert
  expect(result.challenges).toEqual([{ id: 'C1', type: 'LOGIC', severity: 'MAJOR',
    status: 'NEW', target: 'claim', scheme: 'cause-effect', cq: 'CQ1', claim: 'claim', evidence: 'source' }])
})
test('drops challenges without evidence after validating claim', () => {
  // Arrange
  const value = { ...roundValue(), challenges: [{ ...roundValue().challenges[0], evidence: '  ' }] }

  // Act
  const result = parse('round', value, 2)

  // Assert
  expect(result.droppedReasons).toEqual(['challenges[0].evidence'])
})
test('projects trimmed challenge evidence', () => {
  // Arrange
  const value = { ...roundValue(), challenges: [{ ...roundValue().challenges[0], evidence: '  source  ' }] }

  // Act
  const result = parse('round', value, 2)

  // Assert
  expect(result.challenges[0].evidence).toBe('source')
})

describe('CLI and exit codes', () => {
  const tempDirs: string[] = []
  afterEach(() => tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  test('requires round for round kind', () => {
    // Arrange
    const args = ['--kind', 'round', '--round', '2']

    // Act
    const result = parseCliArgs(args)

    // Assert
    expect(result).toEqual({ kind: 'round', round: 2, file: undefined })
  })
  test.each([
    ['map', 'only accepted', '1'],
    ['feasibility', 'only accepted', '1'],
    ['round', '1-3', '0'],
    ['round', '1-3', '4'],
  ])('rejects invalid round argument for %s (%s)', (kind, message, round) => {
    // Arrange
    const parseInvalidArgs = () => parseCliArgs(['--kind', kind, '--round', round])

    // Act
    const result = parseInvalidArgs

    // Assert
    expect(result).toThrow(new RegExp(message))
  })
  test('returns failure for an unknown kind', () => {
    // Arrange
    const errors: string[] = []

    // Act
    const exitCode = main(['--kind', 'signoff'], { stdout: () => undefined,
      stderr: (message: string) => errors.push(message) })

    // Assert
    expect(exitCode).toBe(EXIT_FAILURE)
    expect(errors[0]).toMatch(/kind/)
  })
  test('preserves documented exit code constants', () => {
    // Arrange
    const expected = { ok: 0, malformed: 1, failure: 2 }

    // Act
    const actual = { ok: EXIT_OK, malformed: EXIT_MALFORMED, failure: EXIT_FAILURE }

    // Assert
    expect(actual).toEqual(expected)
  })
  test('prints a valid result and returns success', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'debate-parse-'))
    tempDirs.push(dir)
    const file = join(dir, 'input.md')
    writeFileSync(file, block(mapValue()))
    const output: string[] = []

    // Act
    const exitCode = main(['--kind', 'map', '--file', file], { stdout: (line: string) => output.push(line),
      stderr: () => undefined })

    // Assert
    expect(exitCode).toBe(EXIT_OK)
    expect(JSON.parse(output[0])).toMatchObject({ parsed: true, dropped: 0 })
  })
  test('prints dropped reasons and returns malformed', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'debate-parse-'))
    tempDirs.push(dir)
    const file = join(dir, 'input.md')
    writeFileSync(file, block({ ...mapValue(), stocks: [{ id: 'bad', name: 'x' }] }))
    const output: string[] = []

    // Act
    const exitCode = main(['--kind', 'map', '--file', file], { stdout: (line: string) => output.push(line),
      stderr: () => undefined })

    // Assert
    expect(exitCode).toBe(EXIT_MALFORMED)
    expect(JSON.parse(output[0]).droppedReasons).toEqual(['stocks[0].id'])
  })
  test('returns failure for an unreadable file', () => {
    // Arrange
    const errors: string[] = []
    const args = ['--kind', 'map', '--file', join(tmpdir(), 'missing-debate-file.md')]

    // Act
    const exitCode = main(args, { stdout: () => undefined,
      stderr: (message: string) => errors.push(message) })

    // Assert
    expect(exitCode).toBe(EXIT_FAILURE)
    expect(errors[0]).toMatch(/cannot read input/)
  })
})
