import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createIncrementalParser, parseEvents } from '../src/eventParser.js'

/**
 * Protocol canary suite: replays version-pinned real Codex CLI JSONL captures through the parser
 * and asserts the invariants the rest of the system relies on. A Codex upgrade that changes the
 * stream shape fails here loudly instead of silently degrading (e.g. sawCompletion never true).
 *
 * Refresh fixtures with: node scripts/refresh-protocol-fixtures.mjs
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol')
const REFRESH_HINT =
  'Fixture out of date or parser drifted — refresh with `node scripts/refresh-protocol-fixtures.mjs` ' +
  'and review src/eventParser.ts for new event types.'
const CHUNK_SIZE = 7

interface FixtureMeta {
  codexVersion: string
  capturedAt: string
  prompt: string
  synthetic: boolean
  expectedUnknownEvents: number
}

interface Fixture {
  name: string
  jsonl: string
  meta: FixtureMeta
}

const listFixtureNames = (): string[] => {
  try {
    return readdirSync(FIXTURE_DIR)
      .filter((file) => file.startsWith('codex-') && file.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

const loadFixture = (name: string): Fixture => {
  const jsonl = readFileSync(join(FIXTURE_DIR, name), 'utf8')
  const metaRaw = readFileSync(join(FIXTURE_DIR, name.replace(/\.jsonl$/, '.meta.json')), 'utf8')
  const meta = JSON.parse(metaRaw) as FixtureMeta
  expect(typeof meta.codexVersion, `${name}: meta sidecar must record codexVersion`).toBe('string')
  expect(typeof meta.expectedUnknownEvents, `${name}: meta sidecar must record expectedUnknownEvents`).toBe('number')
  return { name, jsonl, meta }
}

const fixtureNames = listFixtureNames()

describe.runIf(fixtureNames.length > 0)('codex protocol fixtures', () => {
  describe.each(fixtureNames)('%s', (name) => {
    it('parses with zero parse errors', () => {
      const { jsonl } = loadFixture(name)
      const result = parseEvents(jsonl)
      expect(result.parseErrors, `${name}: JSONL lines failed to parse. ${REFRESH_HINT}`).toBe(0)
    })

    it('reaches a terminal turn event (sawCompletion)', () => {
      const { jsonl } = loadFixture(name)
      const result = parseEvents(jsonl)
      expect(
        result.sawCompletion,
        `${name}: no turn.completed/turn.failed seen — a completion-shape change would make every run report partial. ${REFRESH_HINT}`,
      ).toBe(true)
    })

    it('extracts a non-empty sessionId', () => {
      const { jsonl } = loadFixture(name)
      const result = parseEvents(jsonl)
      expect(result.sessionId, `${name}: thread.started/thread_id shape changed. ${REFRESH_HINT}`).toBeTruthy()
      expect(result.sessionId?.length ?? 0).toBeGreaterThan(0)
    })

    it('reports no errors for a successful trivial run', () => {
      const { jsonl } = loadFixture(name)
      const result = parseEvents(jsonl)
      expect(result.errors, `${name}: trivial run produced error items. ${REFRESH_HINT}`).toEqual([])
    })

    it('has exactly the unknown-event count pinned in the meta sidecar', () => {
      const { jsonl, meta } = loadFixture(name)
      const result = parseEvents(jsonl)
      expect(
        result.unknownEvents,
        `${name}: unknownEvents drifted from expectedUnknownEvents (${meta.expectedUnknownEvents}) — ` +
          'the CLI likely introduced new event types. Re-capture with ' +
          '`node scripts/refresh-protocol-fixtures.mjs` and review src/eventParser.ts for events worth handling.',
      ).toBe(meta.expectedUnknownEvents)
    })

    it('incremental parser in 7-byte chunks matches batch parse', () => {
      const { jsonl } = loadFixture(name)
      const batch = parseEvents(jsonl)
      const incremental = createIncrementalParser()
      const buffer = Buffer.from(jsonl, 'utf8')
      for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
        incremental.push(buffer.subarray(offset, offset + CHUNK_SIZE))
      }
      incremental.end()
      expect(incremental.result(), `${name}: chunked parse diverged from batch parse. ${REFRESH_HINT}`).toEqual(batch)
    })
  })
})
