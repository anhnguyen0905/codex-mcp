import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// @ts-expect-error — plain .mjs script
import { isDirectRun } from '../scripts/direct-run.mjs'
// @ts-expect-error — plain .mjs script
import * as playbook from '../scripts/playbook.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const temps: string[] = []
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('isDirectRun', () => {
  it('imports helpers without running their CLIs', () => {
    // Arrange / Act / Assert
    expect(typeof isDirectRun).toBe('function')
    expect(typeof playbook.renderPlaybook).toBe('function')
  })

  it('handles direct, different, missing, empty, and invalid inputs', () => {
    // Arrange
    const file = path.join(root, 'scripts/direct-run.mjs')
    // Act / Assert
    expect(isDirectRun(pathToFileURL(file).href, file)).toBe(true)
    expect(isDirectRun(pathToFileURL(file).href, path.join(root, 'package.json'))).toBe(false)
    expect(isDirectRun(pathToFileURL(file).href, undefined)).toBe(false)
    expect(isDirectRun(pathToFileURL(file).href, '')).toBe(false)
    expect(() => isDirectRun(pathToFileURL(file).href, path.join(root, 'missing-file'))).not.toThrow()
    expect(() => isDirectRun('', file)).toThrow(TypeError)
    expect(() => isDirectRun(42 as unknown as string, file)).toThrow(TypeError)
  })

  it.skipIf(process.platform === 'win32')('runs through a symlinked directory', () => {
    // Arrange
    const dir = mkdtempSync(path.join(os.tmpdir(), 'direct-run-'))
    temps.push(dir)
    const copy = path.join(dir, 'copy')
    const link = path.join(dir, 'link')
    mkdirSync(copy)
    cpSync(path.join(root, 'scripts/direct-run.mjs'), path.join(copy, 'direct-run.mjs'))
    cpSync(path.join(root, 'scripts/playbook.mjs'), path.join(copy, 'playbook.mjs'))
    cpSync(path.join(root, 'scripts/harness-taxonomy.mjs'), path.join(copy, 'harness-taxonomy.mjs'))
    symlinkSync(copy, link, 'dir')
    // Act
    const result = spawnSync(process.execPath, [path.join(link, 'playbook.mjs'), '__bogus__'], { encoding: 'utf8' })
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })

  it('finds no inline guards', () => {
    // Arrange
    const files = readdirSync(path.join(root, 'scripts'))
    // Act / Assert
    for (const name of files.filter((entry) => entry.endsWith('.mjs') && entry !== 'direct-run.mjs')) {
      const text = readFileSync(path.join(root, 'scripts', name), 'utf8')
      expect(text).not.toMatch(/import\.meta\.url\s*===\s*pathToFileURL\(/)
      if (text.includes('process.argv[1]')) expect(text).toContain("from './direct-run.mjs'")
    }
  })
})
