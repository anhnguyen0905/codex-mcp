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

const ROUND_BLOCK = `## Challenges
C1 ... prose ...

\`\`\`json
{"round":2,"challenges":[
  {"id":"C1","severity":"BLOCKER","status":"HOLD","claim":"Parsing is not fail-closed."},
  {"id":"C13","severity":"MAJOR","status":"NEW","claim":"No-code integrity is not enforced."}
],"alternative":null,"dissent":"still unconvinced"}
\`\`\`
`

describe('extractLastJsonBlock', () => {
  test('returns the last fenced json block and the block count', () => {
    // Arrange
    const text = '```json\n{"a":1}\n```\nprose\n```json\n{"b":2}\n```\n'

    // Act
    const result = extractLastJsonBlock(text)

    // Assert
    expect(result).toEqual({ raw: '{"b":2}', blockCount: 2, trailingText: false })
  })

  test('flags non-whitespace text after the closing fence', () => {
    const result = extractLastJsonBlock('```json\n{"a":1}\n```\nafterthought')

    expect(result.trailingText).toBe(true)
  })

  test('returns null raw and zero count when no fenced json block exists', () => {
    // Arrange
    const text = 'no block here\n```\nnot json fence\n```'

    // Act
    const result = extractLastJsonBlock(text)

    // Assert
    expect(result).toEqual({ raw: null, blockCount: 0, trailingText: false })
  })
})

describe('parseDebateOutput — round kind', () => {
  test('parses a valid round block with zero dropped entries', () => {
    // Arrange + Act
    const result = parseDebateOutput(ROUND_BLOCK, { kind: 'round', round: 2 })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.dropped).toBe(0)
    expect(result.droppedReasons).toEqual([])
    expect(result.challenges.map((c: { id: string }) => c.id)).toEqual(['C1', 'C13'])
    expect(result.alternative).toBeNull()
    expect(result.dissent).toBe('still unconvinced')
    expect(result.blockCount).toBe(1)
  })

  test('fails closed when the block is missing', () => {
    // Act
    const result = parseDebateOutput('prose only', { kind: 'round', round: 1 })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toMatch(/no fenced json block/i)
    expect(result.challenges).toEqual([])
  })

  test('fails closed when the json is syntactically invalid', () => {
    // Act
    const result = parseDebateOutput('```json\n{"round":1,\n```', { kind: 'round', round: 1 })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toMatch(/invalid json/i)
  })

  test('fails closed when round does not match the round being run', () => {
    // Act
    const result = parseDebateOutput(ROUND_BLOCK, { kind: 'round', round: 3 })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toMatch(/round/)
  })

  test('drops malformed entries with one ordered reason each and keeps valid ones', () => {
    // Arrange
    const text = '```json\n' + JSON.stringify({
      round: 1,
      challenges: [
        { id: 'C1', severity: 'BLOCKER', status: 'NEW', claim: 'ok' },
        { id: 'X2', severity: 'BLOCKER', status: 'NEW', claim: 'bad id' },
        { id: 'C3', severity: 'HUGE', status: 'NEW', claim: 'bad severity' },
        { id: 'C4', severity: 'MINOR', status: 'MAYBE', claim: 'bad status' },
        { id: 'C5', severity: 'MINOR', status: 'NEW', claim: '' },
        { id: 'C1', severity: 'MINOR', status: 'NEW', claim: 'duplicate id' },
        'not an object',
      ],
      alternative: null,
      dissent: null,
    }) + '\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'round', round: 1 })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.challenges.map((c: { id: string }) => c.id)).toEqual(['C1'])
    expect(result.dropped).toBe(6)
    expect(result.droppedReasons).toEqual([
      'challenges[1].id',
      'challenges[2].severity',
      'challenges[3].status',
      'challenges[4].claim',
      'challenges[5].id (duplicate)',
      'challenges[6] (not an object)',
    ])
    expect(result.dropped).toBe(result.droppedReasons.length)
  })

  test('fails closed on more than one fenced block or trailing text', () => {
    // Arrange
    const twoBlocks = ROUND_BLOCK + '\n' + ROUND_BLOCK
    const trailing = ROUND_BLOCK + 'one more sentence'

    // Act + Assert
    expect(parseDebateOutput(twoBlocks, { kind: 'round', round: 2 })).toMatchObject({
      parsed: false,
      parseError: expect.stringMatching(/exactly one fenced json block, found 2/),
    })
    expect(parseDebateOutput(trailing, { kind: 'round', round: 2 })).toMatchObject({
      parsed: false,
      parseError: expect.stringMatching(/text follows/),
    })
  })

  test('fails closed when a required top-level field is absent instead of coercing it', () => {
    // Arrange
    const text = '```json\n{"round":1,"challenges":[]}\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'round', round: 1 })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toBe('missing required field: alternative')
  })

  test('rejects a non-array challenges field and non-string alternative or dissent', () => {
    // Arrange
    const text = '```json\n{"round":1,"challenges":{},"alternative":5,"dissent":null}\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'round', round: 1 })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toMatch(/challenges/)
  })
})

