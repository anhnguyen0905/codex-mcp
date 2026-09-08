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

function stateWithSelectors(
  overrides: { phase?: string; currentTask: string; taskStage: string; wave: string },
): string {
  const phase = overrides.phase ?? 'execution'
  return [
    LEGACY_STATE.replace('- phase: execution', `- phase: ${phase}`).trimEnd(),
    `- currentTask: ${overrides.currentTask}`,
    `- taskStage: ${overrides.taskStage}`,
    `- wave: ${overrides.wave}`,
    '',
  ].join('\n')
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

function completeState(): string {
  return stateWithSelectors({
    phase: 'complete',
    currentTask: '-',
    taskStage: 'idle',
    wave: '-',
  })
}

function tasksWithStatuses(statuses: Record<string, string>): string {
  return Object.entries(statuses)
    .flatMap(([id, status]) => [`## ${id}: Task ${id}`, `- Status: ${status}`, ''])
    .join('\n')
}

describe('relational state validation', () => {
  test('reports a selected task held at the idle stage', () => {
    // Arrange
    const state = stateWithSelectors({ currentTask: 'T7', taskStage: 'idle', wave: '-' })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([
      { key: 'taskStage', reason: 'currentTask T7 cannot be idle' },
    ])
  })

  test('reports a non-idle stage with neither a task nor a wave selected', () => {
    // Arrange
    const state = stateWithSelectors({ currentTask: '-', taskStage: 'reviewing', wave: '-' })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([
      { key: 'taskStage', reason: 'non-idle taskStage requires currentTask or wave' },
    ])
  })

  test.each([
    ['parallel executing', '-', 'executing', '2'],
    ['parallel handoff', '-', 'handoff', '11'],
    ['sequential executing', 'T3', 'executing', '-'],
    ['idle with no selector', '-', 'idle', '-'],
  ])('accepts the valid %s state', (_, currentTask, taskStage, wave) => {
    // Arrange
    const state = stateWithSelectors({ currentTask, taskStage, wave })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([])
  })

  test('reports an invalid taskStage once instead of adding a relational violation', () => {
    // Arrange
    const state = stateWithSelectors({ currentTask: 'T2', taskStage: 'running', wave: '-' })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([
      { key: 'taskStage', reason: 'must be one of idle|launching|executing|reviewing|handoff|merge-conflict' },
    ])
  })

  test('reports every non-terminal task when the phase is complete', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'complete',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })
    const tasksText = tasksWithStatuses({
      T1: 'done',
      T2: 'pending',
      T3: 'failed',
      T4: 'in-progress',
    })

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([
      { key: 'tasks', reason: 'phase complete requires T2 status done or failed (was pending)' },
      { key: 'tasks', reason: 'phase complete requires T4 status done or failed (was in-progress)' },
    ])
  })

  test('accepts a complete phase whose tasks are all done or failed', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'complete',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })
    const tasksText = tasksWithStatuses({ T1: 'done', T2: 'failed' })

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([])
  })

  test('ignores non-terminal tasks while the phase is not complete', () => {
    // Arrange
    const state = stateWithSelectors({ currentTask: 'T1', taskStage: 'executing', wave: '-' })

    // Act
    const violations = checkState(state, { tasksText: tasksWithStatuses({ T1: 'in-progress' }) })

    // Assert
    expect(violations).toEqual([])
  })

  test('skips terminal-status checks for a complete phase when no tasks text is supplied', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'complete',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).toEqual([])
  })

  test('rejects a non-string tasksText', () => {
    // Arrange
    const state = stateWithSelectors({ currentTask: '-', taskStage: 'idle', wave: '-' })

    // Act / Assert
    expect(() => checkState(state, { tasksText: 42 as unknown as string })).toThrow(
      'tasksText must be a string or null',
    )
  })

  test('reports a complete-phase task section with no Status line as a tasks violation', () => {
    // Arrange
    const state = completeState()
    const tasksText = '## T1: Task T1\n- Files: a.mjs\n'

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([{ key: 'tasks', reason: 'T1 has no Status line' }])
  })

  test('reports a duplicate Status line with its actual count', () => {
    // Arrange
    const state = completeState()
    const tasksText = '## T1: Task T1\n- Status: done\n- Status: pending\n'

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([{ key: 'tasks', reason: 'T1 has 2 Status lines' }])
  })

  test('counts three Status lines in one section', () => {
    // Arrange
    const state = completeState()
    const tasksText = '## T1: Task T1\n- Status: done\n- Status: done\n- Status: done\n'

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([{ key: 'tasks', reason: 'T1 has 3 Status lines' }])
  })

  test('keeps validating later tasks after a malformed section', () => {
    // Arrange
    const state = completeState()
    const tasksText = [
      '## T1: Task T1',
      '- Files: a.mjs',
      '',
      '## T2: Task T2',
      '- Status: done',
      '- Status: pending',
      '',
      '## T3: Task T3',
      '- Status: pending',
      '',
      '## T4: Task T4',
      '- Status: done',
      '',
    ].join('\n')

    // Act
    const violations = checkState(state, { tasksText })

    // Assert
    expect(violations).toEqual([
      { key: 'tasks', reason: 'T1 has no Status line' },
      { key: 'tasks', reason: 'T2 has 2 Status lines' },
      { key: 'tasks', reason: 'phase complete requires T3 status done or failed (was pending)' },
    ])
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

  test('still throws when the task section has no Status line', () => {
    // Arrange
    const tasks = '## T1: Task T1\n- Files: a.mjs\n'

    // Act / Assert
    expect(() => setTaskStatus(tasks, 'T1', 'in-progress', { at: AT })).toThrow(
      'task T1 has no Status line',
    )
  })

  test('still throws when the task section has duplicate Status lines', () => {
    // Arrange
    const tasks = '## T1: Task T1\n- Status: pending\n- Status: pending\n'

    // Act / Assert
    expect(() => setTaskStatus(tasks, 'T1', 'in-progress', { at: AT })).toThrow(
      'task T1 has duplicate Status lines',
    )
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

  test('reports non-terminal tasks for check --tasks one per prefixed line', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-check-tasks-')
    const statePath = join(directory, 'STATE.md')
    const tasksPath = join(directory, 'TASKS.md')
    writeFileSync(statePath, stateWithSelectors({
      phase: 'complete',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    }))
    writeFileSync(tasksPath, tasksWithStatuses({ T1: 'done', T2: 'in-progress' }))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Act
    const exitCode = await main(
      ['check', '--state', statePath, '--tasks', tasksPath],
      { cwd: directory },
    )

    // Assert
    expect(exitCode).toBe(1)
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      'flow-state: violation: tasks: phase complete requires T2 status done or failed (was in-progress)',
    ])
    stderr.mockRestore()
  })

  test('passes a legacy complete STATE.md when --tasks is not given', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-check-legacy-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, stateWithSelectors({
      phase: 'complete',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    }))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Act
    const exitCode = await main(['check', '--state', statePath], { cwd: directory })

    // Assert
    expect(exitCode).toBe(0)
    expect(stderr.mock.calls).toEqual([])
    stderr.mockRestore()
  })

  test('rejects check --tasks without a value', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-check-noval-')

    // Act
    const check = main(['check', '--tasks'], { cwd: directory })

    // Assert
    await expect(check).rejects.toThrow('--tasks requires a value')
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
