import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
// @ts-expect-error — plain .mjs script
import { agreement, buildGraderPrompt, calibrationStatus, ingestGrades, isInsideDir, parseGraderVerdict, sampleForOwner, loadRubric, runMechanical, validateEvalPaths } from '../scripts/quality-eval.mjs'
// @ts-expect-error — plain .mjs script
import { gradeCases, graderReportLine, gradingExitCode, gradingSummary, parseGradeArgs, validateGradePaths } from '../scripts/quality-grade.mjs'

const rubric = loadRubric('tests/fixtures/quality/rubrics.json')
const sampleCase = (overrides = {}) => ({ id: 'invented-case', profile: 'data', language: 'en', domain: 'invented-domain', request: 'Invent a useful answer', split: 'dev', source: 'synthetic', deliverableText: '# Answer\nInvented evidence', ...overrides })
const fence = (payload: unknown) => `${String.fromCharCode(96).repeat(3)}json\n${JSON.stringify(payload)}\n${String.fromCharCode(96).repeat(3)}`
const verdict = (quote = 'Invented evidence') => ({ status: 'success', agentMessage: fence({ items: Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`I${index}`, { result: 'pass', quote }])) }) })

describe('blind Codex grader', () => {
  it('grader prompt is blind', () => {
    // Arrange
    const item = sampleCase({ id: 'case-secret', split: 'holdout', expected: { rubric: { 'data.sourced': 'pass' } } })
    // Act
    const { prompt } = buildGraderPrompt(item, rubric, 2)
    // Assert
    expect(prompt).not.toContain('case-secret'); expect(prompt).not.toContain('holdout'); expect(prompt).not.toContain('data.sourced'); expect(prompt).not.toContain('expected'); expect(prompt).not.toMatch(/data\.|design\./)
  })

  it('rubric order depends on the seed and is deterministic', () => {
    // Arrange
    const item = sampleCase()
    // Act
    const a = buildGraderPrompt(item, rubric, 1); const b = buildGraderPrompt(item, rubric, 1); const c = buildGraderPrompt(item, rubric, 2)
    // Assert
    expect(a).toEqual(b); expect(a.prompt).not.toBe(c.prompt)
  })

  it('parseGraderVerdict rejects malformed verdicts', () => {
    // Arrange
    const keyMap = { I1: 'data.a', I2: 'data.b' }; const good = fence({ items: { I1: { result: 'pass', quote: 'yes' }, I2: { result: 'fail', quote: 'no' } } })
    // Act / Assert
    expect(parseGraderVerdict(good, keyMap)).toEqual({ 'data.a': { result: 'pass', quote: 'yes' }, 'data.b': { result: 'fail', quote: 'no' } })
    for (const text of ['', `${good}\ntext`, good.replace('"I2"', '"I3"'), good.replace('"I2"', '"I1"'), good.replace('"pass"', 'maybe'), good.replace('yes', 'x'.repeat(201)), fence({ items: {} }), `${fence({ items: {} })}${fence({ items: {} })}`, '```json\n{"items":{"I1":{"result":"pass","quote":"yes"},"I1":{"result":"fail","quote":"no"}}}\n```']) expect(() => parseGraderVerdict(text, keyMap)).toThrow()
  })

  it('agreement and calibration maths', () => {
    // Arrange
    const a = { a: 'pass', b: 'n/a', c: 'fail' }; const b = { a: 'pass', b: 'pass', c: 'pass' }
    // Act / Assert
    expect(agreement(a, b)).toEqual({ matched: 1, total: 2, rate: 0.5 }); expect(calibrationStatus(0.8)).toBe('calibrated'); expect(calibrationStatus(0)).toBe('uncalibrated')
  })

  it('sampleForOwner is deterministic per seed', () => {
    // Arrange
    const cases = [1, 2, 3, 4]
    // Act / Assert
    expect(sampleForOwner(cases, 3, 7)).toEqual(sampleForOwner(cases, 3, 7)); expect(sampleForOwner(cases, 3, 7)).not.toEqual(sampleForOwner(cases, 3, 8))
  })

  it('gradeCases handles MCP payloads, failed status, and maxRuns', async () => {
    // Arrange
    const calls: unknown[] = []; const client = { callTool: async (input: unknown) => { calls.push(input); return { content: [{ type: 'text', text: JSON.stringify(verdict()) }] } } }; const cases = [sampleCase(), sampleCase({ id: 'invented-two', deliverableText: '# Other answer\nDifferent invented evidence' })]
    // Act
    const result = await gradeCases({ cases, rubric, client, maxRuns: 1, seed: 1 }); const failed = await gradeCases({ cases: [sampleCase()], rubric, client: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'failed' }) }] }) }, maxRuns: 1 })
    // Assert
    expect(calls).toHaveLength(1); expect(JSON.stringify(calls[0])).not.toContain('model'); expect((calls[0] as { arguments: { sandbox: string } }).arguments.sandbox).toBe('read-only'); expect(result.stats.skipped).toBe(1); expect(failed.results[0].error).toContain('failed')
  })

  it('path cache hits on the second run', async () => {
    // Arrange
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'); const dir = mkdtempSync(path.join(os.tmpdir(), 'grade-cache-')); const file = path.join(dir, 'answer.md'); writeFileSync(file, 'Invented path answer'); const item = sampleCase({ deliverableText: undefined, deliverable: file }); let calls = 0; const client = { callTool: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify(verdict('Invented path answer')) }] } } }; const cache = new Map()
    try {
      // Act
      const first = await gradeCases({ cases: [item], rubric, client, cache }); const second = await gradeCases({ cases: [item], rubric, client, cache })
      // Assert
      expect(first.results[0].fresh).toBe(true); expect(second.results[0].cacheHit).toBe(true); expect(calls).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ingest merges grader results into n/a mechanical items', () => {
    // Arrange
    const item = sampleCase(); const base = [{ case: item, results: runMechanical(item) }]
    // Act
    const merged = ingestGrades(base, { 0: { 'data.answers-the-question': { result: 'pass', quote: 'Invented evidence' } } })
    // Assert
    expect(merged[0].results.find((result) => result.id === 'data.answers-the-question')?.result).toBe('pass')
  })

  it('reports grading errors and budget skips', async () => {
    // Arrange
    const client = { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'failed' }) }] }) }
    // Act
    const graded = await gradeCases({ cases: [sampleCase()], rubric, client })
    // Assert
    expect(gradingSummary(graded)).toMatchObject({ graded: 0, skipped: 0 }); expect(graderReportLine(graded)).toBe('Grader: 0 graded, 1 errors, 0 skipped'); expect(gradingExitCode(graded)).toBe(1)
  })

  it('protects holdout outputs from the repository', () => {
    // Arrange
    const base = mkdtempSync(path.join(os.tmpdir(), 'invented-quality-root-')); const nested = path.join(base, 'nested', 'future.txt'); const sibling = `${base}-bar`; const symlink = path.join(os.tmpdir(), 'invented-quality-link');
    // Act / Assert
    expect(isInsideDir(nested, base)).toBe(true); expect(isInsideDir(sibling, base)).toBe(false); expect(() => validateEvalPaths({ holdout: true, emitPrompts: path.resolve('prompt-out') })).toThrow(); expect(() => validateGradePaths({ holdout: true, cache: path.resolve('grade-cache.jsonl') })).toThrow(); expect(() => validateEvalPaths({ holdout: true, emitPrompts: os.tmpdir() })).not.toThrow()
    try { symlinkSync(base, symlink, 'junction'); expect(isInsideDir(path.join(symlink, 'file.txt'), base)).toBe(true); rmSync(symlink, { force: true }) } catch (error) { if (error instanceof Error && !error.message.includes('EPERM')) throw error } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('parseGradeArgs validates selection, values, and the run cap', () => {
    // Arrange
    const valid = ['--cases', 'invented.json', '--max-runs', '2', '--seed', '4', '--cache', 'grades.jsonl', '--report', 'report.md']
    // Act
    const parsed = parseGradeArgs(valid)
    // Assert
    expect(parsed).toMatchObject({ cases: 'invented.json', maxRuns: 2, seed: 4, cache: 'grades.jsonl', report: 'report.md' }); expect(parseGradeArgs(['--holdout']).maxRuns).toBe(6)
    for (const args of [[], ['--cases', 'a', '--holdout'], ['--cases'], ['--cases', '--seed'], ['--cases', 'a', '--max-runs', '7'], ['--cases', 'a', '--max-runs', '-1'], ['--cases', 'a', '--seed', 'x'], ['--cases', 'a', '--unknown']]) expect(() => parseGradeArgs(args)).toThrow()
  })

  it('passes parsed max-runs to gradeCases without MCP', async () => {
    // Arrange
    const options = parseGradeArgs(['--cases', 'invented.json', '--max-runs', '2']); let calls = 0; const client = { callTool: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify(verdict()) }] } } }
    // Act
    const result = await gradeCases({ cases: [sampleCase(), sampleCase({ id: 'two', deliverableText: 'Other invented text' }), sampleCase({ id: 'three', deliverableText: 'Third invented text' })], rubric, client, maxRuns: options.maxRuns })
    // Assert
    expect(calls).toBe(2); expect(result.stats.skipped).toBe(1)
  })
})
