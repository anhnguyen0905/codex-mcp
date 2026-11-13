import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  STATE_KEYS,
  OPTIONAL_STATE_KEYS,
  PHASES,
  TASK_TRANSITIONS,
  TransitionRejectedError,
  advanceState,
  approveState,
  checkState,
  improvementGateState,
  main,
  parseState,
  planDriftState,
  requirementDeltaState,
  resumeState,
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
    const requiredKeys = STATE_KEYS.filter((key) => !OPTIONAL_STATE_KEYS.includes(key))
    expect(parsedKeys).toEqual(requiredKeys)
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

  test.each(['interview', 'plan', 'backlog', 'review', 'complete'])(
    'reports a non-idle task stage outside execution in %s',
    (phase) => {
      // Arrange
      const state = stateWithSelectors({ phase, currentTask: 'T1', taskStage: 'executing', wave: '1' })

      // Act
      const violations = checkState(state)

      // Assert
      expect(violations).toContainEqual({
        key: 'taskStage',
        reason: 'non-idle taskStage requires phase execution',
      })
    },
  )

  test('does not report a phase selector violation during execution', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'execution', currentTask: 'T1', taskStage: 'executing', wave: '1',
    })

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations).not.toContainEqual({
      key: 'taskStage',
      reason: 'non-idle taskStage requires phase execution',
    })
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

function stateAtPhase(phase: string, approvals = true): string {
  const approval = approvals ? 'yes (today)' : 'no'
  return stateWithSelectors({
    phase,
    currentTask: '-',
    taskStage: 'idle',
    wave: '-',
  })
    .replaceAll('- requirementsApproved: yes (today)', `- requirementsApproved: ${approval}`)
    .replaceAll('- planApproved: yes (today)', `- planApproved: ${approval}`)
    .replaceAll('- backlogApproved: yes (today)', `- backlogApproved: ${approval}`)
}

function writeApprovalArtifacts(directory: string): void {
  writeFileSync(join(directory, 'REQUIREMENTS.md'), '# requirements\n')
  writeFileSync(join(directory, 'PLAN.md'), '# plan\n')
  writeFileSync(join(directory, 'TASKS.md'), tasksWithStatuses({ T1: 'done' }))
}

const APPROVAL_LEGAL_CASES = new Set([
  'requirements:interview:false',
  'requirements:plan:true',
  'plan:plan:false',
  'backlog:backlog:false',
])
const APPROVAL_CASES = ['requirements', 'plan', 'backlog'].flatMap((gate) =>
  PHASES.flatMap((phase) => [false, true].map((delta) => [gate, phase, delta])),
)

