import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import {
  clearModelCache,
  modelCachePaths,
  parseConfigModel,
  readConfiguredModel,
  resolveModel,
} from '../src/modelSource.js'

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

/** Mirrors MAX_CACHED_CONFIG_PATHS in src/modelSource.ts — the documented cache bound. */
const MAX_CACHED_CONFIG_PATHS = 32

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

  test('detects a rewrite that leaves mtime and size unchanged by comparing the content hash', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act — same path, same mtime, same size, different bytes.
    rewriteWithFrozenMtime(codexHome, MODEL_B, FROZEN_MTIME)

    // Assert
    expect(readConfiguredModel({ codexHome })).toBe('model-bbb')
  })

  test('keeps one cache entry for an unchanged file across repeated calls', () => {
    // Arrange
    const codexHome = mkCodexHome()
    rewriteWithFrozenMtime(codexHome, MODEL_A, FROZEN_MTIME)

    // Act
    readConfiguredModel({ codexHome })
    readConfiguredModel({ codexHome })

    // Assert
    expect(modelCachePaths()).toEqual([join(codexHome, 'config.toml')])
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

  test('clearModelCache drops every entry and the next call still resolves the model', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act
    clearModelCache()

    // Assert
    expect(modelCachePaths()).toEqual([])
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
  })

  test('keys the cache on the resolved path, so an un-normalized codexHome hits the same entry', () => {
    // Arrange
    const codexHome = mkCodexHome()
    writeFileSync(join(codexHome, 'config.toml'), MODEL_A)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act — same file named through a redundant `sub/..` segment.
    const unnormalizedHome = join(codexHome, 'sub', '..')

    // Assert
    expect(readConfiguredModel({ codexHome: unnormalizedHome })).toBe('model-aaa')
    expect(modelCachePaths()).toEqual([join(codexHome, 'config.toml')])
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

describe('readConfiguredModel cache bounds', () => {
  test('evicts the least recently inserted path once the cap is exceeded', () => {
    // Arrange — one more distinct codex home than the cache can hold.
    const homes = Array.from({ length: MAX_CACHED_CONFIG_PATHS + 1 }, () => mkCodexHome())
    for (const home of homes) writeFileSync(join(home, 'config.toml'), MODEL_A)

    // Act
    for (const home of homes) expect(readConfiguredModel({ codexHome: home })).toBe('model-aaa')

    // Assert — the first path is gone, the remaining cap-worth are kept in insertion order.
    expect(modelCachePaths()).toEqual(homes.slice(1).map((home) => join(home, 'config.toml')))
  })

  test('re-admits an evicted path and evicts the next oldest, without losing its model', () => {
    // Arrange
    const homes = Array.from({ length: MAX_CACHED_CONFIG_PATHS + 1 }, () => mkCodexHome())
    for (const home of homes) writeFileSync(join(home, 'config.toml'), MODEL_A)
    for (const home of homes) readConfiguredModel({ codexHome: home })

    // Act — the evicted first home is read again.
    const model = readConfiguredModel({ codexHome: homes[0] })

    // Assert
    expect(model).toBe('model-aaa')
    expect(modelCachePaths()).toEqual(
      [...homes.slice(2), homes[0]].map((home) => join(home, 'config.toml')),
    )
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

  test('recovers once an unreadable config.toml becomes a readable file', () => {
    // Arrange — a directory at config.toml stats fine but cannot be read.
    const codexHome = mkCodexHome()
    const configPath = join(codexHome, 'config.toml')
    mkdirSync(configPath)
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
    expect(modelCachePaths()).toEqual([])

    // Act
    rmSync(configPath, { recursive: true, force: true })
    writeFileSync(configPath, MODEL_A)

    // Assert
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')
    expect(modelCachePaths()).toEqual([configPath])
  })

  test('drops a cached entry when the file becomes unreadable and re-caches it on recovery', () => {
    // Arrange
    const codexHome = mkCodexHome()
    const configPath = join(codexHome, 'config.toml')
    writeFileSync(configPath, MODEL_A)
    expect(readConfiguredModel({ codexHome })).toBe('model-aaa')

    // Act
    rmSync(configPath, { force: true })
    mkdirSync(configPath)

    // Assert
    expect(readConfiguredModel({ codexHome })).toBeUndefined()
    expect(modelCachePaths()).toEqual([])
    rmSync(configPath, { recursive: true, force: true })
    writeFileSync(configPath, MODEL_B)
    expect(readConfiguredModel({ codexHome })).toBe('model-bbb')
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
