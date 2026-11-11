import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import {
  APPROVAL_GATES,
  NON_LINEAR_COMMANDS,
  PHASES,
  parseCliArgs,
  parseOptions,
} from '../scripts/flow-state-cli.mjs'

describe('flow-state CLI parsing', () => {
  test.each([
    ['init defaults', ['init', '--baseline', 'base', '--known-red', 'none'],
      { command: 'init', state: '.codex-flow/STATE.md', dirtyBaseline: undefined, executor: undefined }],
    ['init options', [
      'init', '--baseline', 'base', '--known-red', 'none', '--state', 's', '--dirty-baseline', 'dirty', '--executor',
      'claude',
    ],
      { command: 'init', state: 's', dirtyBaseline: 'dirty', executor: 'claude' }],
    ['approve defaults', ['approve', 'plan'],
      { command: 'approve', gate: 'plan', state: '.codex-flow/STATE.md', delta: false, dir: '.codex-flow' }],
    ['approve options', [
      'approve', 'backlog', '--state', 's', '--at', 'now', '--delta', '--checkpoint-commits', 'yes',
      '--execution-mode', 'parallel', '--dir', 'd',
    ], {
      command: 'approve', gate: 'backlog', state: 's', at: 'now', delta: true, checkpointCommits: 'yes',
      executionMode: 'parallel', dir: 'd',
    }],
    ['advance defaults', ['advance'],
      { command: 'advance', state: '.codex-flow/STATE.md', tasks: '.codex-flow/TASKS.md' }],
    ['advance options', ['advance', '--state', 's', '--tasks', 't'],
      { command: 'advance', state: 's', tasks: 't' }],
    ['requirement delta', ['requirement-delta'],
      { command: 'requirement-delta', state: '.codex-flow/STATE.md', at: undefined }],
    ['plan drift', ['plan-drift', '--state', 's', '--at', 'now'],
      { command: 'plan-drift', state: 's', at: 'now' }],
    ['improvement gate', ['improvement-gate'],
      { command: 'improvement-gate', state: '.codex-flow/STATE.md', at: undefined }],
    ['resume defaults', ['resume', '--head', 'h'],
      { command: 'resume', state: '.codex-flow/STATE.md', head: 'h', phase: undefined }],
    ['resume options', ['resume', '--head', 'h', '--state', 's', '--phase', 'review'],
      { command: 'resume', state: 's', head: 'h', phase: 'review' }],
    ['set defaults', ['set', 'phase', 'plan'],
      { command: 'set', state: '.codex-flow/STATE.md', key: 'phase', value: 'plan' }],
    ['set options', ['set', 'phase', 'plan', '--state', 's'],
      { command: 'set', state: 's', key: 'phase', value: 'plan' }],
    ['check defaults', ['check'],
      { command: 'check', state: '.codex-flow/STATE.md', tasks: null }],
    ['check options', ['check', '--state', 's', '--tasks', 't'],
      { command: 'check', state: 's', tasks: 't' }],
    ['task defaults', ['task', 'T1', 'done'],
      { command: 'task', id: 'T1', status: 'done', tasks: '.codex-flow/TASKS.md', at: undefined }],
    ['task options', ['task', 'T1', 'done', '--tasks', 't', '--at', 'now'],
      { command: 'task', id: 'T1', status: 'done', tasks: 't', at: 'now' }],
  ])('parses %s', (_, argv, expected) => {
    // Arrange

    // Act
    const parsed = parseCliArgs(argv)

    // Assert
    expect(parsed).toMatchObject(expected)
  })

  test.each([
    ['unknown option', ['advance', '--wat'], 'unknown option --wat'],
    ['duplicate option', ['advance', '--state', 'a', '--state', 'b'], 'duplicate option --state'],
    ['missing option value', ['advance', '--state'], '--state requires a value'],
    ['invalid positional count', ['set', 'phase'], 'invalid arguments'],
    ['unknown approval', ['approve', 'unknown'], 'unknown approval unknown'],
    ['invalid phase', ['resume', '--head', 'h', '--phase', 'bad'], 'invalid phase "bad"'],
    ['unknown command', ['nope'], 'usage: flow-state'],
    ['non-array argv', null, 'CLI args must be an array of strings'],
    ['non-string argv item', ['advance', 1], 'CLI args must be an array of strings'],
  ])('rejects %s', (_, argv, message) => {
    // Arrange

    // Act

    // Assert
    expect(() => parseCliArgs(argv)).toThrow(message)
    expect(() => parseOptions(['--state'], 0, new Set(['--state']))).toThrow('--state requires a value')
  })

  test('exports frozen name lists shared with the state kernel', async () => {
    // Arrange
    // @ts-expect-error — plain .mjs script
    const stateKernel = await import('../scripts/flow-state.mjs')

    // Act

    // Assert
    expect(Object.isFrozen(PHASES)).toBe(true)
    expect(PHASES).toEqual(stateKernel.PHASES)
    expect(APPROVAL_GATES).toEqual(Object.keys(stateKernel.APPROVE_RULES))
    expect(NON_LINEAR_COMMANDS).toEqual(Object.keys(stateKernel.NON_LINEAR_RULES))
  })

  test('is a pure module with no imports or process access', () => {
    // Arrange
    const source = readFileSync(join(process.cwd(), 'scripts/flow-state-cli.mjs'), 'utf8')

    // Act

    // Assert
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toContain('process.')
    expect(source).not.toContain('require(')
  })

  test('lists the CLI module in the package files', () => {
    // Arrange
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { files?: unknown }

    // Act / Assert
    expect(packageJson.files).toEqual(expect.arrayContaining(['scripts/flow-state-cli.mjs']))
  })
})