describe('typed flow transitions', () => {
  test.each(APPROVAL_CASES)('approves %s only from its legal phase', (gate, phase, delta) => {
    // Arrange
    const state = stateAtPhase(phase)
    const legal = APPROVAL_LEGAL_CASES.has(`${gate}:${phase}:${delta}`)

    // Act
    const update = () => approveState(state, gate, { at: AT, delta })

    // Assert
    if (legal) {
      const expected = delta ? `yes (delta ${AT.slice(0, 10)})` : `yes (${AT})`
      expect(update()).toContain(expected)
    } else {
      expect(update).toThrow(TransitionRejectedError)
    }
  })

  test.each([
    ['interview', 'plan'],
    ['plan', 'backlog'],
    ['backlog', 'execution'],
    ['execution', 'review'],
    ['review', 'complete'],
  ])('advances exactly one step from %s', (phase, next) => {
    // Arrange
    const state = stateAtPhase(phase)
    const tasksText = tasksWithStatuses({ T1: 'done' })

    // Act
    const updated = advanceState(state, { tasksText })

    // Assert
    expect(parseState(updated).phase).toBe(next)
  })

  test.each(PHASES.filter((phase) => phase !== 'complete'))(
    'rejects advance from %s when its guard is not satisfied',
    (phase) => {
      // Arrange
      const state = stateAtPhase(phase, false)

      // Act / Assert
      expect(() => advanceState(state, { tasksText: tasksWithStatuses({ T1: 'pending' }) }))
        .toThrow(TransitionRejectedError)
    },
  )

  test('rejects every non-linear transition outside its legal source phases', () => {
    // Arrange
    const transitions = [
      { run: requirementDeltaState, legal: ['plan', 'backlog', 'execution', 'review'] },
      { run: planDriftState, legal: ['execution', 'review'] },
      { run: improvementGateState, legal: ['execution', 'review'] },
    ] as const

    // Act / Assert
    for (const transition of transitions) {
      for (const phase of PHASES) {
        const state = stateAtPhase(phase)
        if (transition.legal.includes(phase)) {
          expect(transition.run(state, { at: AT })).toBeTypeOf('string')
        } else {
          expect(() => transition.run(state, { at: AT })).toThrow(TransitionRejectedError)
        }
      }
    }
  })

  test.each([
    ['requirement-delta', requirementDeltaState, 'plan'],
    ['plan-drift', planDriftState, 'execution'],
    ['improvement-gate', improvementGateState, 'execution'],
  ])('resets selectors for %s', (_, transition, phase) => {
    // Arrange
    const state = stateWithSelectors({
      phase, currentTask: 'T2', taskStage: 'reviewing', wave: '1',
    })

    // Act
    const updated = transition(state, { at: AT })

    // Assert
    expect(parseState(updated)).toMatchObject({ currentTask: '-', taskStage: 'idle', wave: '-' })
  })

  test('pure transition functions reject an illegal phase without changing selectors', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'interview', currentTask: 'T2', taskStage: 'reviewing', wave: '1',
    })

    // Act / Assert
    expect(() => requirementDeltaState(state, { at: AT })).toThrow(TransitionRejectedError)
    expect(state).toContain('- currentTask: T2\n- taskStage: reviewing\n- wave: 1\n')
  })

  test.each(['requirement-delta', 'plan-drift', 'improvement-gate'])(
    'CLI rejects %s from an illegal phase without writing STATE.md',
    async (command) => {
      // Arrange
      const directory = makeTempDirectory('flow-state-cli-transition-')
      const statePath = join(directory, 'STATE.md')
      const state = stateWithSelectors({
        phase: 'interview', currentTask: 'T2', taskStage: 'reviewing', wave: '1',
      })
      writeFileSync(statePath, state)

      // Act
      const update = main([command, '--at', AT, '--state', statePath], { cwd: directory })

      // Assert
      await expect(update).resolves.toBe(1)
      expect(readFileSync(statePath, 'utf8')).toBe(state)
    },
  )

  test('resume writes a head and never moves forward', () => {
    // Arrange
    const state = stateAtPhase('backlog')

    // Act
    const updated = resumeState(state, 'deadbeef', { phase: 'plan' })

    // Assert
    expect(parseState(updated)).toMatchObject({ phase: 'plan', resumeHead: 'deadbeef' })
    expect(() => resumeState(state, 'deadbeef', { phase: 'execution' }))
      .toThrow(TransitionRejectedError)
  })

  test('resume preserves selectors in execution and resets them for an earlier phase', () => {
    // Arrange
    const state = stateWithSelectors({
      phase: 'execution', currentTask: 'T2', taskStage: 'reviewing', wave: '1',
    })

    // Act
    const staying = resumeState(state, 'stay')
    const earlier = resumeState(state, 'rewind', { phase: 'backlog' })

    // Assert
    expect(parseState(staying)).toMatchObject({
      resumeHead: 'stay', currentTask: 'T2', taskStage: 'reviewing', wave: '1',
    })
    expect(parseState(earlier)).toMatchObject({
      resumeHead: 'rewind', phase: 'backlog', currentTask: '-', taskStage: 'idle', wave: '-',
    })
  })

  test('uses calendar dates for delta and gate markers', () => {
    // Arrange
    const date = '2026-11-10'
    const interview = stateAtPhase('interview')
    const plan = stateAtPhase('plan')
    const execution = stateAtPhase('execution')

    // Act
    const approved = approveState(plan, 'requirements', { at: date, delta: true })
    const delta = requirementDeltaState(plan, { at: date })
    const drift = planDriftState(execution, { at: date })
    const improvement = improvementGateState(execution, { at: date })

    // Assert
    expect(parseState(approved).requirementsApproved).toBe('yes (delta 2026-11-10)')
    expect(parseState(delta).requirementsApproved).toBe('yes (delta 2026-11-10)')
    expect(parseState(drift).backlogApproved).toBe('no (plan drift 2026-11-10)')
    expect(parseState(improvement).backlogApproved).toBe('no (improvement tasks 2026-11-10)')
    expect(parseState(approveState(interview, 'requirements')).requirementsApproved)
      .toMatch(/^yes \(\d{4}-\d{2}-\d{2}T/)
    expect(parseState(requirementDeltaState(plan)).requirementsApproved)
      .toMatch(/^yes \(delta \d{4}-\d{2}-\d{2}\)$/)
    expect(() => requirementDeltaState(plan, { at: '2026-02-30' })).toThrow(
      'invalid ISO 8601 timestamp',
    )
  })

  test('cannot reach complete from interview in one command', () => {
    // Arrange
    const state = stateAtPhase('interview')
    const tasksText = tasksWithStatuses({ T1: 'done' })

    // Act / Assert
    expect(parseState(advanceState(state, { tasksText })).phase).toBe('plan')
    expect(() => resumeState(state, 'deadbeef', { phase: 'complete' }))
      .toThrow(TransitionRejectedError)
  })
})

