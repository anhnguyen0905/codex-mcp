import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — plain .mjs script
import { appendLine, buildLine } from '../scripts/run-ledger.mjs'
// @ts-expect-error — plain .mjs script
import { main } from '../scripts/harness-change.mjs'

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-change-'))
  return { store: join(directory, 'changes.jsonl'), ledger: join(directory, 'ledger.jsonl') }
}
const addArgs = (extra: string[] = []) => ['add', '--title', 'Reduce retries', '--evidence', 'three failed runs', '--cause', 'plan-wrong', '--fix', 'clarify step', '--expect', 'fewer fixes', '--at-risk', 'latency', '--filter', 'profile=code', '--after-runs', '2', ...extra]
const record = (ts: string, fixRounds: number, causes: string[] = []) => buildLine({ lane: 'full', project: '/tmp/project', runId: ts, profile: 'code', domain: 'test', request: 'invented', fixRounds, codexTokens: 1, started: ts, ownerGates: 0, outcome: 'done', causes }, new Date(ts))
const envFor = (store: string, ledger: string) => ({ CODEX_MCP_HARNESS_CHANGES: store, CODEX_MCP_RUN_LEDGER: ledger })
const validSeed = () => ({ schemaVersion: 1, kind: 'change', id: 'HC-1', ts: '2026-01-01T00:00:00.000Z', title: 'Seed', evidence: 'evidence', cause: 'plan-wrong', fix: 'fix', expect: 'expect', atRisk: 'risk', filters: [{ key: 'profile', value: 'code' }], afterRuns: 2 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('harness change', () => {
  it('persists a complete change and increments ids', () => {
    // Arrange
    const { store, ledger } = setup()
    const env = envFor(store, ledger)
    // Act
    const firstExit = main(addArgs(), env)
    const secondExit = main(addArgs(['--commit', 'abc1234']), env)
    const records = readFileSync(store, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // Assert
    expect(firstExit).toBe(0)
    expect(secondExit).toBe(0)
    expect(records[0]).toEqual({ schemaVersion: 1, kind: 'change', id: 'HC-1', ts: expect.any(String), title: 'Reduce retries', evidence: 'three failed runs', cause: 'plan-wrong', fix: 'clarify step', expect: 'fewer fixes', atRisk: 'latency', filters: [{ key: 'profile', value: 'code' }], afterRuns: 2 })
    expect(records[1]).toMatchObject({ id: 'HC-2', commit: 'abc1234' })
  })

  it.each([
    ['missing field', ['--title']],
    ['invalid cause', ['--cause', 'bogus']],
    ['invalid filter', ['--filter', 'bogus=x']],
    ['zero after-runs', ['--after-runs', '0']],
    ['invalid commit', ['--commit', 'XYZ']],
  ])('rejects %s without changing the store', (_name, extra) => {
    // Arrange
    const { store, ledger } = setup()
    writeFileSync(store, `${JSON.stringify(validSeed())}\n`)
    const before = readFileSync(store, 'utf8')
    // Act
    const exitCode = main(addArgs(extra), envFor(store, ledger))
    // Assert
    expect(exitCode).toBe(2)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('reports exact due cohorts through JSON CLI output', () => {
    // Arrange
    const { store, ledger } = setup()
    const due = { ...validSeed(), title: 'Due', ts: '2026-01-01T12:00:00.000Z', afterRuns: 2 }
    const notDue = { ...validSeed(), id: 'HC-2', title: 'Not due', ts: '2026-01-01T12:00:00.000Z', afterRuns: 3 }
    writeFileSync(store, `${JSON.stringify(due)}\n${JSON.stringify(notDue)}\n`)
    appendLine(record('2026-01-01T00:00:00.000Z', 1, ['plan-wrong']), ledger)
    appendLine(record('2026-01-02T00:00:00.000Z', 3, ['infra']), ledger)
    appendLine(record('2026-01-03T00:00:00.000Z', 5, ['plan-wrong']), ledger)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Act
    const exitCode = main(['due', '--json'], envFor(store, ledger))
    const result = JSON.parse(String(output.mock.calls[0][0]))
    // Assert
    expect(exitCode).toBe(0)
    expect(result).toHaveLength(1)
    expect(result[0].before).toEqual({ runs: 1, medianFixRounds: 1, causes: { 'spec-ambiguous': 0, 'plan-wrong': 1, 'context-missing': 0, 'skill-gap': 0, 'executor-error': 0, 'verifier-gap': 0, infra: 0 } })
    expect(result[0].after).toEqual({ runs: 2, medianFixRounds: 4, causes: { 'spec-ambiguous': 0, 'plan-wrong': 1, 'context-missing': 0, 'skill-gap': 0, 'executor-error': 0, 'verifier-gap': 0, infra: 1 } })
  })

  it('prints due none when no change is ready', () => {
    // Arrange
    const { store, ledger } = setup()
    writeFileSync(store, `${JSON.stringify(validSeed())}\n`)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Act
    const exitCode = main(['due'], envFor(store, ledger))
    // Assert
    expect(exitCode).toBe(0)
    expect(output.mock.calls[0][0]).toBe('due: none\n')
  })

  it('skips malformed ledger lines and reports the count in text mode', () => {
    // Arrange
    const { store, ledger } = setup()
    writeFileSync(store, `${JSON.stringify(validSeed())}\n`)
    writeFileSync(ledger, '{bad\n')
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Act
    const exitCode = main(['due'], envFor(store, ledger))
    // Assert
    expect(exitCode).toBe(0)
    expect(output.mock.calls[0][0]).toContain('skipped malformed ledger lines: 1')
  })

  it('removes a confirmed change from due and rejects repeat verdicts', () => {
    // Arrange
    const { store, ledger } = setup()
    writeFileSync(store, `${JSON.stringify(validSeed())}\n`)
    const env = envFor(store, ledger)
    const beforeUnknown = readFileSync(store, 'utf8')
    // Act
    const firstExit = main(['verdict', '--id', 'HC-1', '--result', 'confirmed', '--note', 'observed'], env)
    const afterFirst = readFileSync(store, 'utf8')
    const unknownExit = main(['verdict', '--id', 'HC-9', '--result', 'confirmed', '--note', 'nope'], env)
    const repeatExit = main(['verdict', '--id', 'HC-1', '--result', 'confirmed', '--note', 'again'], env)
    // Assert
    expect(firstExit).toBe(0)
    expect(afterFirst).not.toBe(beforeUnknown)
    expect(unknownExit).toBe(2)
    expect(repeatExit).toBe(2)
    expect(readFileSync(store, 'utf8')).toBe(afterFirst)
  })

  it('rejects malformed stores for due and add', () => {
    // Arrange
    const { store, ledger } = setup()
    writeFileSync(store, '{bad\n')
    const env = envFor(store, ledger)
    const before = readFileSync(store, 'utf8')
    // Act
    const dueExit = main(['due'], env)
    const addExit = main(addArgs(), env)
    // Assert
    expect(dueExit).toBe(2)
    expect(addExit).toBe(2)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('rejects invalid timestamps in change and verdict records', () => {
    // Arrange
    const { store, ledger } = setup()
    const invalid = { ...validSeed(), ts: '2026-01-01' }
    writeFileSync(store, `${JSON.stringify(invalid)}\n`)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Act
    const dueExit = main(['due'], envFor(store, ledger))
    const addExit = main(addArgs(), envFor(store, ledger))

    // Assert
    expect(dueExit).toBe(2)
    expect(addExit).toBe(2)
    expect(error.mock.calls).toEqual([
      ['malformed harness changes store\n'],
      ['malformed harness changes store\n'],
    ])

    // Arrange
    writeFileSync(store, `${JSON.stringify(validSeed())}\n${JSON.stringify({ schemaVersion: 1, kind: 'verdict', id: 'HC-1', ts: '2026-01-01', result: 'confirmed', note: 'observed' })}\n`)

    // Act
    const verdictExit = main(['verdict', '--id', 'HC-1', '--result', 'confirmed', '--note', 'again'], envFor(store, ledger))

    // Assert
    expect(verdictExit).toBe(2)
  })

  it('rejects an unreadable directory store for every command', () => {
    // Arrange
    const { store, ledger } = setup()
    mkdirSync(store)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const env = envFor(store, ledger)

    // Act
    const dueExit = main(['due'], env)
    const addExit = main(addArgs(), env)
    const verdictExit = main(['verdict', '--id', 'HC-1', '--result', 'confirmed', '--note', 'observed'], env)

    // Assert
    expect(dueExit).toBe(2)
    expect(addExit).toBe(2)
    expect(verdictExit).toBe(2)
    expect(error.mock.calls).toHaveLength(3)
    expect(error.mock.calls.every(([line]) => typeof line === 'string' && line.endsWith('\n'))).toBe(true)
  })

  it('sorts due changes by numeric id order', () => {
    // Arrange
    const { store, ledger } = setup()
    const first = { ...validSeed(), id: 'HC-10', title: 'Ten', ts: '2026-01-01T00:00:00.000Z', afterRuns: 1 }
    const second = { ...validSeed(), id: 'HC-2', title: 'Two', ts: '2026-01-01T00:00:00.000Z', afterRuns: 1 }
    writeFileSync(store, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    appendLine(record('2026-01-02T00:00:00.000Z', 1), ledger)
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Act
    const exitCode = main(['due', '--json'], envFor(store, ledger))
    const result = JSON.parse(String(output.mock.calls[0][0]))
    // Assert
    expect(exitCode).toBe(0)
    expect(result.map((item: { id: string }) => item.id)).toEqual(['HC-2', 'HC-10'])
  })
})
