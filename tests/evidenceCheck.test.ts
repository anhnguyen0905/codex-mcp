import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import {
  checkManifest,
  defaultTolerance,
  findUndeclaredNumbers,
  sampleClaims,
} from '../scripts/evidence-check.mjs'

const script = fileURLToPath(new URL('../scripts/evidence-check.mjs', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/evidence/', import.meta.url))
const fixture = (name: string): string => path.join(fixtureDir, name)

const runCli = (args: string[], cwd = fixtureDir) => spawnSync(
  process.execPath, [script, ...args], { cwd, encoding: 'utf8' },
)

const claims = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `C${index + 1}`,
  text: `Claim ${index + 1}`,
  sources: [`F1`],
}))

const tempManifest = (
  prefix: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), prefix))
  writeFileSync(path.join(cwd, 'deliverable.md'), 'The value is 1.\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(cwd, name), content)
  const manifestPath = path.join(cwd, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return manifestPath
}

describe('evidence checker seeded suite', () => {
  it.each([
    ['wrong-number.json', 'figure-mismatch'],
    ['unsourced.json', 'claim-unsourced'],
    ['broken.json', 'figure-command-failed'],
    ['undeclared.json', 'undeclared-number'],
  ])('catches the defect in %s', (manifest, check) => {
    // Arrange
    const args = ['--manifest', fixture(manifest), '--json']
    // Act
    const result = runCli(args)
    const output = JSON.parse(result.stdout)
    // Assert
    expect(result.status).toBe(1)
    expect(output.status).toBe('fail')
    expect(output.findings.map((finding: { check: string }) => finding.check)).toContain(check)
    if (manifest === 'broken.json') {
      expect(output.findings.map((finding: { check: string }) => finding.check))
        .toContain('source-missing')
    }
  })

  it('passes the clean manifest and lists unchecked owner work', () => {
    // Arrange / Act
    const result = runCli(['--manifest', fixture('clean.json'), '--json'])
    const output = JSON.parse(result.stdout)
    // Assert
    expect(result.status).toBe(0)
    expect(output).toMatchObject({ status: 'pass', findings: [] })
    expect(output.unchecked).toEqual([
      'claim meaning (owner sampling)', 'https://example.com/revenue',
    ])
  })

  it('rejects a schema error before a marker command can run', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'evidence-schema-'))
    const marker = path.join(cwd, 'marker.txt')
    const manifest = path.join(cwd, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 2,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: `node -e "require('fs').writeFileSync('${marker}', 'x')"` }],
      claims: [],
    }))
    // Act
    const result = runCli(['--manifest', manifest], cwd)
    // Assert
    expect(result.status).toBe(2)
    expect(() => readFileSync(marker)).toThrow()
  })

  it('reports a real timeout without treating it as a command failure', () => {
    // Arrange
    const manifest = tempManifest('evidence-timeout-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: 'node slow.mjs', timeoutMs: 100 }],
      claims: [],
    }, { 'slow.mjs': 'setTimeout(() => {}, 1000)\n' })
    // Act
    const result = checkManifest(manifest)
    // Assert
    expect(result.findings[0]).toMatchObject({ check: 'figure-timeout', id: 'F1' })
  })

  it('reports ENOBUFS as a command failure instead of a timeout', () => {
    // Arrange
    const manifest = tempManifest('evidence-overflow-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: 'node noisy.mjs' }],
      claims: [],
    })
    const run = vi.fn(() => ({
      status: null, signal: 'SIGTERM', error: { code: 'ENOBUFS' }, stdout: 'x',
    }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings[0]).toMatchObject({ check: 'figure-command-failed', id: 'F1' })
  })

  it('reports non-numeric figure output', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'evidence-numeric-'))
    writeFileSync(path.join(cwd, 'deliverable.md'), 'No figures.\n')
    const manifest = path.join(cwd, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: 'node print.mjs' }],
      claims: [],
    }))
    const run = vi.fn(() => ({ status: 0, stdout: 'not a number\n', stderr: '' }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings).toContainEqual(expect.objectContaining({ check: 'figure-not-numeric' }))
  })

  it('uses half a unit in the last decimal place by default', () => {
    // Arrange / Act / Assert
    expect(defaultTolerance('12.30')).toBe(0.005)
    expect(defaultTolerance(12.3)).toBe(0.05)
    expect(defaultTolerance(42)).toBe(0.5)
  })

  it('accepts values inside the default and explicit tolerance', () => {
    // Arrange
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'evidence-tolerance-'))
    writeFileSync(path.join(cwd, 'deliverable.md'), 'Values 12.30 and 42.\n')
    const manifest = path.join(cwd, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [
        { id: 'F1', value: '12.30', command: 'node precise.mjs' },
        { id: 'F2', value: 42, command: 'node whole.mjs', tolerance: 1 },
      ],
      claims: [],
    }))
    const run = vi.fn((command: string) => ({
      status: 0, stdout: command.includes('precise') ? '12.304\n' : '42.8\n', stderr: '',
    }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings).toEqual([])
  })

  it('uses numeric value precision instead of display precision for tolerance', () => {
    // Arrange
    const manifest = tempManifest('evidence-display-tolerance-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 42, display: ['42.0'], command: 'node value.mjs' }],
      claims: [],
    })
    writeFileSync(path.join(path.dirname(manifest), 'deliverable.md'), 'The value is 42.0.\n')
    const run = vi.fn(() => ({ status: 0, stdout: '42.4\n', stderr: '' }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings).toEqual([])
  })

  it('uses string value precision when the written value is decimal', () => {
    // Arrange
    const manifest = tempManifest('evidence-display-tolerance-string-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: '42.0', display: ['42.0'], command: 'node value.mjs' }],
      claims: [],
    })
    writeFileSync(path.join(path.dirname(manifest), 'deliverable.md'), 'The value is 42.0.\n')
    const run = vi.fn(() => ({ status: 0, stdout: '42.4\n', stderr: '' }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings).toContainEqual(expect.objectContaining({ check: 'figure-mismatch' }))
  })

  it('excludes dates, times, list markers, identifiers, and code', () => {
    // Arrange
    const text = [
      '2026-11-13T12:30:00Z 13/11/2026 12:30, in 2025',
      '1. list marker F1 C2 R1.2 T3 v0.33.0',
      'Inline `777` and ``` 888 ``` are ignored.',
      'The undeclared number is 99.',
    ].join('\n')
    // Act
    const actual = findUndeclaredNumbers(text, [{ value: 42 }])
    // Assert
    expect(actual).toEqual(['99'])
  })

  it('excludes Vietnamese month/year dates', () => {
    // Arrange
    const text = '# Báo cáo doanh thu tháng 10/2026'
    // Act
    const actual = findUndeclaredNumbers(text, [])
    // Assert
    expect(actual).toEqual([])
  })

  it('excludes year/month dates', () => {
    // Arrange
    const text = 'Revenue report for 2026-10'
    // Act
    const actual = findUndeclaredNumbers(text, [])
    // Assert
    expect(actual).toEqual([])
  })

  it('keeps ordinary fractions as separate undeclared numbers', () => {
    // Arrange
    const text = '3/4 of users, or 12/40 in the sample'
    // Act
    const actual = findUndeclaredNumbers(text, [])
    // Assert
    expect(actual).toEqual(['3', '4', '12', '40'])
  })

  it.each([
    ['1,234,567', 1234567],
    ['1.234.567', 1234567],
    ['12,3%', 0.123],
    ['1.234,5', 1234.5],
  ])('treats %s as one formatted numeric literal', (literal, value) => {
    // Arrange
    const text = `Revenue was ${literal}.`
    // Act
    const declared = findUndeclaredNumbers(text, [{ value, display: [literal] }])
    const undeclared = findUndeclaredNumbers(text, [{ value }])
    // Assert
    expect(declared).toEqual([])
    expect(undeclared).toEqual([literal])
  })

  it('honors display and ignoreNumbers declarations', () => {
    // Arrange
    const text = 'Shown 1, ignored 2, and missing 3.'
    // Act
    const actual = findUndeclaredNumbers(text, {
      figures: [{ value: 1, display: ['1'] }], ignoreNumbers: ['2'],
    })
    // Assert
    expect(actual).toEqual(['3'])
  })

  it('samples deterministically and returns every claim when count is larger', () => {
    // Arrange
    const allClaims = claims(40)
    // Act
    const first = sampleClaims(allClaims, 8, 17)
    const same = sampleClaims(allClaims, 8, 17)
    const different = sampleClaims(allClaims, 8, 18)
    const all = sampleClaims(allClaims, 100, 17)
    // Assert
    expect(same).toEqual(first)
    expect(different).not.toEqual(first)
    expect(all).toHaveLength(allClaims.length)
  })

  it('reports missing files and lines beyond EOF as source-missing', () => {
    // Arrange
    const manifest = tempManifest('evidence-source-missing-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: 'node sum.mjs' }],
      claims: [{ id: 'C1', text: 'A claim', sources: ['missing.csv:1', 'source.csv:3'] }],
    }, { 'source.csv': 'a\nb\n' })
    const run = vi.fn(() => ({ status: 0, stdout: '1\n', stderr: '' }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings.filter((finding) => finding.check === 'source-missing')).toHaveLength(2)
  })

  it('reports a source that names an undeclared figure', () => {
    // Arrange
    const manifest = tempManifest('evidence-source-figure-', {
      schemaVersion: 1,
      deliverable: 'deliverable.md',
      figures: [{ id: 'F1', value: 1, command: 'node sum.mjs' }],
      claims: [{ id: 'C1', text: 'A claim', sources: ['F2'] }],
    })
    const run = vi.fn(() => ({ status: 0, stdout: '1\n', stderr: '' }))
    // Act
    const result = checkManifest(manifest, { run })
    // Assert
    expect(result.findings).toContainEqual(expect.objectContaining({ check: 'source-unknown-figure' }))
  })

  it('uses the same fixed check count for clean and mismatched figures', () => {
    // Arrange / Act
    const clean = JSON.parse(runCli(['--manifest', fixture('clean.json'), '--json']).stdout)
    const wrong = JSON.parse(runCli(['--manifest', fixture('wrong-number.json'), '--json']).stdout)
    // Assert
    expect(clean.checks).toBe(wrong.checks)
  })

  it('prints the JSON contract and a seeded claim sample', () => {
    // Arrange / Act
    const result = runCli([
      '--manifest', fixture('clean.json'), '--json', '--sample', '3', '--seed', '9',
    ])
    const output = JSON.parse(result.stdout)
    // Assert
    expect(result.status).toBe(0)
    expect(output).toMatchObject({
      status: 'pass',
      findings: [],
      sample: expect.any(Array),
    })
    expect(output.checks).toEqual(expect.any(Number))
    expect(output.sample).toHaveLength(1)
    expect(output.sample[0]).toEqual({
      id: 'C1', text: 'Revenue totals 42.', sources: ['F1', 'data.csv:2', 'https://example.com/revenue'],
    })
  })
})