describe('approval-aware checks', () => {
  test.each([
    ['plan', 'no', 'no', 'no'],
    ['backlog', 'yes', 'no', 'no'],
    ['execution', 'yes', 'yes', 'no'],
  ])('flags phase %s when its approval is missing', (phase, requirements, plan, backlog) => {
    // Arrange
    const state = stateAtPhase(phase)
      .replace('- requirementsApproved: yes (today)', `- requirementsApproved: ${requirements}`)
      .replace('- planApproved: yes (today)', `- planApproved: ${plan}`)
      .replace('- backlogApproved: yes (today)', `- backlogApproved: ${backlog}`)

    // Act
    const violations = checkState(state)

    // Assert
    expect(violations.some(({ key }) => key === 'requirementsApproved')).toBe(requirements !== 'yes')
    expect(violations.some(({ key }) => key === 'planApproved')).toBe(
      phase !== 'plan' && plan !== 'yes',
    )
    expect(violations.some(({ key }) => key === 'backlogApproved')).toBe(
      phase === 'execution' && backlog !== 'yes',
    )
  })

  test('accepts the two in-transaction approval states', () => {
    // Arrange
    const planState = stateAtPhase('plan', false)
      .replace('- requirementsApproved: no', '- requirementsApproved: yes (delta today)')
    const backlogState = stateAtPhase('backlog', false)
      .replace('- requirementsApproved: no', '- requirementsApproved: yes (today)')
      .replace('- planApproved: no', '- planApproved: yes (today)')

    // Act / Assert
    expect(checkState(planState)).toEqual([])
    expect(checkState(backlogState)).toEqual([])
  })
})

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

  test('orders violations per-key first, then relational selector, then tasks', () => {
    // Arrange — one violation of each category at once: an invalid `wave` (per-key), a selected
    // task pinned to the idle stage (selector), and a non-terminal task under a complete phase.
    const state = stateWithSelectors({
      phase: 'complete',
      currentTask: 'T1',
      taskStage: 'idle',
      wave: 'later',
    })
    const tasksText = tasksWithStatuses({ T1: 'in-progress' })

    // Act
    const violations = checkState(state, { tasksText })

    // Assert — `wave` precedes `taskStage` only because per-key checks run before relational ones.
    expect(violations).toEqual([
      { key: 'wave', reason: 'must be a positive integer or -' },
      { key: 'taskStage', reason: 'currentTask T1 cannot be idle' },
      { key: 'tasks', reason: 'phase complete requires T1 status done or failed (was in-progress)' },
    ])
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
  test.each([
    ['phase', 'plan', 'advance or a typed transition command'],
    ['requirementsApproved', 'yes', 'approve requirements or requirement-delta'],
    ['planApproved', 'yes', 'approve plan or requirement-delta'],
    ['backlogApproved', 'yes', 'approve backlog, plan-drift, or improvement-gate'],
  ])('rejects direct transition key %s without changing bytes', async (key, value, message) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-typed-set-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)
    const before = readFileSync(statePath, 'utf8')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Act
    const exitCode = await main(['set', key, value, '--state', statePath], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(stderr.mock.calls[0]?.[0]).toContain(`flow-state: rejected: ${key} is controlled by ${message}`)
    expect(readFileSync(statePath, 'utf8')).toBe(before)
    stderr.mockRestore()
  })

  test('initializes exactly the canonical 19-key state and refuses overwrite', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-init-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')

    // Act
    expect(await main([
      'init', '--baseline', 'abc123', '--known-red', 'none', '--dirty-baseline', 'clean',
    ], { cwd: directory })).toBe(0)
    expect(await main(['check'], { cwd: directory })).toBe(0)
    const state = readFileSync(statePath, 'utf8')
    const secondInit = await main([
      'init', '--baseline', 'other', '--known-red', 'other',
    ], { cwd: directory })

    // Assert
    expect(state).toBe([
      '# codex-flow run state',
      '',
      '## Run state',
      '- phase: interview',
      '- requirementsApproved: no',
      '- planApproved: no',
      '- backlogApproved: no',
      '- runBaselineRef: abc123',
      '- resumeHead:',
      '- knownRed: none',
      '- checkpointCommits:',
      '- executionMode: undecided',
      '- dirtyBaseline: clean',
      '- executor: codex',
      '- currentTask: -',
      '- taskStage: idle',
      '- wave: -',
      '- profile: -',
      '- profileMode: off',
      '- evidenceMode: off',
      '- languageMode: off',
      '- runLanguage: -',
      '',
    ].join('\n'))
    expect(Object.keys(parseState(state))).toEqual(STATE_KEYS)
    expect(secondInit).toBe(1)
    expect(readFileSync(statePath, 'utf8')).toBe(state)
  })

  test('initializes optional profile and switch values from flags', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-profile-init-')
    mkdirSync(join(directory, '.codex-flow'))

    // Act
    const exitCode = await main([
      'init', '--baseline', 'base', '--known-red', 'none', '--profile', 'data', '--profile-mode', 'shadow',
      '--evidence-mode', 'enforce', '--language-mode', 'on', '--run-language', 'vi',
    ], { cwd: directory })

    // Assert
    expect(exitCode).toBe(0)
    expect(parseState(readFileSync(join(directory, '.codex-flow/STATE.md'), 'utf8'))).toMatchObject({
      profile: 'data', profileMode: 'shadow', evidenceMode: 'enforce', languageMode: 'on', runLanguage: 'vi',
    })
  })

  test.each([
    ['profile', 'invalid'],
    ['profile-mode', 'invalid'],
    ['evidence-mode', 'invalid'],
    ['language-mode', 'invalid'],
    ['run-language', 'invalid'],
  ])('rejects invalid %s during init without writing', async (flag, value) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-profile-invalid-init-')
    mkdirSync(join(directory, '.codex-flow'))
    const statePath = join(directory, '.codex-flow/STATE.md')

    // Act
    const exitCode = await main([
      'init', '--baseline', 'base', '--known-red', 'none', `--${flag}`, value,
    ], { cwd: directory })

    // Assert
    expect(exitCode).toBe(2)
    expect(() => readFileSync(statePath, 'utf8')).toThrow()
  })

  test('allows legacy state without optional keys and rejects invalid present values', () => {
    // Arrange
    const invalid = `${LEGACY_STATE}- profile: invalid\n`

    // Act / Assert
    expect(checkState(stateWithSelectors({ currentTask: '-', taskStage: 'idle', wave: '-' }))).toEqual([])
    expect(checkState(invalid)).toContainEqual({
      key: 'profile', reason: 'must be one of code|data|design|plan|content|mixed|-',
    })
  })

  test('preserves optional profile keys across resume and non-linear gates', () => {
    // Arrange
    const optional = [
      '', '- profile: data', '- profileMode: shadow', '- evidenceMode: enforce', '- languageMode: on',
      '- runLanguage: vi',
    ].join('\n')
    const execution = `${stateAtPhase('execution')}${optional}`
    const expected = {
      profile: 'data', profileMode: 'shadow', evidenceMode: 'enforce', languageMode: 'on', runLanguage: 'vi',
    }

    // Act
    const states = [
      resumeState(execution, 'head'),
      requirementDeltaState(execution, { at: AT }),
      planDriftState(execution, { at: AT }),
      improvementGateState(execution, { at: AT }),
    ]

    // Assert
    for (const state of states) expect(parseState(state)).toMatchObject(expected)
  })

  test.each([
    ['profile', 'invalid'],
    ['profileMode', 'invalid'],
    ['evidenceMode', 'invalid'],
    ['languageMode', 'invalid'],
    ['runLanguage', 'invalid'],
  ])('rejects invalid optional %s values on set', async (key, value) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-profile-set-')
    const statePath = join(directory, 'STATE.md')
    writeFileSync(statePath, LEGACY_STATE)

    // Act
    const update = main(['set', key, value, '--state', statePath], { cwd: directory })

    // Assert
    await expect(update).rejects.toThrow(`invalid ${key} value`)
    expect(readFileSync(statePath, 'utf8')).toBe(LEGACY_STATE)
  })

  test.each([
    ['requirements', 'interview', 'REQUIREMENTS.md'],
    ['plan', 'plan', 'PLAN.md'],
    ['backlog', 'backlog', 'TASKS.md'],
  ])('requires the %s artifact before approval', async (gate, phase, artifact) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-artifact-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase(phase))
    writeFileSync(join(controlDirectory, 'OTHER.md'), '')
    const before = readFileSync(statePath, 'utf8')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // Act
    const exitCode = await main(['approve', gate, '--at', AT], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(stderr.mock.calls[0]?.[0]).toContain(`requires ${artifact}`)
    expect(readFileSync(statePath, 'utf8')).toBe(before)
    stderr.mockRestore()
  })

  test.skipIf(process.platform === 'win32').each([
    ['directory', (artifact: string, directory: string) => mkdirSync(join(directory, artifact))],
    ['symlink', (artifact: string, directory: string) => {
      const target = join(directory, 'target.md')
      writeFileSync(target, '# target\n')
      symlinkSync(target, join(directory, artifact))
    }],
  ])('rejects an artifact that is a %s', async (_, createArtifact) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-artifact-type-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase('interview'))
    createArtifact('REQUIREMENTS.md', controlDirectory)
    const before = readFileSync(statePath, 'utf8')
    // Act
    const exitCode = await main(['approve', 'requirements', '--at', AT], { cwd: directory })
    // Assert
    expect(exitCode).toBe(1)
    expect(readFileSync(statePath, 'utf8')).toBe(before)
  })

  test('requires earlier approvals before later approvals', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-earlier-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    writeApprovalArtifacts(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase('plan', false))
    const before = readFileSync(statePath, 'utf8')

    // Act
    const exitCode = await main(['approve', 'plan', '--at', AT], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(readFileSync(statePath, 'utf8')).toBe(before)
  })

  test('rejects checkpoint options on non-backlog approvals', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-approval-options-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    writeApprovalArtifacts(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase('interview'))
    const before = readFileSync(statePath, 'utf8')

    // Act
    const rejected = main([
      'approve', 'requirements', '--checkpoint-commits', 'yes', '--at', AT,
    ], { cwd: directory })

    // Assert
    await expect(rejected).rejects.toThrow(
      '--checkpoint-commits and --execution-mode are only valid for approve backlog',
    )
    expect(readFileSync(statePath, 'utf8')).toBe(before)
  })

  test.each([
    ['taskStage', 'executing', 'execution'],
    ['currentTask', 'T1', 'execution'],
  ])('advance rejects execution with selected %s', async (key, value, phase) => {
    // Arrange
    const directory = makeTempDirectory('flow-state-advance-guard-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    writeApprovalArtifacts(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase(phase))
    expect(await main(['set', key, value], { cwd: directory })).toBe(0)
    const before = readFileSync(statePath, 'utf8')

    // Act
    const exitCode = await main(['advance'], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(readFileSync(statePath, 'utf8')).toBe(before)
  })

  test('set accepts non-idle task stages only in execution', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-task-stage-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase('plan'))

    // Act
    const exitCode = await main(['set', 'taskStage', 'launching'], { cwd: directory })

    // Assert
    expect(exitCode).toBe(1)
    expect(parseState(readFileSync(statePath, 'utf8')).taskStage).toBe('idle')
  })

  test('runs the five non-linear transactions through the CLI', async () => {
    // Arrange
    const directory = makeTempDirectory('flow-state-transactions-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    writeApprovalArtifacts(controlDirectory)
    const command = (args: string[]) => main(args, { cwd: directory })
    const runOk = async (args: string[]) => expect(await command(args)).toBe(0)
    await runOk(['init', '--baseline', 'abc123', '--known-red', 'none'])
    await runOk(['approve', 'requirements', '--at', AT])
    await runOk(['advance'])
    await runOk(['approve', 'plan', '--at', AT])
    await runOk(['advance'])
    await runOk(['approve', 'backlog', '--at', AT, '--checkpoint-commits', 'yes', '--execution-mode', 'parallel'])
    await runOk(['advance'])
    const statePath = join(controlDirectory, 'STATE.md')
    expect(parseState(readFileSync(statePath, 'utf8'))).toMatchObject({
      checkpointCommits: 'yes',
      executionMode: 'parallel',
    })

    // Act: requirements delta, plan drift, improvement gate, resume, archive + init.
    await runOk(['requirement-delta', '--at', AT])
    expect(parseState(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'plan',
      requirementsApproved: `yes (delta ${AT.slice(0, 10)})`,
      planApproved: `no (delta ${AT.slice(0, 10)})`,
      backlogApproved: `no (delta ${AT.slice(0, 10)})`,
    })
    await runOk(['approve', 'plan', '--at', AT])
    await runOk(['advance'])
    await runOk(['approve', 'backlog', '--at', AT])
    await runOk(['advance'])
    expect(parseState(readFileSync(statePath, 'utf8')).phase).toBe('execution')
    await runOk(['set', 'currentTask', 'T2'])
    await runOk(['set', 'taskStage', 'reviewing'])
    await runOk(['set', 'wave', '1'])
    await runOk(['plan-drift', '--at', AT])
    expect(parseState(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'backlog',
      backlogApproved: `no (plan drift ${AT.slice(0, 10)})`,
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })
    await runOk(['approve', 'backlog', '--at', AT])
    await runOk(['advance'])
    await runOk(['advance'])
    expect(parseState(readFileSync(statePath, 'utf8')).phase).toBe('review')
    await runOk(['improvement-gate', '--at', AT])
    expect(parseState(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'backlog',
      backlogApproved: `no (improvement tasks ${AT.slice(0, 10)})`,
    })
    await runOk(['approve', 'backlog', '--at', AT])
    await runOk(['advance'])
    await runOk(['advance'])
    expect(parseState(readFileSync(statePath, 'utf8')).phase).toBe('review')
    await runOk(['resume', '--head', 'deadbeef', '--phase', 'backlog'])
    expect(parseState(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'backlog',
      resumeHead: 'deadbeef',
      requirementsApproved: `yes (delta ${AT.slice(0, 10)})`,
      planApproved: `yes (${AT})`,
      backlogApproved: `yes (${AT})`,
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })
    await runOk(['approve', 'backlog', '--at', AT])
    await runOk(['advance'])
    await runOk(['advance'])
    expect(parseState(readFileSync(statePath, 'utf8')).phase).toBe('review')
    const archivedState = readFileSync(statePath, 'utf8')
    renameSync(statePath, join(controlDirectory, 'STATE.archive.md'))
    renameSync(join(controlDirectory, 'EVENTS.jsonl'), join(controlDirectory, 'EVENTS.archive.jsonl'))
    await runOk(['init', '--baseline', 'newbase', '--known-red', 'none'])

    // Assert
    const freshState = readFileSync(statePath, 'utf8')
    expect(parseState(freshState)).toMatchObject({
      phase: 'interview',
      requirementsApproved: 'no',
      planApproved: 'no',
      backlogApproved: 'no',
      currentTask: '-',
      taskStage: 'idle',
      wave: '-',
    })
    expect(Object.keys(parseState(freshState))).toEqual(STATE_KEYS)
    expect(readFileSync(join(controlDirectory, 'STATE.archive.md'), 'utf8')).toBe(archivedState)
  })

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
    const update = main(['set', 'knownRed', 'updated', '--state', statePath], { cwd: directory })

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

  test('injects a failing state writer and leaves an abort event', async () => {
    const directory = makeTempDirectory('flow-state-journal-crash-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    await main(['init', '--baseline', 'base', '--known-red', 'none'], { cwd: directory })
    writeFileSync(join(controlDirectory, 'REQUIREMENTS.md'), '# requirements\n')
    const statePath = join(controlDirectory, 'STATE.md')
    await expect(main(['approve', 'requirements'], {
      cwd: directory,
      writeState: async () => { throw new Error('injected writer failure') },
    })).rejects.toThrow('injected writer failure')
    const journal = readFileSync(join(controlDirectory, 'EVENTS.jsonl'), 'utf8')
    expect(journal).toContain('"status":"abort"')
    expect(readFileSync(statePath, 'utf8')).toContain('- phase: interview')
  })

  test('legacy state transitions without creating a journal', async () => {
    const directory = makeTempDirectory('flow-state-legacy-journal-')
    const controlDirectory = join(directory, '.codex-flow')
    mkdirSync(controlDirectory)
    const statePath = join(controlDirectory, 'STATE.md')
    writeFileSync(statePath, stateAtPhase('execution'))
    expect(await main(['resume', '--head', 'legacy'], { cwd: directory })).toBe(0)
    expect(readdirSync(controlDirectory)).toEqual(['STATE.md'])
    expect(await main(['check', '--state', statePath], { cwd: directory })).toBe(0)
  })
})
