import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { clearModelCache, parseConfigModel, readConfiguredModel, resolveModel } from '../src/modelSource.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const mkCodexHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-cache-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Overwrite config.toml but pin mtime and byte length to the previous values, so only a cache
 * that re-reads the file can observe the new content. Both bodies must be the same length.
 */
const rewriteWithFrozenMtime = (codexHome: string, body: string, mtime: Date): void => {
  const configPath = join(codexHome, 'config.toml')
  writeFileSync(configPath, body)
  utimesSync(configPath, mtime, mtime)
}

const FROZEN_MTIME = new Date('2026-01-01T00:00:00Z')
const MODEL_A = 'model = "model-aaa"\n'
const MODEL_B = 'model = "model-bbb"\n'

beforeEach(() => {
  clearModelCache()
})

describe('readConfiguredModel caching', () => {
  test('reads the configured model from config.toml on a cold cache', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)

    // Act
    const model = readConfiguredModel({ codexHome })

    // Assert
    expect(model).toBe('model-aaa')
  })

  test('serves the memoized model without re-reading a file whose mtime and size are unchanged', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act — same path, same mtime, same size, different bytes.
    rewriteWithFrozenMtime(codexHome, MODEL_B, FROZEN_MTIME)

    // Assert
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
  })

  test('re-reads the file when its mtime changes', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act
    rewriteWithFrozenMtime(codexHome, MODEL_B, new Date('2026-01-02T00:00:00Z'))

    // Assert
    expect(readConfiguredModel({ codexHome })).toBe('model-bbb')
  })

  test('clearModelCache forces the next call to re-read the file', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
    rewriteWithFrozenMtime(codexHome, MODEL_B, FROZEN_MTIME)

    // Act
    clearModelCache()

    // Assert
    expect(readConfiguredModel({ codexHome })).toBe('model-bbb')
  })

  test('keys the cache on the resolved path, so an un-normalized codexHome hits the same entry', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
    rewriteWithFrozenMtime(codexHome, MODEL_B, FROZEN_MTIME)

    // Act — same file named through a redundant `sub/..` segment.
    const unnormalizedHome = join(codexHome, 'sub', '..')

    // Assert
    expect(readConfiguredModel({ codexHome: unnormalizedHome })).toBe('model-aaa')
  })

  test('caches two codex homes independently', () => {
    // Arrange
    const homeA = mkCodexHome()
    const homeB = mkCodexHome()
    writeFileSync(join(homeA, 'config.toml'), MODEL_A)
    writeFileSync(join(homeB, 'config.toml'), MODEL_B)

    // Act / Assert
    expect(readConfiguredModel({ codexHome: homeA })).toBe('model-aaa')
    expect(readConfiguredModel({ codexHome: homeB })).toBe('model-bbb')
    expect(readConfiguredModel({ codexHome: homeA })).toBe('model-aaa')
  })
})

describe('readConfiguredModel failure paths', () => {
  test('returns undefined for a missing file and picks the model up once it appears', () => {
    // Arrange
    const codexHome = mkCodexHome()

    // Act / Assert — a missing file must not be cached as a permanent undefined.
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
  })

  test('returns undefined when a directory sits where config.toml should be', () => {
    // Arrange
    const codexHome = mkCodexHome()
    mkdirSync(join(codexHome, 'config.toml'))

    // Act / Assert
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
  })

  test('returns undefined for a readable config with no strict top-level model line', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), '[profiles.fast]\nmodel = "in-a-table"\n')

    // Act / Assert — repeated calls stay undefined whether cached or not.
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
  })
})

describe('parseConfigModel', () => {
  test('accepts a strict top-level model line with a trailing comment', () => {
    expect(parseConfigModel('# header\n  model = "gpt-5-codex"  # active\n')).toBe('gpt-5-codex')
  })

  test('rejects table-scoped, unquoted, and empty values', () => {
    expect(parseConfigModel('[profiles.fast]\nmodel = "in-a-table"')).toBeUndefined()
    expect(parseConfigModel('model = bare-word')).toBeUndefined()
    expect(parseConfigModel('model = ""')).toBeUndefined()
  })
})

describe('resolveModel', () => {
  test('prefers the event model over the override and the config file', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)

    // Act
    const resolved = resolveModel('from-event', 'from-override', { codexHome })

    // Assert
    expect(resolved).toEqual({ model: 'from-event', source: 'event' })
  })

  test('falls back to the config model when no event or override model exists', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)

    // Act
    const resolved = resolveModel(undefined, undefined, { codexHome })

    // Assert
    expect(resolved).toEqual({ model: 'model-aaa', source: 'config' })
  })

  test('returns undefined when no source has a usable model id', () => {
    // Arrange
    const codexHome = mkCodexHome()

    // Act / Assert
    expect(resolveModel(undefined, '   ', { codexHome })).toBeUndefined()
  })
})
