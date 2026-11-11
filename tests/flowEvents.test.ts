import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
// @ts-expect-error — plain .mjs script
import {
  appendEvent,
  eventsPathFor,
  journalFilesFor,
  resolveJournalPath,
  gateSnapshot,
  journalViolations,
  openTransaction,
  readEvents,
  recoverOpenTransaction,
  runJournaled,
  journalInit,
} from '../scripts/flow-events.mjs'

const state = '- phase: plan\n- requirementsApproved: yes\n- planApproved: no\n- backlogApproved: no\n'
const event = (status: string, id = '1', before = gateSnapshot(state), after = gateSnapshot(state)) => ({
  id,
  ts: '2026-11-11T00:00:00.000Z',
  command: 'advance',
  status,
  before,
  after,
})
const file = async () => join(await mkdtemp(join(tmpdir(), 'flow-events-')), 'EVENTS.jsonl')

test('gateSnapshot returns gates', () => expect(gateSnapshot(state).phase).toBe('plan'))
test('eventsPathFor returns sibling journal path', () =>
  expect(eventsPathFor(join('x', 'STATE.md'))).toBe(join('x', 'EVENTS.jsonl')))

test('journalFilesFor returns existing ordinary and redirect journal files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const statePath = join(dir, 'STATE.md')
  const defaultPath = eventsPathFor(statePath)
  const target = join(dir, 'custom.jsonl')
  await expect(journalFilesFor({ statePath })).resolves.toEqual([])
  await writeFile(defaultPath, '')
  await expect(journalFilesFor({ statePath })).resolves.toEqual([defaultPath])
  await writeFile(defaultPath, `${JSON.stringify({ redirect: target })}\n`)
  await writeFile(target, '')
  await expect(journalFilesFor({ statePath })).resolves.toEqual([defaultPath, target])
})

test('journalFilesFor keeps a dangling redirect target out and rejects corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const statePath = join(dir, 'STATE.md')
  const defaultPath = eventsPathFor(statePath)
  const target = join(dir, 'missing.jsonl')
  await writeFile(defaultPath, `${JSON.stringify({ redirect: target })}\n`)
  await expect(journalFilesFor({ statePath })).resolves.toEqual([defaultPath])
  await writeFile(defaultPath, `${JSON.stringify({ redirect: 'relative.jsonl' })}\n`)
  await expect(journalFilesFor({ statePath })).rejects.toBeInstanceOf(Error)
})

test('journalInit removes its pointer when append fails and preserves the append error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const eventsPath = join(dir, 'custom.jsonl')
  const pointerPath = join(dir, 'EVENTS.jsonl')
  const failure = new Error('append failed')
  await expect(journalInit({
    eventsPath, defaultEventsPath: pointerPath, statePath: join(dir, 'STATE.md'), stateText: state,
    createState: async () => undefined, append: async () => { throw failure },
  })).rejects.toBe(failure)
  await expect(readFile(pointerPath, 'utf8')).rejects.toThrow()
})

test('journalInit preserves the append error when pointer removal fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const eventsPath = join(dir, 'custom.jsonl')
  const pointerPath = join(dir, 'EVENTS.jsonl')
  const failure = new Error('append failed')
  await expect(journalInit({
    eventsPath, defaultEventsPath: pointerPath, statePath: join(dir, 'STATE.md'), stateText: state,
    createState: async () => undefined, append: async () => { throw failure },
    remove: async () => { throw new Error('remove failed') },
  })).rejects.toBe(failure)
})

test('journalInit removes its pointer when the abort record cannot be appended', async () => {
  // Arrange: the begin record is written for real, state creation fails, then the abort append fails.
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const eventsPath = join(dir, 'custom.jsonl')
  const pointerPath = join(dir, 'EVENTS.jsonl')
  const failure = new Error('state creation failed')
  let appends = 0
  const append = async (file: string, record: unknown) => {
    appends += 1
    if (appends > 1) throw new Error('abort append failed')
    await appendEvent(file, record)
  }

  // Act
  const run = journalInit({
    eventsPath, defaultEventsPath: pointerPath, statePath: join(dir, 'STATE.md'), stateText: state,
    createState: async () => {
      throw failure
    },
    append,
  })

  // Assert
  await expect(run).rejects.toBe(failure)
  expect(appends).toBe(2)
  await expect(readFile(pointerPath, 'utf8')).rejects.toThrow()
})

test('resolveJournalPath follows a sole default redirect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const custom = join(dir, 'custom.jsonl')
  await writeFile(join(dir, 'EVENTS.jsonl'), `${JSON.stringify({ redirect: custom })}\n`)
  await writeFile(custom, '')

  await expect(resolveJournalPath({ statePath: join(dir, 'STATE.md') })).resolves.toBe(custom)
})

