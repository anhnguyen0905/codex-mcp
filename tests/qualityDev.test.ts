import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { loadRubric, rubricIds, runMechanical, validateCases } from '../scripts/quality-eval.mjs'

type QualityCase = { id: string; profile: 'data' | 'design' | 'plan' | 'content'; language: 'en' | 'vi'; split: string; source: string; expected?: { rubric?: Record<string, 'pass' | 'fail'> }; deliverableText: string }
type Pair = { expected: 'pass' | 'fail'; actual: 'pass' | 'fail' }
type Confusion = { failCaught: number; failMissed: number; falseFail: number; passAgree: number; failRecall: number; passAgreement: number; balancedAccuracy: number }
const rubric = loadRubric('tests/fixtures/quality/rubrics.json')
const cases = JSON.parse(readFileSync('tests/fixtures/quality/dev-cases.json', 'utf8')).cases as QualityCase[]
const checked = validateCases(cases, rubric) as QualityCase[]
const labels = (item: QualityCase) => item.expected?.rubric ?? {}
const confusion = (pairs: Pair[]): Confusion => {
  const failCaught = pairs.filter((pair) => pair.expected === 'fail' && pair.actual === 'fail').length
  const failMissed = pairs.filter((pair) => pair.expected === 'fail' && pair.actual === 'pass').length
  const falseFail = pairs.filter((pair) => pair.expected === 'pass' && pair.actual === 'fail').length
  const passAgree = pairs.filter((pair) => pair.expected === 'pass' && pair.actual === 'pass').length
  const failRecall = failCaught / (failCaught + failMissed || 1)
  const passAgreement = passAgree / (passAgree + falseFail || 1)
  return { failCaught, failMissed, falseFail, passAgree, failRecall, passAgreement, balancedAccuracy: (failRecall + passAgreement) / 2 }
}

describe('synthetic quality dev set', () => {
  it('validates coverage, identity, profiles, languages, and complete labels', () => {
    // Arrange
    const profileMinimums = { data: 12, design: 6, plan: 6, content: 4 }
    // Act
    const counts = Object.fromEntries(Object.keys(profileMinimums).map((profile) => [profile, checked.filter((item) => item.profile === profile).length]))
    const languages = Object.fromEntries(['en', 'vi'].map((language) => [language, checked.filter((item) => item.language === language).length]))
    // Assert
    expect(new Set(checked.map((item) => item.id)).size).toBe(checked.length)
    expect(checked.length).toBeGreaterThanOrEqual(30)
    for (const [profile, minimum] of Object.entries(profileMinimums)) expect(counts[profile]).toBeGreaterThanOrEqual(minimum)
    expect(counts.data).toBeGreaterThanOrEqual(12); expect(languages.en).toBeGreaterThanOrEqual(10); expect(languages.vi).toBeGreaterThanOrEqual(10)
    expect(checked.every((item) => item.split === 'dev' && item.source === 'synthetic')).toBe(true)
    expect(checked.filter((item) => Object.values(labels(item)).includes('fail')).length).toBeGreaterThanOrEqual(14)
    for (const item of checked) expect(Object.keys(labels(item)).sort()).toEqual(rubricIds(rubric, item.profile).sort())
  })

  it('matches truthful labels on mechanically checkable rubric items', () => {
    // Arrange
    const pairs: Pair[] = []; const disagreements: string[] = []
    // Act
    for (const item of checked) for (const result of runMechanical(item)) {
      const expected = labels(item)[result.id]
      if (!['pass', 'fail'].includes(result.result)) continue
      const pair = { expected, actual: result.result } as Pair
      pairs.push(pair)
      if (pair.expected !== pair.actual)
        disagreements.push(`${item.id}:${result.id}`)
    }
    const metrics = confusion(pairs)
    const constantPass = confusion(pairs.map((pair) => ({ ...pair, actual: 'pass' as const })))
    // Assert
    process.stderr.write(`quality-dev compared=${pairs.length} expectedFails=${metrics.failCaught + metrics.failMissed} failRecall=${metrics.failRecall.toFixed(3)} passAgreement=${metrics.passAgreement.toFixed(3)} balancedAccuracy=${metrics.balancedAccuracy.toFixed(3)} constantPassBalancedAccuracy=${constantPass.balancedAccuracy.toFixed(3)} disagreements=${disagreements.join(',') || 'none'}\n`)
    expect(pairs.length).toBeGreaterThanOrEqual(60)
    expect(metrics.failCaught + metrics.failMissed).toBeGreaterThanOrEqual(10)
    expect(metrics.balancedAccuracy).toBeGreaterThan(constantPass.balancedAccuracy)
  })

  it('computes confusion metrics for perfect and constant-pass graders', () => {
    // Arrange
    const pairs: Pair[] = [{ expected: 'fail', actual: 'fail' }, { expected: 'fail', actual: 'fail' }, { expected: 'pass', actual: 'pass' }, { expected: 'pass', actual: 'pass' }]
    // Act
    const perfect = confusion(pairs); const constantPass = confusion(pairs.map((pair) => ({ ...pair, actual: 'pass' as const })))
    // Assert
    expect(perfect.balancedAccuracy).toBe(1); expect(constantPass.balancedAccuracy).toBe(0.5); expect(constantPass.failRecall).toBe(0)
  })

  it('flips a required heading when the clean case is damaged', () => {
    // Arrange
    const clean = checked.find((item) => item.id === 'dev-content-01') as QualityCase
    const damaged = { ...clean, deliverableText: clean.deliverableText.replace('## CTA\n', '') }
    // Act
    const result = runMechanical(damaged).find((item) => item.id === 'content.cta')
    // Assert
    expect(result?.result).toBe('fail')
  })
})
