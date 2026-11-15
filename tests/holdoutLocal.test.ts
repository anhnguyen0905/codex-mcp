import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { holdoutDir } from '../scripts/quality-eval.mjs'

type HoldoutCase = {
  id: string
  profile: 'data'
  language: 'en'
  domain: string
  request: string
  split: 'holdout'
  source: 'synthetic'
  deliverable: string
}

const script = path.resolve('scripts/quality-eval.mjs')

function syntheticHoldout(dir: string): { manifest: string; firstFile: string; cases: HoldoutCase[]; content: string[] } {
  const cases: HoldoutCase[] = [
    { id: 'synthetic-alpha', profile: 'data', language: 'en', domain: 'invented-alpha', request: 'Describe the invented alpha outcome', split: 'holdout', source: 'synthetic', deliverable: 'first.txt' },
    { id: 'synthetic-beta', profile: 'data', language: 'en', domain: 'invented-beta', request: 'Summarize the invented beta outcome', split: 'holdout', source: 'synthetic', deliverable: 'second.txt' },
  ]
  const content = ['Distinctive alpha deliverable text', 'Distinctive beta deliverable text']
  writeFileSync(path.join(dir, 'first.txt'), content[0])
  writeFileSync(path.join(dir, 'second.txt'), content[1])
  writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases }))
  return { manifest: path.join(dir, 'manifest.json'), firstFile: path.join(dir, 'first.txt'), cases, content }
}

function containsAnyTwelveCharWindow(output: string, values: string[]): boolean {
  return values.some((value) => Array.from({ length: Math.max(0, value.length - 11) }, (_, index) => value.slice(index, index + 12)).some((part) => output.includes(part)))
}

function runHoldout(dir: string, manifest: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, '--holdout', ...args, '--manifest', manifest], {
    env: { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir },
    encoding: 'utf8',
  })
}

describe('local holdout frozen check', () => {
  it('detects a mutated deliverable without quoting synthetic content', () => {
    // Arrange
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quality-holdout-local-'))
    try {
      const { manifest, firstFile, cases, content } = syntheticHoldout(dir)
      // Act
      const frozen = runHoldout(dir, manifest, ['--freeze', '--approve', 'invented approval'])
      const clean = runHoldout(dir, manifest, ['--check-frozen'])
      const mutatedContent = 'Changed alpha deliverable content'
      writeFileSync(firstFile, mutatedContent)
      const changedDeliverable = runHoldout(dir, manifest, ['--check-frozen'])

      // Assert
      expect(frozen.status).toBe(0)
      expect(clean.status).toBe(0)
      expect(changedDeliverable.status).toBe(1)
      const changedOutput = `${changedDeliverable.stdout}${changedDeliverable.stderr}`
      expect(changedOutput).toContain('changed:synthetic-alpha')
      expect(containsAnyTwelveCharWindow(changedOutput, [...cases.map((item) => item.request), ...content, mutatedContent])).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects a mutated case field without quoting synthetic content', () => {
    // Arrange
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quality-holdout-local-'))
    try {
      const { manifest, cases, content } = syntheticHoldout(dir)
      const frozen = runHoldout(dir, manifest, ['--freeze', '--approve', 'invented approval'])
      const mutatedRequest = 'Mutated alpha request field'
      writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: [{ ...cases[0], request: mutatedRequest }, cases[1]] }))

      // Act
      const changedCase = runHoldout(dir, manifest, ['--check-frozen'])

      // Assert
      expect(frozen.status).toBe(0)
      expect(changedCase.status).toBe(1)
      const changedOutput = `${changedCase.stdout}${changedCase.stderr}`
      expect(changedOutput).toContain('changed:synthetic-alpha')
      expect(containsAnyTwelveCharWindow(changedOutput, [...cases.map((item) => item.request), ...content, mutatedRequest])).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!existsSync(path.join(holdoutDir(), 'cases.json')))('real holdout frozen check', () => {
  it('passes the frozen check without exposing requests', () => {
    // Arrange
    const casesPath = path.join(holdoutDir(), 'cases.json')
    const cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases as Array<{ request: string }>

    // Act
    const result = spawnSync(process.execPath, [script, '--holdout', '--check-frozen'], { encoding: 'utf8' })

    // Assert
    const output = `${result.stdout}${result.stderr}`
    const leakCount = cases.reduce((count, item) => count + (containsAnyTwelveCharWindow(output, [item.request]) ? 1 : 0), 0)
    expect(result.status).toBe(0)
    expect(leakCount).toBe(0)
  })
})
