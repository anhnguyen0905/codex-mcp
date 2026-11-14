import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { scanTrackedFiles } from '../scripts/data-guard.mjs'

const script = path.resolve('scripts/data-guard.mjs')
const hash = (token: string) => createHash('sha256').update(token.normalize('NFKC').toLowerCase()).digest('hex')
const run = (args: string[], cwd: string, env: Record<string, string>) => spawnSync(
  process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' },
)
const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd })

describe('data guard scanner', () => {
  it('catches each rule and sorts findings', () => {
    // Arrange
    const contents = new Map([
      ['z.json', '{"nested":{"items":[{"source":"real"}]}}'],
      ['quality-holdout/example.json', '{}'], ['a.txt', 'sample-app-xyz'],
    ])
    // Act
    const result = scanTrackedFiles({ files: [...contents.keys()], readFile: (file: string) => contents.get(file), denyHashes: new Set([hash('sample-app-xyz')]) })
    // Assert
    expect(result.findings).toEqual([
      { file: 'a.txt', line: 1, rule: 'denylisted-token' },
      { file: 'quality-holdout/example.json', line: 1, rule: 'holdout-path' },
      { file: 'z.json', line: 1, rule: 'real-case' },
    ])
  })

  it('catches embedded segments, phrases, normalized variants, and CRLF lines', () => {
    // Arrange
    const contents = new Map([
      ['names.txt', 'demo-app-name.events_extract\ncom.studio.secretgame'],
      ['phrases.txt', 'demo game mode'], ['variants.txt', 'ＤＥＭＯＡＰＰ'], ['lines.txt', 'safe\r\nsecretgame'],
    ])
    const denyHashes = new Set([hash('demo-app-name'), hash('secretgame'), hash('demo game'), hash('demoapp')])
    // Act
    const result = scanTrackedFiles({ files: [...contents.keys()], readFile: (file: string) => contents.get(file), denyHashes })
    // Assert
    expect(result.findings).toEqual([
      { file: 'lines.txt', line: 2, rule: 'denylisted-token' }, { file: 'names.txt', line: 1, rule: 'denylisted-token' },
      { file: 'names.txt', line: 2, rule: 'denylisted-token' }, { file: 'phrases.txt', line: 1, rule: 'denylisted-token' },
      { file: 'variants.txt', line: 1, rule: 'denylisted-token' },
    ])
  })

  it('passes clean content and reports read failures as unchecked', () => {
    // Arrange / Act
    const result = scanTrackedFiles({ files: ['clean.txt', 'gone.txt'], readFile: (file: string) => {
      if (file === 'gone.txt') throw new Error('missing'); return 'invented words'
    }, denyHashes: new Set() })
    // Assert
    expect(result.findings).toEqual([])
    expect(result.unchecked).toEqual([{ file: 'gone.txt', reason: 'missing' }])
  })
})

describe('data guard CLI', () => {
  it('adds a normalized hash once and reports binary files unchecked', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'data-guard-'))
    try {
      const denylist = path.join(cwd, 'nested', 'guard.json')
      writeFileSync(path.join(cwd, 'clean.txt'), 'invented content'); writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1]))
      git(['init', '-q'], cwd); git(['add', '.'], cwd); const env = { CODEX_MCP_DATA_GUARD: denylist }
      // Act
      const added = run(['--add', 'ＤＥＭＯＡＰＰ'], cwd, env); const duplicate = run(['--add', 'demoapp'], cwd, env); const result = run(['--json'], cwd, env)
      // Assert
      expect(added.status).toBe(0); expect(duplicate.stdout).toContain('added 0 hashes')
      expect(JSON.parse(readFileSync(denylist, 'utf8'))).toEqual({ sha256: [hash('demoapp')] })
      expect(readFileSync(denylist, 'utf8')).not.toContain('demoapp'); expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).unchecked).toEqual([{ file: 'binary.bin', reason: 'binary' }])
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it('reports malformed denylist, deleted and oversized tracked files', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'data-guard-edge-'))
    try {
      const denylist = path.join(cwd, 'guard.json'); writeFileSync(denylist, JSON.stringify({ sha256: [] }))
      writeFileSync(path.join(cwd, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97)); writeFileSync(path.join(cwd, 'gone.txt'), 'invented')
      git(['init', '-q'], cwd); git(['add', '.'], cwd); rmSync(path.join(cwd, 'gone.txt'))
      // Act
      const result = run(['--json'], cwd, { CODEX_MCP_DATA_GUARD: denylist })
      // Assert
      expect(result.status).toBe(1); expect(JSON.parse(result.stdout).unchecked).toEqual(expect.arrayContaining([
        { file: 'large.txt', reason: 'oversize' }, expect.objectContaining({ file: 'gone.txt' }),
      ]))
      expect(run([], cwd, { CODEX_MCP_DATA_GUARD: denylist }).stdout).toContain('unchecked large.txt: oversize')
      writeFileSync(denylist, '{bad'); expect(run(['--json'], cwd, { CODEX_MCP_DATA_GUARD: denylist }).status).toBe(2)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  it('handles clean trees, findings, subdirectories, and usage errors', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'data-guard-cli-'))
    try {
      const subdir = path.join(cwd, 'sub'); const denylist = path.join(cwd, 'guard.json'); writeFileSync(denylist, JSON.stringify({ sha256: [hash('sample-app-xyz')] }))
      writeFileSync(path.join(cwd, 'sample.txt'), 'sample-app-xyz'); writeFileSync(path.join(cwd, 'clean.txt'), 'invented'); git(['init', '-q'], cwd); git(['add', '.'], cwd)
      spawnSync('mkdir', ['-p', subdir])
      // Act / Assert
      expect(run(['--json'], subdir, { CODEX_MCP_DATA_GUARD: denylist }).status).toBe(1)
      writeFileSync(path.join(cwd, 'sample.txt'), 'invented'); git(['add', '.'], cwd); expect(run(['--json'], subdir, { CODEX_MCP_DATA_GUARD: denylist }).status).toBe(0)
      expect(run(['unknown'], cwd, {}).status).toBe(2); expect(run(['--json', '--add', 'x-token'], cwd, {}).status).toBe(2)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
})
