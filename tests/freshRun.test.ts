import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTROL = '.codex-flow'
const AT = '2026-11-11T12:00:00Z'
const script = (name: string) => join(ROOT, 'scripts', name)
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const CHILD_TIMEOUT_MS = 20_000
const projects: string[] = []

// Every test chains real child processes; slow CI runners (Windows) need more than the 5 s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

interface Result { status: number | null, stdout: string, stderr: string }
interface Project { cwd: string, head: string }
interface ControlSnapshot { state: string, tasks: string, events: string, plan: string }

function runHelper(name: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Result {
  const result = spawnSync(process.execPath, [script(name), ...args], {
    cwd, encoding: 'utf8', env: env ?? process.env, timeout: CHILD_TIMEOUT_MS,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function flowState(cwd: string, args: string[]): Result {
  return runHelper('flow-state.mjs', args, cwd)
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function readControl(cwd: string, file: string): string {
  try {
    return readFileSync(join(cwd, CONTROL, file), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '<missing>'
    throw error
  }
}

function snapshotControl(cwd: string): ControlSnapshot {
  return {
    state: readControl(cwd, 'STATE.md'), tasks: readControl(cwd, 'TASKS.md'),
    events: readControl(cwd, 'EVENTS.jsonl'), plan: readControl(cwd, 'PLAN.md'),
  }
}

function expectOk(result: Result): void {
  expect(result.status, result.stderr).toBe(0)
}

function createProject(): Project {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-flow-fresh-'))
  projects.push(cwd)
  git(cwd, ['init', '-q'])
  git(cwd, ['config', 'user.name', 'Fresh Run Test'])
  git(cwd, ['config', 'user.email', 'fresh@example.test'])
  git(cwd, ['config', 'core.autocrlf', 'false'])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(cwd, 'source.txt'), 'initial\n')
  git(cwd, ['add', 'source.txt'])
  git(cwd, ['commit', '-qm', 'initial'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  mkdirSync(join(cwd, CONTROL))
  writeFileSync(join(cwd, CONTROL, 'REQUIREMENTS.md'), `# Requirements

## R1: Source
- R1.1: Source exists.
`)
  writeFileSync(join(cwd, CONTROL, 'PLAN.md'), `# Plan

## Acceptance criteria
- A1 (covers R1.1): \`source exists\`.
- A2 (covers R1.1): \`second file exists\`.

## Session report

## Decision log
`)
  writeFileSync(join(cwd, CONTROL, 'TASKS.md'), `# Tasks

## T1: Update source
- Depends on: —
- Files: source.txt
- Requirements: R1.1
- Acceptance: source changes; satisfies A1
- Session: —
- Status: pending

## T2: Finish source
- Depends on: T1
- Files: source-two.txt
- Requirements: R1.1
- Acceptance: second file exists; satisfies A2
- Session: —
- Status: pending
`)
  return { cwd, head }
}

function init(project: Project): void {
  expectOk(flowState(project.cwd, ['init', '--baseline', project.head, '--known-red', 'none']))
}

function approve(cwd: string, gate: string): void {
  expectOk(flowState(cwd, ['approve', gate, '--at', AT]))
}

function advanceTo(project: Project, phase: 'plan' | 'backlog' | 'execution'): void {
  init(project)
  approve(project.cwd, 'requirements')
  expectOk(flowState(project.cwd, ['advance']))
  if (phase === 'plan') return
  approve(project.cwd, 'plan')
  expectOk(flowState(project.cwd, ['advance']))
  if (phase === 'backlog') return
  approve(project.cwd, 'backlog')
  expectOk(flowState(project.cwd, ['advance']))
}

function stateValue(cwd: string, key: string): string {
  const line = readControl(cwd, 'STATE.md').split('\n').find((item) => item.startsWith(`- ${key}:`))
  return line?.slice(key.length + 3).trim() ?? ''
}

function expectState(cwd: string, phase: string, approvals: Record<string, string>): void {
  expect(stateValue(cwd, 'phase')).toBe(phase)
  for (const [key, value] of Object.entries(approvals)) {
    expect(stateValue(cwd, key)).toMatch(new RegExp(`^${value}`))
  }
}

function commitFile(cwd: string, file: string, contents: string, message: string): string {
  writeFileSync(join(cwd, file), contents)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-qm', message])
  return git(cwd, ['rev-parse', 'HEAD~1'])
}

function appendDecision(cwd: string, task: string): void {
  const anchor = git(cwd, ['rev-parse', 'HEAD'])
  writeFileSync(join(cwd, CONTROL, 'PLAN.md'), `${readControl(cwd, 'PLAN.md')}
### ${task} — task decision
- Decision: keep the task boundary.
- Why: the run needs a recorded decision.
- Constraint for later tasks: preserve declared files.
- Contracts touched: C1
- Anchor: ${anchor}
- Applies to: ${task}
`)
}

function taskStart(cwd: string, task: string): void {
  expectOk(flowState(cwd, ['task', task, 'in-progress']))
  expectOk(flowState(cwd, ['set', 'currentTask', task]))
  expectOk(flowState(cwd, ['set', 'taskStage', 'executing']))
}

function taskFinish(cwd: string, task: string): void {
  expectOk(flowState(cwd, ['task', task, 'done']))
  expectOk(flowState(cwd, ['set', 'taskStage', 'idle']))
  expectOk(flowState(cwd, ['set', 'currentTask', '-']))
}

function gitEnvWithoutPath(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const empty = mkdtempSync(join(tmpdir(), 'empty-path-'))
  projects.push(empty)
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = empty
  return env
}

afterAll(() => {
  for (const cwd of projects) rmSync(cwd, { recursive: true, force: true })
})

describe.skipIf(!hasGit)('fresh run happy path', () => {
  // These tests are ordered and share one project because each stage consumes the prior state.
  let project: Project

  beforeAll(() => { project = createProject() })

  test('initializes and checks the journal', () => {
    init(project)
    expectState(project.cwd, 'interview', {
      requirementsApproved: 'no', planApproved: 'no', backlogApproved: 'no',
    })
    const events = readControl(project.cwd, 'EVENTS.jsonl')
    expect(events).toContain('"command":"init"')
    expect(events).toContain('"status":"begin"')
    expect(events).toContain('"status":"commit"')
    expectOk(flowState(project.cwd, ['check']))
  })

  test('approves through execution and validates coverage and waves', () => {
    approve(project.cwd, 'requirements')
    expectOk(flowState(project.cwd, ['advance']))
    expectState(project.cwd, 'plan', { requirementsApproved: 'yes' })
    approve(project.cwd, 'plan')
    expectOk(flowState(project.cwd, ['advance']))
    expectState(project.cwd, 'backlog', { requirementsApproved: 'yes', planApproved: 'yes' })
    const coverage = runHelper('requirements-coverage.mjs', [
      '--requirements', `${CONTROL}/REQUIREMENTS.md`, '--tasks', `${CONTROL}/TASKS.md`,
      '--plan', `${CONTROL}/PLAN.md`,
    ], project.cwd)
    expectOk(coverage)
    expect(coverage.stdout).toContain('requirements-coverage: OK — 1 effective criteria covered; no unknown citations')
    expect(coverage.stdout).toContain('requirements-coverage: OK — 2 plan acceptance entries cited by tasks')
    const waves = runHelper('task-waves.mjs', [`${CONTROL}/TASKS.md`], project.cwd)
    expectOk(waves)
    expect(waves.stdout).toContain('Execution plan: 2 wave(s)')
    expect(waves.stdout).toContain('Wave 1 (sequential): T1')
    expect(waves.stdout).toContain('Wave 2 (sequential): T2')
    expect(waves.stdout.indexOf('T1')).toBeLessThan(waves.stdout.indexOf('T2'))
    expectOk(flowState(project.cwd, [
      'approve', 'backlog', '--at', AT, '--checkpoint-commits', 'yes', '--execution-mode', 'sequential',
    ]))
    expectOk(flowState(project.cwd, ['advance']))
    expectState(project.cwd, 'execution', {
      requirementsApproved: 'yes', planApproved: 'yes', backlogApproved: 'yes',
    })
  })

  test('executes T1 and validates its context and scope', () => {
    expectOk(runHelper('context-slice.mjs', ['--task', 'T1'], project.cwd))
    const context = readControl(project.cwd, 'CONTEXT-T1.md')
    expect(context).toContain('## T1: Update source')
    expect(context).toContain('- Files: source.txt')
    expect(context).toContain('- Acceptance: source changes; satisfies A1')
    expect(context).toContain('R1.1: Source exists.')
    expect(context).toContain('<!-- generated by context-slice.mjs')
    taskStart(project.cwd, 'T1')
    const base = commitFile(project.cwd, 'source.txt', 'changed\n', 'T1')
    expectOk(runHelper('scope-check.mjs', [
      '--task', 'T1', '--base', base, '--tasks', `${CONTROL}/TASKS.md`,
    ], project.cwd))
    appendDecision(project.cwd, 'T1')
    const plan = runHelper('context-slice.mjs', ['--check-plan'], project.cwd)
    expectOk(plan)
    expect(plan.stdout).toContain('1 decision block(s) ok')
    taskFinish(project.cwd, 'T1')
  })

  test.each([
    ['plan-drift', 'backlog'], ['requirement-delta', 'plan'], ['improvement-gate', 'backlog'],
  ])('handles %s and resets selectors', (command, phase) => {
    expectOk(flowState(project.cwd, [command]))
    expectState(project.cwd, phase, {
      currentTask: '-', taskStage: 'idle', wave: '-',
      ...(command === 'requirement-delta'
        ? { requirementsApproved: 'yes', planApproved: 'no', backlogApproved: 'no' }
        : { requirementsApproved: 'yes', planApproved: 'yes', backlogApproved: 'no' }),
    })
    if (command === 'requirement-delta') {
      approve(project.cwd, 'plan')
      expectOk(flowState(project.cwd, ['advance']))
    }
    approve(project.cwd, 'backlog')
    expectOk(flowState(project.cwd, ['advance']))
    expectState(project.cwd, 'execution', {})
  })

  test('executes T2 and reaches review', () => {
    taskStart(project.cwd, 'T2')
    const base = commitFile(project.cwd, 'source-two.txt', 'done\n', 'T2')
    expectOk(runHelper('scope-check.mjs', [
      '--task', 'T2', '--base', base, '--tasks', `${CONTROL}/TASKS.md`,
    ], project.cwd))
    taskFinish(project.cwd, 'T2')
    expectOk(flowState(project.cwd, ['advance']))
    expectState(project.cwd, 'review', {})
  })

  test('completes the run', () => {
    expectOk(flowState(project.cwd, ['advance', '--tasks', `${CONTROL}/TASKS.md`]))
    expectState(project.cwd, 'complete', {})
  })

  test('checks journal pairing and final artifacts', () => {
    expectOk(flowState(project.cwd, ['check', '--tasks', `${CONTROL}/TASKS.md`]))
    const records = readControl(project.cwd, 'EVENTS.jsonl').trim().split('\n')
      .map((line) => JSON.parse(line) as { id: string, status: string })
    const begins = records.filter((record) => record.status === 'begin')
    expect(records.some((record) => record.status === 'abort')).toBe(false)
    for (const begin of begins) {
      expect(records.filter((record) => record.status === 'commit' && record.id === begin.id)).toHaveLength(1)
    }
    expect(records.at(-1)?.status).toBe('commit')
    expectOk(runHelper('context-slice.mjs', ['--check-plan'], project.cwd))
  })
})

test.runIf(!hasGit)('git is not available — fresh-run harness skipped', () => {
  if (process.env.CI) throw new Error('git is required for the fresh-run harness on CI')
})

interface RejectionCase {
  name: string
  arrange: (project: Project) => void
  command: (project: Project) => Result
  stderr: string
}

const rejectionCases: RejectionCase[] = [
  {
    name: 'advance without requirements approval', arrange: init,
    command: (project) => flowState(project.cwd, ['advance']), stderr: 'requirementsApproved',
  },
  {
    name: 'approve plan without PLAN.md', arrange: (project) => {
      advanceTo(project, 'plan')
      unlinkSync(join(project.cwd, CONTROL, 'PLAN.md'))
    },
    command: (project) => flowState(project.cwd, ['approve', 'plan', '--at', AT]), stderr: 'PLAN.md',
  },
  {
    name: 'typed gate setter is rejected', arrange: init,
    command: (project) => flowState(project.cwd, ['set', 'phase', 'execution']), stderr: 'controlled',
  },
  {
    name: 'typed approval setter is rejected', arrange: init,
    command: (project) => flowState(project.cwd, ['set', 'planApproved', 'yes']), stderr: 'controlled',
  },
  {
    name: 'done is rejected from pending', arrange: init,
    command: (project) => flowState(project.cwd, ['task', 'T1', 'done']), stderr: 'transition',
  },
  {
    name: 'unknown task is rejected', arrange: init,
    command: (project) => flowState(project.cwd, ['task', 'T9', 'done']), stderr: 'task T9 is missing',
  },
]

describe.skipIf(!hasGit)('rejected commands leave control files unchanged', () => {
  test.each(rejectionCases)('$name', ({ arrange, command, stderr }) => {
    const project = createProject()
    arrange(project)
    const before = snapshotControl(project.cwd)
    const result = command(project)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(stderr)
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects completion with an in-progress task', () => {
    const project = createProject()
    advanceTo(project, 'execution')
    taskStart(project.cwd, 'T1')
    expectOk(flowState(project.cwd, ['set', 'taskStage', 'idle']))
    expectOk(flowState(project.cwd, ['set', 'currentTask', '-']))
    expectOk(flowState(project.cwd, ['task', 'T1', 'done']))
    expectOk(flowState(project.cwd, ['task', 'T2', 'in-progress']))
    expectOk(flowState(project.cwd, ['task', 'T2', 'done']))
    expectOk(flowState(project.cwd, ['advance', '--tasks', `${CONTROL}/TASKS.md`]))
    writeFileSync(join(project.cwd, CONTROL, 'TASKS.md'), readControl(project.cwd, 'TASKS.md')
      .replace('- Status: done\n', '- Status: in-progress\n'))
    const before = snapshotControl(project.cwd)
    const result = flowState(project.cwd, ['advance', '--tasks', `${CONTROL}/TASKS.md`])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('every task status')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects scope violations with a committed outside path', () => {
    const project = createProject()
    advanceTo(project, 'execution')
    const base = git(project.cwd, ['rev-parse', 'HEAD'])
    writeFileSync(join(project.cwd, 'outside.txt'), 'outside\n')
    git(project.cwd, ['add', 'outside.txt'])
    git(project.cwd, ['commit', '-qm', 'outside'])
    const before = snapshotControl(project.cwd)
    const result = runHelper('scope-check.mjs', [
      '--task', 'T1', '--base', base, '--tasks', `${CONTROL}/TASKS.md`,
    ], project.cwd)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('outside.txt')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects uncovered requirements', () => {
    const project = createProject()
    writeFileSync(join(project.cwd, CONTROL, 'REQUIREMENTS.md'), `# Requirements

## R1: Source
- R1.1: Source exists.
- R1.2: Source is tracked.
`)
    const before = snapshotControl(project.cwd)
    const result = runHelper('requirements-coverage.mjs', [
      '--requirements', `${CONTROL}/REQUIREMENTS.md`, '--tasks', `${CONTROL}/TASKS.md`,
    ], project.cwd)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('R1.2')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects a malformed decision block without writing', () => {
    const project = createProject()
    writeFileSync(join(project.cwd, CONTROL, 'PLAN.md'), `## Decision log
### T1 — malformed
- Decision: incomplete
`)
    const before = snapshotControl(project.cwd)
    const result = runHelper('context-slice.mjs', ['--check-plan'], project.cwd)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Why')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects a hand-edited gate for check and typed commands', () => {
    const project = createProject()
    init(project)
    writeFileSync(join(project.cwd, CONTROL, 'STATE.md'), readControl(project.cwd, 'STATE.md')
      .replace('- phase: interview', '- phase: plan'))
    const before = snapshotControl(project.cwd)
    const check = flowState(project.cwd, ['check'])
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('journal')
    expect(snapshotControl(project.cwd)).toEqual(before)
    const advance = flowState(project.cwd, ['advance'])
    expect(advance.status).toBe(1)
    expect(advance.stderr).toContain('last committed event')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('does not write a slice when git cannot be spawned', () => {
    const project = createProject()
    init(project)
    const before = snapshotControl(project.cwd)
    const result = runHelper('context-slice.mjs', ['--task', 'T1'], project.cwd, gitEnvWithoutPath())
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('git probe failed')
    expect(existsSync(join(project.cwd, CONTROL, 'CONTEXT-T1.md'))).toBe(false)
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects init when state already exists', () => {
    const project = createProject()
    init(project)
    const before = snapshotControl(project.cwd)
    const result = flowState(project.cwd, ['init', '--baseline', project.head, '--known-red', 'none'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('existing journal')
    expect(snapshotControl(project.cwd)).toEqual(before)
  })

  test('rejects an orphan journal until it is moved away', () => {
    const project = createProject()
    const journal = join(project.cwd, CONTROL, 'EVENTS.jsonl')
    writeFileSync(journal, '{"orphan":true}\n')
    const before = readdirSync(join(project.cwd, CONTROL)).sort()
    const rejected = flowState(project.cwd, ['init', '--baseline', project.head, '--known-red', 'none'])
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('EVENTS.jsonl')
    expect(readdirSync(join(project.cwd, CONTROL)).sort()).toEqual(before)
    renameSync(journal, join(project.cwd, CONTROL, 'moved-events.jsonl'))
    expect(flowState(project.cwd, ['init', '--baseline', project.head, '--known-red', 'none']).status).toBe(0)
  })
})