describe('parseDebateOutput — signoff kind', () => {
  test('parses a valid signoff block', () => {
    // Arrange
    const text = '```json\n' + JSON.stringify({
      round: 'signoff',
      misattributions: [
        { id: 'C3', expected: 'OPEN', observed: 'AGREED', evidence: 'DEBATE.md round 2' },
      ],
      dissent: null,
    }) + '\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'signoff' })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.dropped).toBe(0)
    expect(result.misattributions).toHaveLength(1)
    expect(result.dissent).toBeNull()
  })

  test('parses optional pending verdicts and drops malformed ones with reasons', () => {
    // Arrange
    const text = '```json\n' + JSON.stringify({
      round: 'signoff',
      misattributions: [],
      pending: [
        { id: 'C2', verdict: 'CONFIRM', evidence: 'thesis v4 (g) names the CI rule' },
        { id: 'C3', verdict: 'HOLD', evidence: 'no backtest yet' },
        { id: 'C5', verdict: 'MAYBE', evidence: 'x' },
        { id: 'nope', verdict: 'CONFIRM', evidence: 'x' },
        { id: 'C7', verdict: 'CONFIRM' },
      ],
      dissent: null,
    }) + '\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'signoff' })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.pending).toEqual([
      { id: 'C2', verdict: 'CONFIRM', evidence: 'thesis v4 (g) names the CI rule' },
      { id: 'C3', verdict: 'HOLD', evidence: 'no backtest yet' },
    ])
    expect(result.droppedReasons).toEqual(['pending[2].verdict', 'pending[3].id', 'pending[4].evidence'])
    expect(result.dropped).toBe(3)
  })

  test('treats a missing pending field as an empty list and rejects a non-array one', () => {
    const base = { round: 'signoff', misattributions: [], dissent: null }

    expect(parseDebateOutput('```json\n' + JSON.stringify(base) + '\n```', { kind: 'signoff' }).pending).toEqual([])
    expect(parseDebateOutput('```json\n' + JSON.stringify({ ...base, pending: {} }) + '\n```', { kind: 'signoff' })).toMatchObject({
      parsed: false,
      parseError: 'pending must be an array',
    })
  })

  test('drops misattributions missing required string fields', () => {
    // Arrange
    const text = '```json\n' + JSON.stringify({
      round: 'signoff',
      misattributions: [{ id: 'C3', expected: 'OPEN' }],
      dissent: 'x',
    }) + '\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'signoff' })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.misattributions).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.droppedReasons).toEqual(['misattributions[0].observed'])
  })

  test('drops a misattribution whose id is not a challenge id', () => {
    // Arrange
    const text = '```json\n' + JSON.stringify({
      round: 'signoff',
      misattributions: [{ id: 'not-C3', expected: 'a', observed: 'b', evidence: 'c' }],
      dissent: null,
    }) + '\n```'

    // Act
    const result = parseDebateOutput(text, { kind: 'signoff' })

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.droppedReasons).toEqual(['misattributions[0].id'])
  })

  test('fails closed when the signoff block omits dissent', () => {
    const text = '```json\n{"round":"signoff","misattributions":[]}\n```'

    expect(parseDebateOutput(text, { kind: 'signoff' })).toMatchObject({
      parsed: false,
      parseError: 'missing required field: dissent',
    })
  })

  test('fails closed when a round block is passed as a signoff', () => {
    // Act
    const result = parseDebateOutput(ROUND_BLOCK, { kind: 'signoff' })

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toBe('missing required field: misattributions')
  })
})

