import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
// @ts-expect-error — plain .mjs script
import { main } from '../scripts/flow-state.mjs'

const AT = '2026-11-11T10:00:00Z'
const REQUIREMENTS_TEXT = '# requirements\n'
const INIT = ['init', '--baseline', 'base', '--known-red', 'none']
const APPROVE = ['approve', 'requirements', '--at', AT]

interface JournalEvent {
  id: string
  command: string
  status: string
  recovered?: boolean
  sha256?: string
  artifact?: string
}

function makeProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-state-journal-'))
  const control = join(cwd, '.codex-flow')
  mkdirSync(control)
  writeFileSync(join(control, 'REQUIREMENTS.md'), REQUIREMENTS_TEXT)
  return {
    cwd,
    control,
    statePath: join(control, 'STATE.md'),
    eventsPath: join(control, 'EVENTS.jsonl'),
  }
}

function eventsOf(file: string): JournalEvent[] {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
}

/** Drop the last journal line, simulating a crash before it was appended. */
function dropLastEvent(file: string) {
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  writeFileSync(file, `${lines.slice(0, -1).join('\n')}\n`)
}

function silenceErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('flow-state journal integration', () => {
  test('init writes a begin and a commit and the state checks clean', async () => {
    // Arrange
    const project = makeProject()

    // Act
    const initCode = await main(INIT, { cwd: project.cwd })
    const checkCode = await main(['check'], { cwd: project.cwd })

    // Assert
    expect(initCode).toBe(0)
    expect(checkCode).toBe(0)
    const events = eventsOf(project.eventsPath)
    expect(events.map((event) => [event.command, event.status])).toEqual([['init', 'begin'], ['init', 'commit']])
    expect(events[0].id).toBe(events[1].id)
  })

  test('approve and advance append two events each and approve records the artifact hash', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })

    // Act
    await main(APPROVE, { cwd: project.cwd })
    await main(['advance'], { cwd: project.cwd })

    // Assert
    const events = eventsOf(project.eventsPath)
    expect(events.map((event) => `${event.command}:${event.status}`)).toEqual([
      'init:begin', 'init:commit', 'approve:begin', 'approve:commit', 'advance:begin', 'advance:commit',
    ])
    expect(events[2].artifact).toBe('REQUIREMENTS.md')
    expect(events[2].sha256).toBe(createHash('sha256').update(REQUIREMENTS_TEXT).digest('hex'))
    expect(await main(['check'], { cwd: project.cwd })).toBe(0)
  })

  test('set appends nothing to the journal', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const before = readFileSync(project.eventsPath, 'utf8')

    // Act
    const code = await main(['set', 'resumeHead', 'abc123'], { cwd: project.cwd })

    // Assert
    expect(code).toBe(0)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(before)
    expect(await main(['check'], { cwd: project.cwd })).toBe(0)
  })

  test('check reports a hand-edited gate key as a journal violation', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    await main(APPROVE, { cwd: project.cwd })
    const edited = readFileSync(project.statePath, 'utf8').replace(`yes (${AT})`, 'yes (edited)')
    writeFileSync(project.statePath, edited)
    const errors = silenceErrors()

    // Act
    const code = await main(['check'], { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    const output = errors.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('violation: journal:')
    expect(output).toContain('requirementsApproved')
    expect(output).toContain('yes (edited)')
  })

  test('a typed command on a hand-edited state is rejected and writes nothing', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    await main(APPROVE, { cwd: project.cwd })
    const edited = readFileSync(project.statePath, 'utf8').replace(`yes (${AT})`, 'yes (edited)')
    writeFileSync(project.statePath, edited)
    const journalBefore = readFileSync(project.eventsPath, 'utf8')
    silenceErrors()

    // Act
    const code = await main(['advance'], { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readFileSync(project.statePath, 'utf8')).toBe(edited)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(journalBefore)
  })

  test('a failing state writer leaves an abort for the same id and the state untouched', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const writeState = async () => {
      throw new Error('injected writer failure')
    }

    // Act
    const run = main(APPROVE, { cwd: project.cwd, writeState })

    // Assert
    await expect(run).rejects.toThrow('injected writer failure')
    const events = eventsOf(project.eventsPath)
    const [begin, abort] = events.slice(-2)
    expect([begin.status, abort.status]).toEqual(['begin', 'abort'])
    expect(abort.id).toBe(begin.id)
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
    expect(await main(APPROVE, { cwd: project.cwd })).toBe(0)
  })

  test('a crash after the state write is recovered as a commit before the next command runs', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const writeState = async (text: string) => {
      writeFileSync(project.statePath, text)
      throw new Error('crash after write')
    }
    await expect(main(APPROVE, { cwd: project.cwd, writeState })).rejects.toThrow('crash after write')
    dropLastEvent(project.eventsPath)

    // Act
    const code = await main(['advance'], { cwd: project.cwd })

    // Assert
    expect(code).toBe(0)
    const events = eventsOf(project.eventsPath)
    expect(events.map((event) => `${event.command}:${event.status}`)).toEqual([
      'init:begin', 'init:commit', 'approve:begin', 'approve:commit', 'advance:begin', 'advance:commit',
    ])
    expect(events[3].recovered).toBe(true)
    expect(events[3].id).toBe(events[2].id)
    expect(readFileSync(project.statePath, 'utf8')).toContain('- phase: plan')
    expect(await main(['check'], { cwd: project.cwd })).toBe(0)
  })

  test('a crash before the state write is recovered as an abort before the next command runs', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const writeState = async () => {
      throw new Error('crash before write')
    }
    await expect(main(APPROVE, { cwd: project.cwd, writeState })).rejects.toThrow('crash before write')
    dropLastEvent(project.eventsPath)
    silenceErrors()
    const openCheck = await main(['check'], { cwd: project.cwd })

    // Act
    const code = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect(openCheck).toBe(1)
    expect(code).toBe(0)
    const events = eventsOf(project.eventsPath)
    expect(events[3]).toMatchObject({ command: 'approve', status: 'abort', recovered: true, id: events[2].id })
    expect(events.slice(4).map((event) => event.status)).toEqual(['begin', 'commit'])
    expect(await main(['check'], { cwd: project.cwd })).toBe(0)
  })

  test('a corrupt journal fails check and rejects typed commands without writing', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    writeFileSync(project.eventsPath, `${readFileSync(project.eventsPath, 'utf8')}not json\n`)
    const journalBefore = readFileSync(project.eventsPath, 'utf8')
    const stateBefore = readFileSync(project.statePath, 'utf8')
    silenceErrors()

    // Act
    const checkCode = await main(['check'], { cwd: project.cwd })
    const approveCode = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect(checkCode).toBe(1)
    expect(approveCode).toBe(1)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(journalBefore)
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test('init with a leftover journal and no state is rejected and leaves the directory unchanged', async () => {
    // Arrange
    const project = makeProject()
    writeFileSync(project.eventsPath, '')
    const listingBefore = readdirSync(project.control).sort()
    silenceErrors()

    // Act
    const code = await main(INIT, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readdirSync(project.control).sort()).toEqual(listingBefore)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe('')
  })

  test('init over an existing legacy state is rejected and creates no journal', async () => {
    // Arrange
    const project = makeProject()
    writeFileSync(project.statePath, '- phase: interview\n')
    silenceErrors()

    // Act
    const code = await main(INIT, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readdirSync(project.control).sort()).toEqual(['REQUIREMENTS.md', 'STATE.md'])
    expect(readFileSync(project.statePath, 'utf8')).toBe('- phase: interview\n')
  })

  test('the --events override is honoured by init, approve and check', async () => {
    // Arrange
    const project = makeProject()
    const custom = join(project.cwd, 'custom-events.jsonl')

    // Act
    const initCode = await main([...INIT, '--events', custom], { cwd: project.cwd })
    const approveCode = await main([...APPROVE, '--events', custom], { cwd: project.cwd })
    const checkCode = await main(['check', '--events', custom], { cwd: project.cwd })

    // Assert
    expect([initCode, approveCode, checkCode]).toEqual([0, 0, 0])
    expect(eventsOf(custom)).toHaveLength(4)
    expect(readdirSync(project.control).sort()).toEqual(['EVENTS.jsonl', 'REQUIREMENTS.md', 'STATE.md'])
  })

  test.each([
    ['missing redirect target', (project: Project) => {
      writeFileSync(project.eventsPath, `${JSON.stringify({ redirect: join(project.cwd, 'missing.jsonl') })}\n`)
    }],
    ['misplaced redirect', (project: Project) => {
      writeFileSync(project.eventsPath, `${JSON.stringify({ redirect: join(project.cwd, 'missing.jsonl') })}\n{}\n`)
    }],
  ])('%s maps journal resolution errors for check and typed commands', async (_, arrange) => {
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    arrange(project)
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const journalBefore = readFileSync(project.eventsPath, 'utf8')
    const errors = silenceErrors()

    const checkCode = await main(['check'], { cwd: project.cwd })
    const typedCode = await main(APPROVE, { cwd: project.cwd })

    expect([checkCode, typedCode]).toEqual([1, 1])
    expect(errors.mock.calls.join('\n')).toMatch(/journal:/)
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(journalBefore)
  })

  test.each([
    ['a null record', 'null'],
    ['a record without an id', '{"ts":"t","command":"advance","status":"commit"}'],
    ['a begin without an after snapshot', '{"id":"x","ts":"t","command":"advance","status":"begin"}'],
  ])('%s makes the journal corrupt for check and typed commands', async (_, line) => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    writeFileSync(project.eventsPath, `${readFileSync(project.eventsPath, 'utf8')}${line}\n`)
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const errors = silenceErrors()

    // Act
    const checkCode = await main(['check'], { cwd: project.cwd })
    const approveCode = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect([checkCode, approveCode]).toEqual([1, 1])
    expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('corrupt journal line 3')
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test('a commit without a begin rejects typed commands', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const orphan = JSON.stringify({ id: 'orphan', ts: AT, command: 'advance', status: 'commit' })
    writeFileSync(project.eventsPath, `${readFileSync(project.eventsPath, 'utf8')}${orphan}\n`)
    const stateBefore = readFileSync(project.statePath, 'utf8')
    silenceErrors()

    // Act
    const code = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test('an open transaction matching neither snapshot is rejected, not thrown', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const writeState = async () => {
      throw new Error('crash before write')
    }
    await expect(main(APPROVE, { cwd: project.cwd, writeState })).rejects.toThrow('crash before write')
    dropLastEvent(project.eventsPath)
    const edited = readFileSync(project.statePath, 'utf8').replace('- phase: interview', '- phase: review')
    writeFileSync(project.statePath, edited)
    const journalBefore = readFileSync(project.eventsPath, 'utf8')
    silenceErrors()

    // Act
    const code = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(journalBefore)
    expect(readFileSync(project.statePath, 'utf8')).toBe(edited)
  })

  test.skipIf(process.platform === 'win32')('init refuses a dangling STATE.md symlink before journaling', async () => {
    // Arrange
    const project = makeProject()
    symlinkSync(join(project.cwd, 'missing-target'), project.statePath)
    silenceErrors()

    // Act
    const code = await main(INIT, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readdirSync(project.control).sort()).toEqual(['REQUIREMENTS.md', 'STATE.md'])
  })

  test.skipIf(process.platform === 'win32')('a symlinked journal is refused and its target is not written', async () => {
    // Arrange
    const project = makeProject()
    const target = join(project.cwd, 'elsewhere.jsonl')
    symlinkSync(target, project.eventsPath)
    silenceErrors()

    // Act
    const code = await main(INIT, { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readdirSync(project.cwd).sort()).toEqual(['.codex-flow'])
  })
})

describe('custom journal path', () => {
  function initCustom() {
    const project = makeProject()
    const custom = join(project.cwd, 'journals', 'custom.jsonl')
    mkdirSync(join(project.cwd, 'journals'))
    return { project, custom }
  }

  test('init records a redirect in the default journal and journals to the custom path', async () => {
    // Arrange
    const { project, custom } = initCustom()

    // Act
    const code = await main([...INIT, '--events', 'journals/custom.jsonl'], { cwd: project.cwd })

    // Assert
    expect(code).toBe(0)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(`${JSON.stringify({ redirect: custom })}\n`)
    expect(eventsOf(custom).map((event) => `${event.command}:${event.status}`)).toEqual(['init:begin', 'init:commit'])
  })

  test('later commands without --events follow the redirect and leave it untouched', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })
    const pointer = readFileSync(project.eventsPath, 'utf8')

    // Act
    const approveCode = await main(APPROVE, { cwd: project.cwd })
    const advanceCode = await main(['advance'], { cwd: project.cwd })
    const checkCode = await main(['check'], { cwd: project.cwd })

    // Assert
    expect([approveCode, advanceCode, checkCode]).toEqual([0, 0, 0])
    expect(eventsOf(custom)).toHaveLength(6)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(pointer)
  })

  test('an explicit --events that matches the redirect is accepted', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })

    // Act
    const code = await main([...APPROVE, '--events', custom], { cwd: project.cwd })

    // Assert
    expect(code).toBe(0)
    expect(eventsOf(custom)).toHaveLength(4)
  })

  test('an explicit --events that differs from the redirect is rejected and writes nothing', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })
    const other = join(project.cwd, 'other.jsonl')
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const journalBefore = readFileSync(custom, 'utf8')
    const errors = silenceErrors()

    // Act
    const typedCode = await main([...APPROVE, '--events', other], { cwd: project.cwd })
    const checkCode = await main(['check', '--events', other], { cwd: project.cwd })

    // Assert
    expect([typedCode, checkCode]).toEqual([1, 1])
    expect(errors.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('does not match the journal recorded for this run')
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
    expect(readFileSync(custom, 'utf8')).toBe(journalBefore)
    expect(readdirSync(project.cwd)).not.toContain('other.jsonl')
  })

  test('a redirect whose target is gone fails check and rejects typed commands', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })
    renameSync(custom, `${custom}.moved`)
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const errors = silenceErrors()

    // Act
    const checkCode = await main(['check'], { cwd: project.cwd })
    const typedCode = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect([checkCode, typedCode]).toEqual([1, 1])
    expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('redirect target missing')
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test.each([
    ['the custom journal already exists', (project: ReturnType<typeof makeProject>, custom: string) => {
      writeFileSync(custom, '')
    }],
    ['the default journal already exists', (project: ReturnType<typeof makeProject>) => {
      writeFileSync(project.eventsPath, '')
    }],
    ['the state already exists', (project: ReturnType<typeof makeProject>) => {
      writeFileSync(project.statePath, '- phase: interview\n')
    }],
  ])('init with a custom path is rejected when %s and leaves both directories unchanged', async (_, arrange) => {
    // Arrange
    const { project, custom } = initCustom()
    arrange(project, custom)
    const controlBefore = readdirSync(project.control).sort()
    const journalsBefore = readdirSync(join(project.cwd, 'journals')).sort()
    silenceErrors()

    // Act
    const code = await main([...INIT, '--events', custom], { cwd: project.cwd })

    // Assert
    expect(code).toBe(1)
    expect(readdirSync(project.control).sort()).toEqual(controlBefore)
    expect(readdirSync(join(project.cwd, 'journals')).sort()).toEqual(journalsBefore)
  })

  test('a failed state creation removes the redirect this init wrote', async () => {
    // Arrange: the custom journal directory does not exist, so the first journal append fails.
    const project = makeProject()
    const custom = join(project.cwd, 'no-such-dir', 'custom.jsonl')

    // Act
    const run = main([...INIT, '--events', custom], { cwd: project.cwd })

    // Assert
    await expect(run).rejects.toThrow()
    expect(readdirSync(project.control).sort()).toEqual(['REQUIREMENTS.md'])
  })

  test('a default-path run rejects a different explicit --events instead of going unjournaled', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    const other = join(project.cwd, 'other.jsonl')
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const journalBefore = readFileSync(project.eventsPath, 'utf8')
    silenceErrors()

    // Act
    const typedCode = await main([...APPROVE, '--events', other], { cwd: project.cwd })
    const checkCode = await main(['check', '--events', other], { cwd: project.cwd })

    // Assert
    expect([typedCode, checkCode]).toEqual([1, 1])
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
    expect(readFileSync(project.eventsPath, 'utf8')).toBe(journalBefore)
    expect(readdirSync(project.cwd)).not.toContain('other.jsonl')
  })

  test.skipIf(process.platform === 'win32')('a redirect to a dangling symlink is a corrupt journal', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })
    renameSync(custom, `${custom}.moved`)
    symlinkSync(join(project.cwd, 'nowhere.jsonl'), custom)
    const stateBefore = readFileSync(project.statePath, 'utf8')
    silenceErrors()

    // Act
    const typedCode = await main(APPROVE, { cwd: project.cwd })
    const checkCode = await main(['check'], { cwd: project.cwd })

    // Assert
    expect([typedCode, checkCode]).toEqual([1, 1])
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test.skipIf(process.platform === 'win32')('a redirect to a symlinked journal is a corrupt journal', async () => {
    // Arrange
    const { project, custom } = initCustom()
    await main([...INIT, '--events', custom], { cwd: project.cwd })
    renameSync(custom, `${custom}.real`)
    symlinkSync(`${custom}.real`, custom)
    silenceErrors()

    // Act
    const checkCode = await main(['check'], { cwd: project.cwd })

    // Assert
    expect(checkCode).toBe(1)
  })

  test('a relative redirect target is a corrupt journal', async () => {
    // Arrange
    const project = makeProject()
    await main(INIT, { cwd: project.cwd })
    writeFileSync(project.eventsPath, '{"redirect":"journals/custom.jsonl"}\n')
    const stateBefore = readFileSync(project.statePath, 'utf8')
    const errors = silenceErrors()

    // Act
    const typedCode = await main(APPROVE, { cwd: project.cwd })

    // Assert
    expect(typedCode).toBe(1)
    expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('must be an absolute path')
    expect(readFileSync(project.statePath, 'utf8')).toBe(stateBefore)
  })

  test('a default-path run writes no redirect record', async () => {
    // Arrange
    const project = makeProject()

    // Act
    await main(INIT, { cwd: project.cwd })

    // Assert
    expect(readFileSync(project.eventsPath, 'utf8')).not.toContain('redirect')
    expect(eventsOf(project.eventsPath)).toHaveLength(2)
  })
})
