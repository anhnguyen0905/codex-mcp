import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  changelogHasVersion,
  extractJsonVersions,
  findMismatches,
} from '../scripts/check-release-consistency.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { buffersEqual } from '../scripts/check-command-sync.mjs'

describe('extractJsonVersions', () => {
  test('reads a top-level version field', () => {
    const entries = extractJsonVersions('package.json', '{"version":"1.2.3"}', [['version']])

    expect(entries).toEqual([{ label: 'package.json .version', version: '1.2.3' }])
  })

  test('reads nested lockfile and server.json paths', () => {
    const lock = JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } })
    const server = JSON.stringify({ version: '1.2.3', packages: [{ version: '9.9.9' }] })

    const lockEntries = extractJsonVersions('package-lock.json', lock, [
      ['version'],
      ['packages', '', 'version'],
    ])
    const serverEntries = extractJsonVersions('server.json', server, [
      ['version'],
      ['packages', 0, 'version'],
    ])

    expect(lockEntries.map((e: { version: string }) => e.version)).toEqual(['1.2.3', '1.2.3'])
    expect(serverEntries[1]).toEqual({ label: 'server.json .packages.[0].version', version: '9.9.9' })
  })

  test('returns undefined version when the path is missing', () => {
    const entries = extractJsonVersions('plugin.json', '{}', [['version']])

    expect(entries[0].version).toBeUndefined()
  })
})

describe('findMismatches', () => {
  test('returns every entry that disagrees, not just the first', () => {
    const entries = [
      { label: 'a', version: '1.0.0' },
      { label: 'b', version: '2.0.0' },
      { label: 'c', version: '3.0.0' },
    ]

    const mismatches = findMismatches(entries, '1.0.0')

    expect(mismatches.map((m: { label: string }) => m.label)).toEqual(['b', 'c'])
  })

  test('returns empty array when all versions agree', () => {
    const entries = [
      { label: 'a', version: '1.0.0' },
      { label: 'b', version: '1.0.0' },
    ]

    expect(findMismatches(entries, '1.0.0')).toEqual([])
  })
})

describe('changelogHasVersion', () => {
  test('matches a keep-a-changelog style bracketed heading', () => {
    expect(changelogHasVersion('# Changelog\n\n## [0.9.0] - 2026-07-16\n', '0.9.0')).toBe(true)
  })

  test('matches a plain heading without brackets', () => {
    expect(changelogHasVersion('## 0.9.0\n', '0.9.0')).toBe(true)
  })

  test('does not match a different or superstring version', () => {
    const changelog = '## [0.9.1] - 2026-08-01\n## [0.19.0] - 2026-09-01\n'

    expect(changelogHasVersion(changelog, '0.9.0')).toBe(false)
    expect(changelogHasVersion('## [10.9.0]\n', '0.9.0')).toBe(false)
  })
})

describe('buffersEqual', () => {
  test('returns true for identical bytes and false otherwise', () => {
    expect(buffersEqual(Buffer.from('same'), Buffer.from('same'))).toBe(true)
    expect(buffersEqual(Buffer.from('same'), Buffer.from('same\n'))).toBe(false)
  })
})