test('resolveJournalPath rejects an explicit path that disagrees with a redirect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const custom = join(dir, 'custom.jsonl')
  await writeFile(join(dir, 'EVENTS.jsonl'), `${JSON.stringify({ redirect: custom })}\n`)

  await expect(resolveJournalPath({ statePath: join(dir, 'STATE.md'), eventsOption: join(dir, 'other.jsonl') }))
    .rejects.toThrow(`does not match the journal recorded for this run (${custom})`)
})
test('appendEvent and readEvents round trip', async () => {
  const target = await file()
  await appendEvent(target, event('begin'))
  await expect(readEvents(target)).resolves.toMatchObject({ corrupt: null, events: [event('begin')] })
})
test('empty journal is valid', async () => {
  const target = await file()
  await writeFile(target, '')
  await expect(readEvents(target)).resolves.toEqual({ events: [], corrupt: null })
})
test('empty middle line names line two', async () => {
  const target = await file()
  await writeFile(target, JSON.stringify(event('begin')) + '\n\n')
  await expect(readEvents(target)).resolves.toMatchObject({ corrupt: 'corrupt journal line 2: empty line' })
})
test('missing trailing newline names line one', async () => {
  const target = await file()
  await writeFile(target, JSON.stringify(event('begin')))
  await expect(readEvents(target)).resolves.toMatchObject({
    corrupt: 'corrupt journal line 1: missing trailing newline',
  })
})
test('missing journal is reported', async () => {
  await expect(
    readEvents(join(await mkdtemp(join(tmpdir(), 'flow-events-')), 'missing')),
  ).resolves.toMatchObject({ missing: true })
})
test('openTransaction returns last open begin', () =>
  expect(openTransaction([event('begin', 'a'), event('begin', 'b')])).toMatchObject({ id: 'b' }))
test('journalViolations identifies orphan commit', () =>
  expect(journalViolations(state, [event('commit')])[0]).toMatchObject({ kind: 'orphan-commit' }))
test('journalViolations reports two mismatching keys', () => {
  const after = { ...gateSnapshot(state), phase: 'backlog', planApproved: 'yes' }
  const results = journalViolations(state, [event('begin', '1', gateSnapshot(state), after), event('commit')])
  expect(results.filter((item) => item.kind === 'mismatch')).toHaveLength(2)
})
test('journalViolations identifies open begin', () =>
  expect(journalViolations(state, [event('begin')])[0]).toMatchObject({ kind: 'open' }))
test('recovery commits after state write', async () => {
  const target = await file()
  const after = state.replace('plan', 'backlog')
  const begin = event('begin', '1', gateSnapshot(state), gateSnapshot(after))
  await appendEvent(target, begin)
  await expect(
    recoverOpenTransaction({ eventsPath: target, events: [begin], stateText: after }),
  ).resolves.toBe('commit')
  await expect(readEvents(target)).resolves.toMatchObject({
    events: [{ status: 'begin' }, { status: 'commit', recovered: true }],
  })
})
test('recovery aborts before state write', async () => {
  const target = await file()
  const begin = event('begin', '1', gateSnapshot(state), { ...gateSnapshot(state), phase: 'backlog' })
  await appendEvent(target, begin)
  await expect(
    recoverOpenTransaction({ eventsPath: target, events: [begin], stateText: state }),
  ).resolves.toBe('abort')
})
test('recovery rejects neither state without writing', async () => {
  const target = await file()
  const begin = event('begin', '1', gateSnapshot(state), { ...gateSnapshot(state), phase: 'backlog' })
  await appendEvent(target, begin)
  const before = await readFile(target, 'utf8')
  await expect(
    recoverOpenTransaction({
      eventsPath: target,
      events: [begin],
      stateText: state.replace('plan', 'review'),
    }),
  ).rejects.toThrow()
  await expect(readFile(target, 'utf8')).resolves.toBe(before)
})
test('recovery does nothing without open transaction', async () => {
  const target = await file()
  const begin = event('begin')
  const commit = event('commit')
  await appendEvent(target, begin)
  await appendEvent(target, commit)
  const before = await readFile(target, 'utf8')
  await expect(
    recoverOpenTransaction({ eventsPath: target, events: [begin, commit], stateText: state }),
  ).resolves.toBeNull()
  await expect(readFile(target, 'utf8')).resolves.toBe(before)
})
test('runJournaled writes begin and commit with same id', async () => {
  const target = await file()
  await runJournaled({
    eventsPath: target,
    command: 'advance',
    beforeText: state,
    afterText: state,
    writeState: async () => undefined,
  })
  const result = await readEvents(target)
  expect(result.events.map((item) => item.status)).toEqual(['begin', 'commit'])
  expect(result.events[0].id).toBe(result.events[1].id)
})
test('runJournaled writes abort on writer error', async () => {
  const target = await file()
  await expect(
    runJournaled({
      eventsPath: target,
      command: 'advance',
      beforeText: state,
      afterText: state,
      writeState: async () => {
        throw new Error('failed')
      },
    }),
  ).rejects.toThrow('failed')
  await expect(readEvents(target)).resolves.toMatchObject({
    events: [{ status: 'begin' }, { status: 'abort' }],
  })
})
test('runJournaled records artifact hash without artifactPath', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-events-'))
  const target = join(dir, 'EVENTS.jsonl')
  const artifact = join(dir, 'REQUIREMENTS.md')
  await writeFile(artifact, 'bytes')
  await runJournaled({
    eventsPath: target,
    command: 'approve',
    beforeText: state,
    afterText: state,
    extra: { artifact, artifactPath: artifact },
    writeState: async () => undefined,
  })
  const result = await readEvents(target)
  expect(result.events[0]).toMatchObject({
    artifact: 'REQUIREMENTS.md',
    sha256: createHash('sha256').update('bytes').digest('hex'),
  })
  expect(result.events[0]).not.toHaveProperty('artifactPath')
})
test.each([
  { id: undefined },
  { ts: undefined },
  { command: undefined },
  { status: undefined },
  { status: 'done' },
  { before: 'bad' },
  { after: 1 },
])('appendEvent rejects invalid records %#', async (partial) => {
  await expect(
    appendEvent(await file(), { id: 'i', ts: 't', command: 'c', status: 'begin', ...partial }),
  ).rejects.toThrow()
})
