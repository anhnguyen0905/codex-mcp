import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactSecrets } from '../src/redaction'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  appendLine,
  buildLine,
  detectLanguage,
  main,
  parseAppendArgs,
  redactRequest,
  summarize,
} from '../scripts/run-ledger.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { foldVietnamese } from '../scripts/skill-terms.mjs'

const base = (request: string) => ({
  lane: 'full', project: '/tmp/project', runId: 'r1', profile: 'code', domain: 'testing', request,
  fixRounds: 1, codexTokens: 20, started: new Date(Date.now() - 120000).toISOString(), ownerGates: 2,
  outcome: 'done',
})
const cliArgs = (extra: string[] = []) => [
  'append', '--lane', 'full', '--project', '/tmp/project', '--run-id', 'r1', '--profile', 'code',
  '--domain', 'testing', '--request', 'hello', '--fix-rounds', '1', '--started', new Date().toISOString(),
  '--owner-gates', '0', '--outcome', 'done', '--skills', '', '--bypasses', '', ...extra,
]

afterEach(() => {
  delete process.env.CODEX_MCP_RUN_LEDGER
})

describe('run ledger', () => {
  it('appends valid lines and preserves prior content', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    const first = buildLine(base('hello'))
    appendLine(first, file)

    // Act
    appendLine(buildLine({ ...base('xin chào'), runId: 'r2' }), file)

    // Assert
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it.each([
    ['hello world', 'en'],
    ['xin chào tiếng Việt', 'vi'],
    ['hello world tiếng code', 'mixed'],
  ])('detects %s', (text, expected) => {
    // Arrange / Act
    const actual = detectLanguage(text)

    // Assert
    expect(actual).toBe(expected)
  })

  it('folded Vietnamese holdout requests are detected as vi', () => {
    // Arrange
    const fixture = JSON.parse(readFileSync('tests/fixtures/scenarios-vi.json', 'utf8'))
    const requests = fixture.scenarios.filter(({ split }) => split === 'holdout')
      .map(({ request }) => foldVietnamese(request))

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(requests).toHaveLength(52)
    expect(actual.filter((language) => language === 'vi').length).toBeGreaterThanOrEqual(47)
  })

  it('English holdout requests stay en', () => {
    // Arrange
    const fixture = JSON.parse(readFileSync('tests/fixtures/scenarios-holdout.json', 'utf8'))
    const requests = fixture.scenarios.map(({ request }) => request)
      .filter((request) => !/[ăâđêôơưà-ỹĂÂĐÊÔƠƯÀ-Ỹ]/u.test(request))

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(requests).toHaveLength(70)
    expect(actual.filter((language) => language === 'vi')).toHaveLength(0)
    expect(actual.filter((language) => language === 'en').length).toBeGreaterThanOrEqual(67)
  })

  it('folded Vietnamese dev requests are detected as vi', () => {
    // Arrange
    const fixture = JSON.parse(readFileSync('tests/fixtures/scenarios-vi.json', 'utf8'))
    const requests = fixture.scenarios.filter(({ split }) => split !== 'holdout')
      .map(({ request }) => foldVietnamese(request))

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(requests).toHaveLength(105)
    expect(actual.filter((language) => language === 'vi').length).toBeGreaterThanOrEqual(100)
  })

  it('scenarios-500 English requests stay en', () => {
    // Arrange
    const fixture = JSON.parse(readFileSync('tests/fixtures/scenarios-500.json', 'utf8'))
    const requests = fixture.scenarios.map(({ request }) => request)
      .filter((request) => !/[ăâđêôơưà-ỹĂÂĐÊÔƠƯÀ-Ỹ]/u.test(request))

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual.filter((language) => language === 'en').length).toBeGreaterThanOrEqual(
      Math.ceil(requests.length * 0.99),
    )
  })

  it.each([
    'Improve I/O throughput of the export job',
    'Add a ban button for abusive players',
    'Analyze the Hay Day economy loop',
    'Write a de-dupe step for purchase events',
    'Fix the rat enemy pathing bug',
    'Localize the store page for the Viet market',
    'How many participants do I need for this test',
  ])('a single coincidental Vietnamese stop word keeps English as en: %s', (request) => {
    // Arrange / Act
    const actual = detectLanguage(request)

    // Assert
    expect(actual).toBe('en')
  })

  it('detects unaccented Vietnamese requests', () => {
    // Arrange
    const requests = [
      'phan tich pheu mua hang tu dau thang 11',
      'chay lai voi data tren bigquery tu dau thang 11',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(['vi', 'vi'])
  })

  it('numbers do not shift word classification', () => {
    // Arrange
    const requests = [
      ['Top 10 phan tich pheu mua hang cho game', 'vi'],
      ['Top 10 funnel metrics for the game', 'en'],
    ]

    // Act / Assert
    for (const [request, expected] of requests) expect(detectLanguage(request)).toBe(expected)
  })

  it('tokens outside Vietnamese letters do not shift classification', () => {
    // Arrange
    const requests = [
      ['Đo × tỷ lệ chuyển đổi cho game', 'vi'],
      ['Score × weight for the game', 'en'],
    ]

    // Act / Assert
    for (const [request, expected] of requests) expect(detectLanguage(request)).toBe(expected)
  })

  it('keeps English with one borrowed term as en', () => {
    // Arrange
    const request = 'Analyze the purchase funnel for the pho shop in November'

    // Act
    const actual = detectLanguage(request)

    // Assert
    expect(actual).toBe('en')
  })

  it('keeps accented detection unchanged', () => {
    // Arrange
    const cases = [
      ['hello world', 'en'],
      ['xin chào tiếng Việt', 'vi'],
      ['hello world tiếng code', 'mixed'],
    ]

    // Act / Assert
    for (const [text, expected] of cases) expect(detectLanguage(text)).toBe(expected)
  })

  it('returns mixed for a balanced sentence', () => {
    // Arrange
    const request = 'Analyze the phan tich report carefully today'

    // Act
    const actual = detectLanguage(request)

    // Assert
    // The glossary phrase contributes 2 of 7 words, so the computed share is 0 < share < 0.3.
    expect(actual).toBe('mixed')
  })

  it('keeps pure English as en', () => {
    // Arrange
    const request = 'Write a weekly retention dashboard in English'

    // Act
    const actual = detectLanguage(request)

    // Assert
    expect(actual).toBe('en')
  })

  it.each([
    ['pem-private-key', '-----BEGIN RSA PRIVATE KEY-----secret-----END RSA PRIVATE KEY-----'],
    ['jwt', 'eyJabcd.efgh.ijkl'],
    ['openai-key', 'sk-1234567890123456'],
    ['github-token', 'ghp_12345678901234567890'],
    ['aws-access-key-id', 'AKIA1234567890ABCDEF'],
    ['aws-secret-access-key', 'aws_secret_access_key=12345678901234567890'],
    ['slack-token', 'xoxb-1234567890'],
    ['google-api-key', 'AIza123456789012345678901234567890123'],
    ['bearer-token', 'Bearer abcdefgh'],
    ['env-secret double-quoted', 'PASSWORD="secret value"'],
    ['env-secret single-quoted', "PASSWORD='secret value'"],
    ['env-secret bare', 'TOKEN=secretvalue'],
    ['plain Vietnamese', 'Xin chào, đây là một câu bình thường.'],
    ['plain English', 'This is an ordinary sentence.'],
  ])('matches src redaction for %s', (_kind, fixture) => {
    // Arrange
    const expected = redactSecrets(fixture).text

    // Act
    const actual = redactRequest(fixture)

    // Assert
    expect(actual).toBe(expected)
    if (_kind.startsWith('plain')) expect(actual).toBe(fixture)
  })

  it('caps requests and skips malformed summary lines', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    appendLine(buildLine(base('x'.repeat(5000))), file)
    writeFileSync(file, `${readFileSync(file, 'utf8')}not-json\n`)

    // Act
    const result = summarize(file)

    // Assert
    expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).request).toHaveLength(4000)
    expect(result).toMatchObject({ total: 1, malformed: 1 })
  })

  it.each([
    ['invalid enum', ['--profile', 'wrong']],
    ['missing value', ['--outcome']],
    ['unknown flag', ['--bogus', 'x']],
    ['negative count', ['--fix-rounds', '-1']],
    ['non-ISO start', ['--started', '123']],
    ['future start', ['--started', new Date(Date.now() + 6 * 60 * 1000).toISOString()]],
  ])('rejects %s without writing', (_name, extra) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    process.env.CODEX_MCP_RUN_LEDGER = file
    const args = cliArgs(extra)

    // Act
    const exitCode = main(args)

    // Assert
    expect(exitCode).toBe(2)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('returns exit 1 for an append I/O failure', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger-dir')
    mkdirSync(file)
    process.env.CODEX_MCP_RUN_LEDGER = file

    // Act
    const exitCode = main(cliArgs())

    // Assert
    expect(exitCode).toBe(1)
  })

  it('rejects an omitted required flag', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    process.env.CODEX_MCP_RUN_LEDGER = file
    const args = cliArgs().filter((value, index, values) => {
      return value !== '--outcome' && values[index - 1] !== '--outcome'
    })

    // Act
    const exitCode = main(args)

    // Assert
    expect(exitCode).toBe(2)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('records override language and injected wall clock', () => {
    // Arrange
    const started = '2026-01-01T00:00:00.000Z'
    const now = new Date('2026-01-01T00:03:30.000Z')

    // Act
    const line = buildLine({ ...base('hello'), language: 'vi', started }, now)

    // Assert
    expect(line).toMatchObject({ language: 'vi', languageSource: 'override', wallClockMinutes: 3.5 })
  })

  it('writes switch fields only when append flags are given', () => {
    // Arrange
    const withoutModes = buildLine(base('hello'))
    const withModes = buildLine({
      ...base('hello'), profileMode: 'shadow', evidenceMode: 'enforce', languageMode: 'on',
    })

    // Act / Assert
    expect(withoutModes).not.toHaveProperty('profileMode')
    expect(withoutModes).not.toHaveProperty('evidenceMode')
    expect(withoutModes).not.toHaveProperty('languageMode')
    expect(withModes).toMatchObject({ profileMode: 'shadow', evidenceMode: 'enforce', languageMode: 'on' })
  })

  it.each([
    ['profile-mode', 'shadow', 'invalid'],
    ['evidence-mode', 'enforce', 'invalid'],
    ['language-mode', 'on', 'invalid'],
  ])('writes and validates %s', (flag, validValue, invalidValue) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    process.env.CODEX_MCP_RUN_LEDGER = file

    // Act
    const validExitCode = main(cliArgs([`--${flag}`, validValue]))
    const validLine = JSON.parse(readFileSync(file, 'utf8'))
    const invalidExitCode = main(cliArgs([`--${flag}`, invalidValue]))

    // Assert
    expect(validExitCode).toBe(0)
    expect(validLine).toHaveProperty({
      'profile-mode': 'profileMode', 'evidence-mode': 'evidenceMode', 'language-mode': 'languageMode',
    }[flag], validValue)
    expect(invalidExitCode).toBe(2)
  })

  it('aggregates summary and applies the project filter', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    appendLine(buildLine({ ...base('one'), project: '/tmp/a', fixRounds: 1, ownerGates: 1, bypasses: [] }), file)
    appendLine(buildLine({
      ...base('two'), project: '/tmp/a', runId: 'r2', fixRounds: 3, ownerGates: 3, bypasses: ['x'],
    }), file)
    appendLine(buildLine({ ...base('three'), project: '/tmp/b', runId: 'r3', fixRounds: 9 }), file)

    // Act
    const result = summarize(file, '/tmp/a')

    // Assert
    expect(result).toMatchObject({ total: 2, medians: { fixRounds: 2, ownerGates: 2 }, bypassRate: 0.5 })
    expect(result.counts).toEqual({ 'code × en × done': 2 })
  })

  it.each([
    ['lane', 'full', 'brainstorm'],
    ['profile', 'code', 'data'],
    ['language', 'en', 'vi'],
    ['outcome', 'done', 'failed'],
    ['profileMode', 'shadow', 'enforce'],
    ['evidenceMode', 'off', 'enforce'],
    ['languageMode', 'off', 'on'],
  ])('filters summaries by %s', (key, matchingValue, nonMatchingValue) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    const matching = { ...base('one'), [key]: matchingValue }
    const nonMatching = { ...base('two'), runId: 'r2', [key]: nonMatchingValue }
    appendLine(buildLine(matching), file)
    appendLine(buildLine(nonMatching), file)

    // Act
    const oneKey = summarize(file, undefined, [`${key}=${matchingValue}`])
    const twoKeys = summarize(file, undefined, [`${key}=${matchingValue}`, 'evidenceMode=off'])

    // Assert
    expect(oneKey.total).toBe(1)
    expect(twoKeys.total).toBe(1)
  })

  it('filters the CLI JSON summary', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    appendLine(buildLine({ ...base('shadow'), profileMode: 'shadow' }), file)
    appendLine(buildLine({ ...base('enforce'), runId: 'r2', profileMode: 'enforce' }), file)
    process.env.CODEX_MCP_RUN_LEDGER = file
    let output = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })

    // Act
    const exitCode = main(['summary', '--json', '--filter', 'profileMode=shadow'])
    const result = JSON.parse(output)

    // Assert
    expect(exitCode).toBe(0)
    expect(Object.keys(result)).toEqual([
      'total', 'counts', 'medians', 'bypassRate', 'malformed',
    ])
    expect(result.total).toBe(1)
    write.mockRestore()
  })

  it('matches absent switch fields as off', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    appendLine(buildLine(base('old line')), file)

    // Act
    const result = summarize(file, undefined, ['profileMode=off'])

    // Assert
    expect(result.total).toBe(1)
  })

  it.each(['bad=value', 'profileMode=bad'])('rejects invalid summary filter %s', (filter) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    process.env.CODEX_MCP_RUN_LEDGER = file

    // Act
    const exitCode = main(['summary', '--filter', filter])

    // Assert
    expect(exitCode).toBe(2)
  })

  it('prints the empty summary through the environment override', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    process.env.CODEX_MCP_RUN_LEDGER = join(dir, 'missing.jsonl')

    // Act
    const exitCode = main(['summary'])

    // Assert
    expect(exitCode).toBe(0)
  })

  it('prints the empty summary as JSON when requested', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    process.env.CODEX_MCP_RUN_LEDGER = join(dir, 'missing.jsonl')
    let output = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })

    // Act
    const exitCode = main(['summary', '--json'])

    // Assert
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({
      total: 0,
      counts: {},
      medians: { fixRounds: null, codexTokens: null, wallClockMinutes: null, ownerGates: null },
      bypassRate: 0,
      malformed: 0,
    })
    write.mockRestore()
  })

  it.each(['filtered', 'malformed-only'])('prints %s zero-run summaries as JSON', (kind) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    if (kind === 'filtered') appendLine(buildLine({ ...base('hello'), project: '/tmp/other' }), file)
    if (kind === 'malformed-only') writeFileSync(file, 'not-json\n')
    process.env.CODEX_MCP_RUN_LEDGER = file
    let output = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })

    // Act
    const args = kind === 'filtered'
      ? ['summary', '--project', '/tmp/project', '--json']
      : ['summary', '--json']
    const exitCode = main(args)
    const result = JSON.parse(output)

    // Assert
    expect(exitCode).toBe(0)
    expect(result.total).toBe(0)
    expect(result.counts).toEqual({})
    expect(result.medians).toEqual({
      fixRounds: null, codexTokens: null, wallClockMinutes: null, ownerGates: null,
    })
    expect(result.bypassRate).toBe(0)
    expect(result.malformed).toBe(kind === 'malformed-only' ? 1 : 0)
    write.mockRestore()
  })

  it('appends through the environment override', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    process.env.CODEX_MCP_RUN_LEDGER = file

    // Act
    const exitCode = main(cliArgs())

    // Assert
    expect(exitCode).toBe(0)
    expect(readFileSync(file, 'utf8').trim()).not.toBe('')
  })

  it.skipIf(process.platform === 'win32')('uses private modes when creating the ledger path', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const ledgerDir = join(dir, 'private')
    const file = join(ledgerDir, 'ledger.jsonl')

    // Act
    appendLine(buildLine(base('hello')), file)

    // Assert
    expect(statSync(ledgerDir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads at most 64 KiB from a request file before capping it', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    const requestFile = join(dir, 'request.txt')
    writeFileSync(requestFile, `${'x'.repeat(65536)}tail-marker`)
    process.env.CODEX_MCP_RUN_LEDGER = file
    const args = cliArgs()
    const requestIndex = args.indexOf('--request')
    args.splice(requestIndex, 2, '--request-file', requestFile)

    // Act
    const exitCode = main(args)

    // Assert
    expect(exitCode).toBe(0)
    const line = JSON.parse(readFileSync(file, 'utf8'))
    expect(line.request).toHaveLength(4000)
    expect(line.request).not.toContain('tail-marker')
  })

  it.each([false, true])('prints the %s summary format', (asJson) => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-'))
    const file = join(dir, 'ledger.jsonl')
    appendLine(buildLine({ ...base('hello'), bypasses: ['review'] }), file)
    process.env.CODEX_MCP_RUN_LEDGER = file
    let output = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })

    // Act
    const exitCode = main(asJson ? ['summary', '--json'] : ['summary'])

    // Assert
    expect(exitCode).toBe(0)
    expect(output).toContain(asJson ? '"total":1' : 'total runs: 1')
    expect(output).toContain(asJson ? '"bypassRate":1' : 'bypass rate: 1')
    write.mockRestore()
  })
})
