import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { buildGraderPrompt, caseHash, checkHoldoutFrozen, filterCases, freezeHoldout, holdoutManifest, ingestGradeLines, loadRubric, renderReport, rubricIds, runMechanical, scoreCase, summarize, UsageError, validateCases, validateManifest } from '../scripts/quality-eval.mjs'

const rubricFile = path.resolve('tests/fixtures/quality/rubrics.json')
const rubric = loadRubric(rubricFile)
const goodCase = (overrides = {}) => ({ id: 'demo-one', profile: 'data', language: 'en', domain: 'invented', request: 'Measure invented outcomes', split: 'dev', source: 'synthetic', deliverableText: 'invented result', ...overrides })
const temp = () => mkdtempSync(path.join(os.tmpdir(), 'quality-eval-'))

describe('quality evaluation core', () => {
  it('rubric ids match the profile skills', () => {
    // Arrange
    const expected = { data: ['reproducible', 'sourced', 'answers-the-question', 'decision-useful', 'language-consistent'], design: [], plan: [], content: [] }
    for (const profile of ['design', 'plan', 'content'] as const) {
      const text = readFileSync(`skills/profile-${profile}/SKILL.md`, 'utf8')
      expected[profile] = [...text.matchAll(/^- `([^`]+)` —/gm)].map((match) => match[1])
    }
    // Act / Assert
    for (const profile of ['data', 'design', 'plan', 'content'] as const) expect(rubricIds(rubric, profile)).toEqual(expected[profile].map((id) => `${profile}.${id}`))
  })

  it('validateCases rejects bad cases', () => {
    // Arrange
    const bad = [goodCase({ extra: true }), goodCase({ language: 'fr' }), goodCase({ deliverable: 'x' }), goodCase({ expected: { rubric: { 'data.nope': 'pass' } } }), goodCase({ source: 'real' })]
    // Act / Assert
    for (const item of bad) expect(() => validateCases([item], rubric)).toThrow(/demo-one|#1/)
    expect(() => validateCases([goodCase(), goodCase()], rubric)).toThrow(/duplicate id/)
    expect(validateCases([goodCase()], rubric)).toHaveLength(1)
  })

  it('filterCases filters by split, language, profile and domain', () => {
    // Arrange
    const cases = [goodCase(), goodCase({ id: 'two', split: 'holdout', language: 'vi', profile: 'plan', domain: 'other' })]
    // Act / Assert
    expect(filterCases(cases, { split: 'holdout', language: 'vi', profile: 'plan', domain: 'other' })).toHaveLength(1)
  })

  it('holdout freeze detects edited, added and removed cases', () => {
    // Arrange
    const dir = temp(); const file = path.join(dir, 'deliverable.txt'); writeFileSync(file, 'alpha')
    try {
      const first = [goodCase({ id: 'one', split: 'holdout', source: 'synthetic', deliverable: file })]
      const manifest = holdoutManifest(first, (name: string) => readFileSync(name))
      writeFileSync(file, 'beta')
      const changed = checkHoldoutFrozen([first[0], goodCase({ id: 'two', split: 'holdout', source: 'synthetic', deliverableText: 'new' })], manifest, (name: string) => readFileSync(name))
      expect(changed.changes).toEqual(expect.arrayContaining([{ id: 'one', kind: 'changed' }, { id: 'two', kind: 'added' }]))
      expect(checkHoldoutFrozen([], manifest).changes).toEqual([{ id: 'one', kind: 'removed' }])
      expect(checkHoldoutFrozen([first[0]], freezeHoldout([first[0]], (name: string) => readFileSync(name), manifest, 'invented approval'), (name: string) => readFileSync(name)).ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('an edit after the initial freeze is still detected', () => {
    // Arrange
    const dir = temp(); const file = path.join(dir, 'frozen.txt'); writeFileSync(file, 'first')
    try {
      const cases = [goodCase({ id: 'frozen-one', split: 'holdout', deliverable: file })]
      const manifest = freezeHoldout(cases, (name: string) => readFileSync(name), undefined, 'initial freeze')
      writeFileSync(file, 'edited')
      // Act
      const result = checkHoldoutFrozen(cases, manifest, (name: string) => readFileSync(name))
      // Assert
      expect(result).toEqual({ ok: false, changes: [{ id: 'frozen-one', kind: 'changed' }] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('editing a holdout deliverableText is detected', () => {
    // Arrange
    const initial = [goodCase({ id: 'text-one', split: 'holdout' })]
    const manifest = freezeHoldout(initial, undefined, undefined, 'initial freeze')
    const edited = [{ ...initial[0], deliverableText: 'edited invented result' }]
    // Act / Assert
    expect(checkHoldoutFrozen(edited, manifest).changes).toEqual([{ id: 'text-one', kind: 'changed' }])
  })

  it('rejects malformed manifests and quoted approval notes', () => {
    // Arrange
    const cases = [goodCase({ id: 'manifest-one', split: 'holdout' })]
    const manifest = freezeHoldout(cases, undefined, undefined, 'initial freeze')
    // Act / Assert
    expect(() => validateManifest({ ...manifest, count: 2 })).toThrow()
    expect(() => validateManifest({ ...manifest, cases: [...manifest.cases, manifest.cases[0]] })).toThrow()
    expect(() => validateManifest({ ...manifest, cases: [{ ...manifest.cases[0], sha256: 'bad' }] })).toThrow()
    expect(() => freezeHoldout(cases, undefined, undefined, 'Measure invented outcomes')).toThrow()
    const dir = temp(); const manifestFile = path.join(dir, 'manifest.json'); writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases })); writeFileSync(manifestFile, JSON.stringify({ ...manifest, count: 2 }))
    try {
      const env = { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }
      const malformed = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--check-frozen', '--manifest', manifestFile], { env, encoding: 'utf8' })
      const quoted = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--freeze', '--approve', 'Measure invented outcomes', '--manifest', manifestFile], { env, encoding: 'utf8' })
      expect(malformed.status).toBe(2); expect(quoted.status).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a rubric with a duplicate id', () => {
    // Arrange
    const dir = temp(); const file = path.join(dir, 'duplicate-rubric.json'); const duplicate = JSON.parse(JSON.stringify(rubric)); duplicate.profiles.plan[0].id = duplicate.profiles.data[0].id
    try {
      writeFileSync(file, JSON.stringify(duplicate))
      // Act / Assert
      expect(() => loadRubric(file)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CLI freezes, detects, and re-freezes holdout changes', () => {
    // Arrange
    const dir = temp(); const script = path.resolve('scripts/quality-eval.mjs'); const manifest = path.join(dir, 'manifest.json')
    const deliverable = path.join(dir, 'answer.txt'); writeFileSync(deliverable, 'first')
    writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: [goodCase({ id: 'cli-one', split: 'holdout', deliverable: 'answer.txt', deliverableText: undefined })] }))
    const env = { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    try {
      // Act / Assert
      expect(run(['--holdout', '--freeze', '--approve', 'x', '--manifest', manifest]).status).toBe(0)
      expect(run(['--holdout', '--check-frozen', '--manifest', manifest]).status).toBe(0)
      writeFileSync(deliverable, 'second')
      const changed = run(['--holdout', '--check-frozen', '--manifest', manifest])
      expect(changed.status).toBe(1); expect(changed.stderr).toContain('cli-one')
      expect(run(['--holdout', '--freeze', '--approve', 'y', '--manifest', manifest]).status).toBe(0)
      expect(run(['--holdout', '--check-frozen', '--manifest', manifest]).status).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reading the holdout requires --holdout and logs each look', () => {
    // Arrange
    const dir = temp(); const script = path.resolve('scripts/quality-eval.mjs')
    try { writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: [] }))
      const env = { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }
      // Act / Assert
      expect(spawnSync(process.execPath, [script, '--cases', path.join(dir, 'cases.json')], { env, encoding: 'utf8' }).status).toBe(0)
      expect(spawnSync(process.execPath, [script, '--holdout'], { env, encoding: 'utf8' }).status).toBe(0)
      expect(readFileSync(path.join(dir, 'looks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the manifest carries no case text', () => {
    // Arrange / Act
    const manifest = holdoutManifest([goodCase()])
    // Assert
    expect(JSON.stringify(manifest)).not.toContain('Measure invented outcomes')
    expect(JSON.stringify(manifest)).not.toContain('invented result')
  })

  it('freeze without --approve exits 2', () => {
    // Arrange / Act
    const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--freeze'], { encoding: 'utf8' })
    // Assert
    expect(result.status).toBe(2)
  })

  it('usage errors exit 2', () => {
    // Arrange / Act / Assert
    expect(spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--unknown'], { encoding: 'utf8' }).status).toBe(2)
    expect(spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--cases'], { encoding: 'utf8' }).status).toBe(2)
  })

  it('runMechanical scores heading items for design, plan and content', () => {
    // Arrange
    const cases = [
      goodCase({ profile: 'design', deliverableText: '# Goal and fantasy\n## Core loop\n## System\n## Economy balance\n## Risks\n## KPIs' }),
      goodCase({ profile: 'plan', deliverableText: '# Objective\n## Milestones\n## Owners and capacity\n## Risks' }),
      goodCase({ profile: 'content', deliverableText: '# Audience\n## Message\n## Voice\n## CTA' }),
    ]
    // Act
    const results = cases.map((item) => runMechanical(item))
    // Assert
    for (const result of results) expect(result.filter((item) => item.result === 'fail')).toHaveLength(0)
    expect(runMechanical(goodCase({ profile: 'content', deliverableText: '# Contact' })).find((item) => item.id === 'content.cta')?.result).toBe('fail')
  })

  it('runMechanical uses evidence and language checks for data', () => {
    // Arrange
    const dir = temp(); const file = path.join(dir, 'answer.md'); const manifest = path.join(dir, 'manifest.json')
    writeFileSync(file, '# Result\n<!--F1:4-->'); writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, deliverable: 'answer.md', figures: [{ id: 'F1', value: 4, command: 'value' }], claims: [{ id: 'C1', text: 'result', sources: ['F1'] }] }))
    const run = () => ({ status: 0, stdout: '4\n', stderr: '' })
    try {
      const item = goodCase({ manifest: 'manifest.json', deliverableText: undefined, deliverable: 'answer.md' })
      // Act
      const passing = runMechanical(item, { baseDir: dir, run })
      // Assert
      expect(passing.find((result) => result.id === 'data.reproducible')?.result).toBe('pass')
      writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, deliverable: 'answer.md', figures: [{ id: 'F1', value: 4, command: 'value' }], claims: [{ id: 'C1', text: 'result', sources: [] }] }))
      const sourcing = runMechanical(item, { baseDir: dir, run })
      expect(sourcing.find((result) => result.id === 'data.reproducible')?.result).toBe('pass')
      expect(sourcing.find((result) => result.id === 'data.sourced')?.result).toBe('fail')
      writeFileSync(file, '# Result\nThe result is 5.')
      expect(runMechanical(item, { baseDir: dir, run }).find((result) => result.id === 'data.reproducible')?.result).toBe('fail')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('judgment items are n/a with a reason', () => {
    // Arrange
    const result = runMechanical(goodCase()).find((item) => item.id === 'data.answers-the-question')
    // Act / Assert
    expect(result).toEqual({ id: 'data.answers-the-question', result: 'n/a', reason: 'needs grader' })
  })

  it('scoreCase ignores n/a and returns null when nothing is scorable', () => {
    // Arrange
    // Act / Assert
    expect(scoreCase([{ result: 'pass' }, { result: 'fail' }, { result: 'n/a' }])).toEqual({ pass: 1, fail: 1, na: 1, rubricPct: 0.5 })
    expect(scoreCase([{ result: 'n/a' }])).toEqual({ pass: 0, fail: 0, na: 1, rubricPct: null })
    expect(() => scoreCase([{ result: 'unexpected' }])).toThrow('invalid mechanical result')
  })

  it('summarize computes cell means', () => {
    // Arrange
    const item = goodCase({ profile: 'content' }); const results = [{ case: item, results: [{ id: 'content.audience', result: 'pass' }, { id: 'content.language-consistent', result: 'pass' }], score: { pass: 2, fail: 0, na: 0, rubricPct: 1 } }, { case: item, results: [{ id: 'content.audience', result: 'fail' }, { id: 'content.language-consistent', result: 'fail' }], score: { pass: 0, fail: 2, na: 0, rubricPct: 0 } }]
    // Act / Assert
    expect(summarize(results)['content|en']).toMatchObject({ n: 2, rubricPct: 0.5, languagePassPct: 0.5 })
  })

  it('renderReport contains aggregates only', () => {
    // Arrange / Act
    const report = renderReport({ 'data|en': { profile: 'data', language: 'en', n: 1, rubricPct: 0.5, evidencePassPct: 1, languagePassPct: 1 } }, { generatedTs: 'now', split: 'dev', inputSha256: 'hash', caseCount: 1 })
    // Assert
    expect(report).toContain('Rubric %'); expect(report).not.toContain('demo-one'); expect(report).not.toContain('Measure invented outcomes'); expect(report).not.toContain('invented result')
  })

  it('CLI --report writes the report for dev cases', () => {
    // Arrange
    const dir = temp(); const casesFile = path.join(dir, 'cases.json'); const report = path.join(dir, 'report.md')
    try {
      writeFileSync(casesFile, JSON.stringify({ cases: [goodCase()] }))
      const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--cases', casesFile, '--split', 'dev', '--report', report], { encoding: 'utf8' })
      // Act / Assert
      expect(result.status).toBe(0); expect(readFileSync(report, 'utf8')).toContain('# Quality evaluation report')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CLI --emit-prompts writes prompts and a keymap for each case', () => {
    // Arrange
    const dir = temp(); const casesFile = path.join(dir, 'cases.json'); const output = path.join(dir, 'prompts')
    const cases = [goodCase({ id: 'prompt-one' }), goodCase({ id: 'prompt-two', request: 'Explain invented totals' })]
    try {
      writeFileSync(casesFile, JSON.stringify({ cases }))
      // Act
      const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--cases', casesFile, '--emit-prompts', output], { encoding: 'utf8' })
      // Assert
      expect(result.status).toBe(0)
      expect(readFileSync(path.join(output, '0.prompt.txt'), 'utf8')).toContain('Measure invented outcomes')
      expect(readFileSync(path.join(output, '0.prompt.txt'), 'utf8')).not.toContain('data.')
      expect(readFileSync(path.join(output, '1.prompt.txt'), 'utf8')).toContain('Explain invented totals')
      expect(readFileSync(path.join(output, 'keymap.json'), 'utf8')).toBeTruthy()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CLI --holdout rejects repository prompt output but allows a temporary directory', () => {
    // Arrange
    const dir = temp(); const repoTarget = path.resolve('tmp-emit-should-not-exist'); const tempTarget = path.join(dir, 'prompts')
    const cases = [{ ...goodCase({ id: 'holdout-prompt', split: 'holdout' }), deliverableText: 'synthetic holdout answer' }]
    writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases }))
    const env = { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }
    try {
      // Act
      const rejected = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--emit-prompts', repoTarget], { env, encoding: 'utf8' })
      const accepted = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--emit-prompts', tempTarget], { env, encoding: 'utf8' })
      // Assert
      expect(rejected.status).toBe(2); expect(existsSync(repoTarget)).toBe(false)
      expect(accepted.status).toBe(0); expect(existsSync(path.join(tempTarget, '0.prompt.txt'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repoTarget, { recursive: true, force: true }) }
  })

  it('CLI --ingest-grades changes the report rubric percentage', () => {
    // Arrange
    const dir = temp(); const casesFile = path.join(dir, 'cases.json'); const plainReport = path.join(dir, 'plain.md'); const gradedReport = path.join(dir, 'graded.md'); const grades = path.join(dir, 'grades.jsonl')
    const item = goodCase({ id: 'graded-one', deliverableText: 'doanh thu' }); writeFileSync(casesFile, JSON.stringify({ cases: [item] }))
    const built = buildGraderPrompt(item, rubric, 0); const verdict = { items: Object.fromEntries(Object.entries(built.keyMap).map(([key, id]) => [key, { result: id === 'data.answers-the-question' ? 'pass' : 'fail', quote: 'invented result' }])) }
    try {
      // Act
      const script = path.resolve('scripts/quality-eval.mjs'); const base = [script, '--cases', casesFile]
      expect(spawnSync(process.execPath, [...base, '--report', plainReport], { encoding: 'utf8' }).status).toBe(0)
      writeFileSync(grades, JSON.stringify({ index: 0, text: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }) + '\n')
      const result = spawnSync(process.execPath, [...base, '--report', gradedReport, '--ingest-grades', grades], { encoding: 'utf8' })
      // Assert
      expect(result.status).toBe(0); expect(readFileSync(plainReport, 'utf8')).toContain('| data | en | 1 | 0.0% |')
      expect(readFileSync(gradedReport, 'utf8')).toContain('| data | en | 1 | 20.0% |')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CLI rejects invalid seed values', () => {
    // Arrange
    const script = path.resolve('scripts/quality-eval.mjs')
    // Act / Assert
    for (const seed of ['-1', 'x', '1.5']) expect(spawnSync(process.execPath, [script, '--seed', seed], { encoding: 'utf8' }).status).toBe(2)
  })

  it('CLI --holdout --report writes an aggregate-only report', () => {
    // Arrange
    const dir = temp(); const report = path.join(dir, 'report.md'); const answer = path.join(dir, 'answer.md')
    writeFileSync(answer, '# Goal\nDistinctive deliverable marker holdout-zebra')
    writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: [goodCase({ id: 'holdout-distinctive-amber', request: 'Distinctive holdout request amber', split: 'holdout', profile: 'design', deliverable: 'answer.md', deliverableText: undefined })] }))
    try {
      // Act
      const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--report', report], { env: { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }, encoding: 'utf8' })
      // Assert
      const output = readFileSync(report, 'utf8'); expect(result.status).toBe(0); expect(output).toContain('Split: holdout'); expect(output).not.toContain('holdout-distinctive-amber'); expect(output).not.toContain('Distinctive holdout request amber'); expect(output).not.toContain('holdout-zebra'); expect(result.stdout).not.toContain('holdout-distinctive-amber'); expect(result.stdout).not.toContain('Distinctive holdout request amber'); expect(result.stdout).not.toContain('holdout-zebra')
      expect(spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--holdout', '--split', 'dev', '--report', report], { env: { ...process.env, CODEX_MCP_QUALITY_HOLDOUT: dir }, encoding: 'utf8' }).status).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('CLI resolves dev deliverables from the cases directory', () => {
    // Arrange
    const dir = temp(); const casesDir = path.join(dir, 'cases'); const report = path.join(dir, 'report.md'); mkdirSync(casesDir); writeFileSync(path.join(casesDir, 'answer.md'), '# Goal')
    writeFileSync(path.join(casesDir, 'cases.json'), JSON.stringify({ cases: [goodCase({ profile: 'design', deliverable: 'answer.md', deliverableText: undefined })] }))
    try {
      // Act
      const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--cases', path.join(casesDir, 'cases.json'), '--report', report], { cwd: os.tmpdir(), encoding: 'utf8' })
      // Assert
      const output = readFileSync(report, 'utf8'); expect(result.status).toBe(0); expect(output).toContain('Case count: 1'); expect(output).toContain('| design | en | 1 |'); expect(output).toContain('16.7%')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an invalid split value', () => {
    // Arrange
    const dir = temp(); const casesFile = path.join(dir, 'cases.json'); writeFileSync(casesFile, JSON.stringify([goodCase()]))
    // Act
    const result = spawnSync(process.execPath, [path.resolve('scripts/quality-eval.mjs'), '--cases', casesFile, '--split', 'typo', '--report', path.join(dir, 'report.md')], { encoding: 'utf8' })
    // Assert
    expect(result.status).toBe(2); expect(result.stderr).toContain('--split must be dev or holdout'); rmSync(dir, { recursive: true, force: true })
  })

  it('validates grade indexes and counts bad verdicts as ungraded', () => {
    // Arrange
    const cases = [goodCase()]; const invalid = [{ index: 'x', text: 'invented' }, { index: 2, text: 'invented' }, { index: 0, text: 'bad' }]
    // Act / Assert
    expect(() => ingestGradeLines(invalid, cases, rubric, process.cwd())).toThrow(UsageError)
    const result = ingestGradeLines([{ index: 0, text: 'bad' }], cases, rubric, process.cwd())
    expect(result).toEqual({ grades: {}, ingested: 0, ungraded: 1 })
    expect(() => ingestGradeLines([{ index: 0, text: 'bad' }, { index: 0, text: 'bad' }], cases, rubric, process.cwd())).toThrow('duplicate grade index')
  })
})
