import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  STATE_KEYS,
  TASK_TRANSITIONS,
  checkState,
  main,
  parseState,
  setStateKey,
  setTaskStatus,
} from '../scripts/flow-state.mjs'

const tempDirectories: string[] = []
const AT = '2026-09-02T12:34:56.000Z'
const LEGACY_STATE = `# codex-flow run state

## Run state
- phase: execution
- requirementsApproved: yes (today)
- planApproved: yes (today)
- backlogApproved: yes (today)
- runBaselineRef: abc123
- resumeHead:
- knownRed: none
- checkpointCommits: yes
- executionMode: parallel
- dirtyBaseline: none
- executor: codex
`

afterAll(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true })
})

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function tasksWithStatus(status: string, ending = '\n'): string {
  return [`## T1: State task`, `- Files: scripts/flow-state.mjs`, `- Status: ${status}`, ''].join(ending)
}

describe('STATE.md updates', () => {
  test('updates only the selected line and preserves CRLF bytes', () => {
    // Arrange
    const state = LEGACY_STATE.replaceAll('\n', '\r\n')

    // Act
    const updated = setStateKey(state, 'phase', 'review')

    // Assert
    expect(updated).toBe(state.replace('- phase: execution', '- phase: review'))
    expect(parseState(updated).phase).toBe('review')
  })

  test('rejects an unknown key', () => {
    // Arrange
    const state = LEGACY_STATE

    // Act / Assert
    expect(() => setStateKey(state, 'mystery', 'value')).toThrow('unknown state key mystery')
  })

  test('inserts missing legacy keys in canonical order', () => {
    // Arrange
    let state = LEGACY_STATE

    // Act
    state = setStateKey(state, 'wave', '-')
    state = setStateKey(state, 'currentTask', 'T1')
    state = setStateKey(state, 'taskStage', 'executing')

    // Assert
    const parsedKeys = [...state.matchAll(/^- ([A-Za-z]+):/gm)].map((match) => match[1])
    expect(parsedKeys).toEqual(STATE_KEYS)
    expect(state).toContain('- currentTask: T1\n- taskStage: executing\n- wave: -\n')
  })

  test('inserts a state key into an empty document without corrupting its value', () => {
    // Arrange
    const state = ''

    // Act
    const updated = setStateKey(state, 'phase', 'interview')

    // Assert
    expect(updated).toBe('- phase: interview')
  })

  test.each([
    ['phase', 'planning'],
    ['taskStage', 'running'],
    ['currentTask', 'task-1'],
    ['wave', '0'],
  ])('rejects invalid %s without writing the state file', async (key, value) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-invalid-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)

    // Act
    const update = main(['set', key, value, '--state', statePath], { cwd: directory })

    // Assert
    await expect(update).rejects.toThrow(`invalid ${key} value`)
    expect(readFileSync(statePath, 'utf8')).toBe(LEGACY_STATE)
  })

  test.each([
    ['newline', 'none\n- phase: complete'],
    ['carriage return', 'none\r- phase: complete'],
  ])('rejects a state value containing a %s without writing the state file', async (_, value) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-multiline-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)

    // Act
    const update = main(['set', 'knownRed', value, '--state', statePath], { cwd: directory })

    // Assert
    await expect(update).rejects.toThrow(
      `invalid knownRed value ${JSON.stringify(value)}: must be a single line`,
    )
    expect(readFileSync(statePath, 'utf8')).toBe(LEGACY_STATE)
  })

  test('lists every missing or invalid schema key', () => {
    // Arrange
    const state = LEGACY_STATE.replace('- phase: execution', '- phase: building')

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([
      { key: 'phase', reason: 'must be one of interview|plan|backlog|execution|review|complete' },
      { key: 'currentTask', reason: 'missing' },
      { key: 'taskStage', reason: 'missing' },
      { key: 'wave', reason: 'missing' },
    ])
  })

  test('returns no violations for a complete valid state', () => {
    // Arrange
    const state = [
      LEGACY_STATE.trimEnd(),
      '- currentTask: -',
      '- taskStage: idle',
      '- wave: -',
      '',
    ].join('\n')

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([])
  })
})

