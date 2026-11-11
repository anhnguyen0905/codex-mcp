import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script
import { readFileSync } from 'node:fs'
import { deriveTerms, VIETNAMESE_STOP_WORDS, ENGLISH_STOP_WORDS, REQUEST_VERBS } from '../scripts/skill-match.mjs'
import { VI_GLOSSARY, foldVietnamese, isVietnamese, translateVietnamese } from '../scripts/skill-terms.mjs'

describe('Vietnamese skill terms', () => {
  test('folds accents, case, and đ', () => {
    expect(foldVietnamese('ĐIỆN Thoại')).toBe('dien thoai')
  })

  test('translates longest phrases first and preserves order', () => {
    expect(translateVietnamese('bao cao doanh thu va bao cao')).toEqual({
      terms: ['report', 'revenue'], consumed: [[0, 7], [8, 17], [21, 28]],
    })
  })

  test('does not match inside a word or overlap a consumed phrase', () => {
    expect(translateVietnamese('baocaoxyz bao cao doanh thu')).toEqual({
      terms: ['report', 'revenue'], consumed: [[10, 17], [18, 27]],
    })
  })

  test('returns no hit for unknown vocabulary', () => {
    expect(translateVietnamese('xyzzy')).toEqual({ terms: [], consumed: [] })
  })

  test('keeps glossary keys folded and unique', () => {
    const keys = new Set<string>()
    for (const entry of VI_GLOSSARY) {
      expect(entry.vi).toBe(entry.vi.trim().toLowerCase())
      expect(entry.vi).toBe(foldVietnamese(entry.vi))
      expect(keys.has(entry.vi)).toBe(false)
      keys.add(entry.vi)
    }
  })

  test('keeps glossary English terms non-empty, lower-case, and unique', () => {
    for (const entry of VI_GLOSSARY) {
      expect(entry.en.length).toBeGreaterThan(0)
      expect(entry.en.every((term: string) => term.trim() && term === term.toLowerCase())).toBe(true)
      expect(new Set(entry.en).size).toBe(entry.en.length)
    }
  })

  test('rejects short single-word glossary keys', () => {
    expect(VI_GLOSSARY.every((entry) => entry.vi.includes(' ') || entry.vi.length >= 3)).toBe(true)
  })

  test('does not start keys with English fixture, stop, or verb tokens', () => {
    // A01 is mixed Vietnamese/English and is the explicit no-diacritic glossary allow-list case.
    const fixtures = JSON.parse(readFileSync('tests/fixtures/scenarios-100.json', 'utf8')).scenarios
      .filter((scenario: { id: string }) => scenario.id !== 'A01')
    const english = new Set(fixtures.flatMap((scenario: { request?: string }) =>
      (scenario.request?.toLowerCase().match(/[a-z]+/g) ?? [])))
    const guard = new Set([...english, ...ENGLISH_STOP_WORDS, ...REQUEST_VERBS])
    const naturalBorrowings = new Set(['pipeline', 'can'])
    expect(VI_GLOSSARY.every((entry) => naturalBorrowings.has(entry.vi.split(' ')[0])
      || !guard.has(entry.vi.split(' ')[0]))).toBe(true)
  })

  test.each([
    ['Tao bao cao doanh thu', 'Tạo báo cáo doanh thu'],
    ['Tao ke hoach du an va rui ro', 'Tạo kế hoạch dự án và rủi ro'],
    ['Tao gio hang va trang san pham', 'Tạo giỏ hàng và trang sản phẩm'],
  ])('folded and accented Vietnamese derive the same terms', (plain, accented) => {
    expect(deriveTerms(plain)).toEqual(deriveTerms(accented))
  })

  test('does not emit Vietnamese function words and respects zero and one caps', () => {
    const terms = deriveTerms('Tạo báo cáo và kế hoạch cho dự án', { maxTerms: 12 })
    expect(terms.some((term) => VIETNAMESE_STOP_WORDS.has(term))).toBe(false)
    expect(deriveTerms('Tạo báo cáo doanh thu', { maxTerms: 0 })).toEqual([])
    expect(deriveTerms('Tạo báo cáo doanh thu', { maxTerms: 1 })).toHaveLength(1)
  })

  test('ships the Vietnamese evaluation script with the required flags', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.scripts['skills:eval:vi']).toMatch(/--raw/)
    expect(packageJson.scripts['skills:eval:vi']).toMatch(/tests\/fixtures\/scenarios-vi\.json/)
    expect(Number(packageJson.scripts['skills:eval:vi'].match(/--min-pass ([0-9.]+)/)[1])).toBeGreaterThanOrEqual(0.5)
  })

  test('detects Vietnamese only by letters or glossary hits', () => {
    expect(isVietnamese('Đây là báo cáo')).toBe(true)
    expect(isVietnamese('Tao bao cao doanh thu')).toBe(true)
    expect(isVietnamese('plain English')).toBe(false)
    expect(isVietnamese('do the ban analysis')).toBe(false)
    expect(VIETNAMESE_STOP_WORDS.has('nhu')).toBe(true)
  })
})