describe('parseCliArgs and exit codes', () => {
  test('parses kind, round and file flags', () => {
    // Act
    const args = parseCliArgs(['--kind', 'round', '--round', '2', '--file', 'out.md'])

    // Assert
    expect(args).toEqual({ kind: 'round', round: 2, file: 'out.md' })
  })

  test('rejects an unknown kind and a round kind without a round number', () => {
    expect(() => parseCliArgs(['--kind', 'other'])).toThrow(/kind/)
    expect(() => parseCliArgs(['--kind', 'round'])).toThrow(/round/)
  })

  test('rejects unknown flags, out-of-cap rounds, and a round on signoff', () => {
    expect(() => parseCliArgs(['--kind', 'round', '--round', '1', '--wat', 'x'])).toThrow(/unknown flag --wat/)
    expect(() => parseCliArgs(['--kind', 'round', '--round', '0'])).toThrow(/1-3/)
    expect(() => parseCliArgs(['--kind', 'round', '--round', '4'])).toThrow(/1-3/)
    expect(() => parseCliArgs(['--kind', 'signoff', '--round', '1'])).toThrow(/not accepted/)
  })

  test('exposes distinct exit codes for ok, malformed, and failure', () => {
    expect(EXIT_OK).toBe(0)
    expect(EXIT_MALFORMED).toBe(1)
    expect(EXIT_FAILURE).toBe(2)
  })
})

describe('main — CLI entry', () => {
  const tempDirs: string[] = []
  const makeInputFile = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'debate-parse-'))
    tempDirs.push(dir)
    const file = join(dir, 'astra.md')
    writeFileSync(file, content)
    return file
  }
  const captureIo = () => {
    const out: string[] = []
    const err: string[] = []
    return { io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) }, out, err }
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('exits 0 and prints the parsed result for a valid round file', () => {
    // Arrange
    const file = makeInputFile(ROUND_BLOCK)
    const { io, out } = captureIo()

    // Act
    const code = main(['--kind', 'round', '--round', '2', '--file', file], io)

    // Assert
    expect(code).toBe(EXIT_OK)
    expect(JSON.parse(out.join(''))).toMatchObject({ parsed: true, dropped: 0, round: 2 })
  })

  test('exits 1 but still prints the reasons when the block is malformed', () => {
    // Arrange
    const file = makeInputFile('no json here')
    const { io, out } = captureIo()

    // Act
    const code = main(['--kind', 'round', '--round', '1', '--file', file], io)

    // Assert
    expect(code).toBe(EXIT_MALFORMED)
    expect(JSON.parse(out.join(''))).toMatchObject({ parsed: false })
  })

  test('exits 2 on a usage error and on an unreadable file', () => {
    // Arrange
    const usage = captureIo()
    const unreadable = captureIo()

    // Act
    const usageCode = main(['--kind', 'nope'], usage.io)
    const readCode = main(['--kind', 'signoff', '--file', join(tmpdir(), 'missing-debate-file.md')], unreadable.io)

    // Assert
    expect(usageCode).toBe(EXIT_FAILURE)
    expect(usage.err[0]).toMatch(/kind/)
    expect(readCode).toBe(EXIT_FAILURE)
    expect(unreadable.err[0]).toMatch(/cannot read input/)
  })
})