describe('TASKS.md transitions', () => {
  test.each([
    ['pending', 'in-progress'],
    ['in-progress', 'done'],
    ['in-progress', 'failed'],
    ['in-progress', 'pending'],
    ['failed', 'pending'],
  ])('records the legal %s to %s transition', (from, to) => {
    // Arrange
    const tasks = tasksWithStatus(from)

    // Act
    const updated = setTaskStatus(tasks, 'T1', to, { at: AT })

    // Assert
    expect(updated).toContain(`- Status: ${to}\n  - ${AT} ${from} -> ${to}\n`)
    expect(TASK_TRANSITIONS[from as keyof typeof TASK_TRANSITIONS]).toContain(to)
  })

  test('appends a transition after existing transition lines', () => {
    // Arrange
    const tasks = tasksWithStatus('in-progress').replaceAll('\n', '\r\n').replace(
      '- Status: in-progress\r\n',
      '- Status: in-progress\r\n  - 2026-09-01T10:00:00Z pending -> in-progress\r\n',
    )

    // Act
    const updated = setTaskStatus(tasks, 'T1', 'done', { at: AT })

    // Assert
    expect(updated).toContain(
      `- Status: done\r\n  - 2026-09-01T10:00:00Z pending -> in-progress\r\n  - ${AT} in-progress -> done\r\n`,
    )
  })

  test('rejects an illegal transition without changing the input', () => {
    // Arrange
    const tasks = tasksWithStatus('pending')

    // Act / Assert
    expect(() => setTaskStatus(tasks, 'T1', 'done', { at: AT })).toThrow(
      'illegal task transition T1: pending -> done',
    )
    expect(tasks).toBe(tasksWithStatus('pending'))
  })

  test('rejects an impossible ISO timestamp', () => {
    // Arrange
    const tasks = tasksWithStatus('pending')

    // Act / Assert
    expect(() => setTaskStatus(tasks, 'T1', 'in-progress', {
      at: '2026-02-30T12:00:00Z',
    })).toThrow('invalid ISO 8601 timestamp')
  })
})

describe('flow-state CLI', () => {
  test('rejects an unknown key without writing the state file', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-key-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)

    // Act
    const update = main(['set', 'mystery', 'value', '--state', statePath], { cwd: directory })

    // Assert
    await expect(update).rejects.toThrow('unknown state key mystery')
    expect(readFileSync(statePath, 'utf8')).toBe(LEGACY_STATE)
  })

  test('reports check violations one per prefixed line', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-check-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Act
    const exitCode = await main(['check', '--state', statePath], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      'flow-state: violation: currentTask: missing',
      'flow-state: violation: taskStage: missing',
      'flow-state: violation: wave: missing',
    ])
    stderr.mockRestore()
  })

  test('refuses a symlinked target and removes its sibling temp file', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-symlink-')
    const targetPath = join(directory, 'external.md')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(targetPath, LEGACY_STATE)
    symlinkSync(targetPath, statePath)

    // Act
    const update = main(['set', 'phase', 'review', '--state', statePath], { cwd: directory })

    // Assert
    await expect(update).rejects.toThrow('state file is a symlink — refusing to write through it')
    expect(readFileSync(targetPath, 'utf8')).toBe(LEGACY_STATE)
    expect(readdirSync(directory).sort()).toEqual(['STATE.md', 'external.md'])
  })

  test('writes task transitions atomically through the CLI', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-task-')
    const tasksPath = join(directory, 'TASKS.md')
    writeFileSync(tasksPath, tasksWithStatus('pending'))

    // Act
    const exitCode = await main(
      ['task', 'T1', 'in-progress', '--tasks', tasksPath, '--at', AT],
      { cwd: directory },
    )

    // Assert
    expect(exitCode).toBe(0)
    expect(readFileSync(tasksPath, 'utf8')).toContain(
      `- Status: in-progress\n  - ${AT} pending -> in-progress\n`,
    )
  })
})
