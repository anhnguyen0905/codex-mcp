import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { mergeLessons, normalizeLesson, parseLessonLines, prunePlaybook, renderPlaybook, readPlaybook } from '../scripts/playbook.mjs'

const item = (id: string, text: string, count: number, lastSeen: string, status = 'active') => ({ schemaVersion: 1, id, cause: 'context-missing', text, key: normalizeLesson(text), count, firstSeen: lastSeen, lastSeen, runs: ['r1'], status })
const dir = () => mkdtempSync(join(tmpdir(), 'playbook-'))
const runCli = (args: string[]) => spawnSync(process.execPath, ['scripts/playbook.mjs', ...args], { encoding: 'utf8' })

describe('playbook', () => {
  it('normalizes punctuation whitespace case and diacritics', () => {
    // Arrange
    const lesson = '  Đọc PROJECT.md, trước   khi lập kế hoạch! '
    // Act
    const result = normalizeLesson(lesson)
    // Assert
    expect(result).toBe('đọc projectmd trước khi lập kế hoạch')
  })

  it('normalizes Turkish dotted I with the locale-independent lowercase rule', () => {
    // Arrange
    const lesson = 'İNFRA'
    // Act
    const result = normalizeLesson(lesson)
    // Assert
    expect(result).toBe('i̇nfra')
  })

  it('parses valid lessons and ignores blank lines', () => {
    // Arrange
    const input = '\ncontext-missing | Đọc PROJECT.md trước khi lập kế hoạch\n'
    // Act
    const result = parseLessonLines(input)
    // Assert
    expect(result).toHaveLength(1)
  })

  it('rejects malformed lessons', () => {
    // Arrange
    const input = 'bad-cause | invented lesson'
    // Act
    const act = () => parseLessonLines(input)
    // Assert
    expect(act).toThrow()
  })

  it('adds new lessons and deduplicates normalized lessons', () => {
    // Arrange
    const lessons = parseLessonLines('context-missing | Read PROJECT.md!\ncontext-missing | read projectmd')
    // Act
    const result = mergeLessons([], lessons, { runId: 'run-1', at: '2026-01-01T00:00:00Z' })
    // Assert
    expect(result).toHaveLength(1)
  })

  it('creates exact records and continues ids from the maximum', () => {
    // Arrange
    const at = '2026-01-01T00:00:00Z'
    const lessons = parseLessonLines('infra | Retry the connection\nskill-gap | Read the guide')
    // Act
    const result = mergeLessons([item('PB-7', 'existing', 1, at)], lessons, { runId: 'run-1', at })
    // Assert
    expect(result[1]).toEqual({ schemaVersion: 1, id: 'PB-8', cause: 'infra', text: 'Retry the connection', key: 'retry the connection', count: 1, firstSeen: at, lastSeen: at, runs: ['run-1'], status: 'active' })
    expect(result[2].id).toBe('PB-9')
  })

  it('increments a matching lesson for a new run and preserves firstSeen', () => {
    // Arrange
    const first = mergeLessons([], parseLessonLines('infra | Retry the connection'), { runId: 'run-1', at: '2026-01-01T00:00:00Z' })
    // Act
    const result = mergeLessons(first, parseLessonLines('infra | RETRY the connection!'), { runId: 'run-2', at: '2026-01-02T00:00:00Z' })
    // Assert
    expect(result[0]).toMatchObject({ count: 2, firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-02T00:00:00Z', runs: ['run-1', 'run-2'] })
    expect(result).toHaveLength(1)
  })

  it('does not mutate inputs during merge or prune', () => {
    // Arrange
    const items = [item('PB-1', 'first', 2, '2026-01-01T00:00:00Z'), item('PB-2', 'second', 1, '2026-01-01T00:00:00Z')]
    const original = structuredClone(items)
    // Act
    mergeLessons(items, parseLessonLines('infra | third'), { runId: 'run-2', at: '2026-01-02T00:00:00Z' })
    prunePlaybook(items, 1)
    // Assert
    expect(items).toEqual(original)
  })

  it('does not change a lesson when merging the same run twice', () => {
    // Arrange
    const lessons = parseLessonLines('infra | Retry the connection')
    const first = mergeLessons([], lessons, { runId: 'run-1', at: '2026-01-01T00:00:00Z' })
    // Act
    const second = mergeLessons(first, lessons, { runId: 'run-1', at: '2026-01-02T00:00:00Z' })
    // Assert
    expect(second[0]).toEqual(first[0])
  })

  it('renders active lessons in deterministic order and applies a token cap', () => {
    // Arrange
    const items = [item('PB-2', 'less common', 1, '2026-01-01T00:00:00Z'), item('PB-1', 'most common', 3, '2026-01-01T00:00:00Z'), item('PB-3', 'retired', 9, '2026-01-03T00:00:00Z', 'retired')]
    // Act
    const result = renderPlaybook(items, 12)
    // Assert
    expect(result).toBe('- [PB-1] (context-missing, ×3) most common')
  })

  it('uses lastSeen and then numeric id as render tiebreakers', () => {
    // Arrange
    const items = [item('PB-10', 'older', 1, '2026-01-01T00:00:00Z'), item('PB-2', 'newer', 1, '2026-01-02T00:00:00Z'), item('PB-3', 'same time lower id', 1, '2026-01-02T00:00:00Z')]
    // Act
    const result = renderPlaybook(items)
    // Assert
    expect(result.split('\n').map((line) => line.match(/\[PB-(\d+)\]/)?.[1])).toEqual(['2', '3', '10'])
  })

  it('prunes active lessons without deleting them', () => {
    // Arrange
    const items = [item('PB-1', 'first', 2, '2026-01-01T00:00:00Z'), item('PB-2', 'second', 1, '2026-01-01T00:00:00Z')]
    // Act
    const result = prunePlaybook(items, 1)
    // Assert
    expect(result.map(({ id, status }) => [id, status])).toEqual([['PB-1', 'active'], ['PB-2', 'retired']])
  })

  it('returns an empty list for a missing file', async () => {
    // Arrange
    const file = join(dir(), 'missing.jsonl')
    // Act
    const result = await readPlaybook(file)
    // Assert
    expect(result).toEqual([])
  })

  it('cli rejects invalid input without changing the file', () => {
    // Arrange
    const directory = dir()
    const source = join(directory, 'lessons.txt')
    const file = join(directory, 'playbook.jsonl')
    writeFileSync(source, 'not-a-cause | bad lesson\n')
    writeFileSync(file, 'original\n')
    // Act
    const result = runCli(['merge', '--run', 'r1', '--from', source, '--file', file])
    // Assert
    expect(result.status).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('original\n')
  })

  it('cli merges renders and prunes lessons through a file override', () => {
    // Arrange
    const directory = dir()
    const source = join(directory, 'lessons.txt')
    const file = join(directory, 'playbook.jsonl')
    writeFileSync(source, 'infra | Retry the connection\ncontext-missing | Đọc PROJECT.md trước khi lập kế hoạch\n')
    const at = '2026-01-01T00:00:00Z'
    // Act
    const first = runCli(['merge', '--run', 'r1', '--from', source, '--at', at, '--file', file])
    const second = runCli(['merge', '--run', 'r2', '--from', source, '--at', '2026-01-02T00:00:00Z', '--file', file])
    const render = runCli(['render', '--file', file])
    const prune = runCli(['prune', '--keep', '1', '--file', file])
    const records = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // Assert
    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(render.status).toBe(0)
    expect(render.stdout.startsWith('- [PB-1] (infra, ×2) Retry the connection')).toBe(true)
    expect(prune.status).toBe(0)
    expect(records.filter(({ status }) => status === 'active')).toHaveLength(1)
    expect(records.filter(({ status }) => status === 'retired')).toHaveLength(1)
  })

  it('cli rejects malformed playbook files without changing them', () => {
    // Arrange
    const file = join(dir(), 'playbook.jsonl')
    const before = '{"broken":true}\nnot-json\n'
    writeFileSync(file, before)
    // Act
    const render = runCli(['render', '--file', file])
    const merge = runCli(['merge', '--run', 'r1', '--from', file, '--file', file])
    // Assert
    expect(render.status).toBe(2)
    expect(render.stderr.trim().split('\n')).toHaveLength(1)
    expect(merge.status).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('cli reports both required merge flags when from is missing', () => {
    // Arrange
    const directory = dir()
    const file = join(directory, 'playbook.jsonl')
    // Act
    const result = runCli(['merge', '--run', 'r1', '--file', file])
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('merge requires --run and --from')
  })
})
