import { describe, expect, test } from 'vitest'

import { canonicalPath } from '../src/pathCanonical.js'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { canonicalPath as scriptCanonicalPath } from '../scripts/scope-check.mjs'

/** Paths that exercise every fold (and every deliberate non-fold) the two copies must share. */
const SHARED_VECTOR: readonly string[] = [
  './a',
  'a//b',
  '/abs/x',
  'src\\a.ts',
  'src/a.ts',
  'SRC/A.ts',
  'Src/Nested/./B.TS',
  ' src/a.ts',
  'src/a.ts ',
  'src/../secret.ts',
  './',
  '/',
  '',
  'a/./b//c/',
  'tests\\nested\\a.test.ts',
]

const PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32']

describe('canonicalPath', () => {
  test('drops "." segments, collapses repeated separators, and keeps the leading slash', () => {
    // Arrange
    const platform: NodeJS.Platform = 'linux'

    // Act & Assert
    expect(canonicalPath('./a', platform)).toBe('a')
    expect(canonicalPath('a//b', platform)).toBe('a/b')
    expect(canonicalPath('a/./b//c/', platform)).toBe('a/b/c')
    expect(canonicalPath('/abs/x', platform)).toBe('/abs/x')
  })

  test('folds case on darwin and win32 but not on linux', () => {
    expect(canonicalPath('SRC/A.ts', 'linux')).toBe('SRC/A.ts')
    expect(canonicalPath('SRC/A.ts', 'darwin')).toBe('src/a.ts')
    expect(canonicalPath('SRC/A.ts', 'win32')).toBe('src/a.ts')
  })

  test('treats backslash as a separator on win32 only, so a posix backslash name stays distinct', () => {
    expect(canonicalPath('src\\a.ts', 'win32')).toBe('src/a.ts')
    expect(canonicalPath('src\\a.ts', 'linux')).toBe('src\\a.ts')
  })

  test('preserves whitespace and unresolved ".." segments so they never fold onto a real path', () => {
    expect(canonicalPath(' src/a.ts', 'linux')).toBe(' src/a.ts')
    expect(canonicalPath('src/a.ts ', 'linux')).toBe('src/a.ts ')
    expect(canonicalPath('src/../secret.ts', 'linux')).toBe('src/../secret.ts')
    expect(canonicalPath('src/../secret.ts', 'linux')).not.toBe('secret.ts')
  })

  test('canonicalizes a path that is only separators and dots to the empty or root path', () => {
    expect(canonicalPath('', 'linux')).toBe('')
    expect(canonicalPath('./', 'linux')).toBe('')
    expect(canonicalPath('/', 'linux')).toBe('/')
  })

  test('rejects a non-string path instead of coercing it', () => {
    // Arrange
    const notAPath = 42 as unknown as string

    // Act & Assert
    expect(() => canonicalPath(notAPath, 'linux')).toThrow(TypeError)
  })

  test('defaults to the host platform when none is given', () => {
    expect(canonicalPath('./a')).toBe(canonicalPath('./a', process.platform))
  })
})

describe('canonicalPath parity with scripts/scope-check.mjs', () => {
  test.each(PLATFORMS)('matches the script byte-for-byte over the shared vector on %s', (platform) => {
    // Arrange
    const vector = SHARED_VECTOR

    // Act
    const fromSource = vector.map((filePath) => canonicalPath(filePath, platform))
    const fromScript = vector.map((filePath) => scriptCanonicalPath(filePath, platform))

    // Assert
    expect(fromSource).toEqual(fromScript)
  })

  test('both copies reject a non-string path', () => {
    const notAPath = null as unknown as string

    expect(() => canonicalPath(notAPath, 'linux')).toThrow(TypeError)
    expect(() => scriptCanonicalPath(notAPath, 'linux')).toThrow(TypeError)
  })
})
