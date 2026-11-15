import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { detectLanguage } from '../scripts/language-detect.mjs'

describe('language detection', () => {
  it('keeps short English probes with coincidental Vietnamese words as en', () => {
    // Arrange
    const requests = [
      'Do ban the report before lunch',
      'The rat can den under rocks',
      'Hay do we need another review',
      'A ban is due this month',
      'The tao engine needs a patch',
      'Can you do that task today',
      'The den is near the old mill',
      'Rat control is part of maintenance',
      'Do we ship the build now',
      'The ban affects only new users',
      'Quarterly bao cao summarizes metrics',
      'Reviewed doanh thu against targets',
      'Detailed phan tich guides planning',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'en'))
  })

  it('recognizes folded Vietnamese requests', () => {
    // Arrange
    const requests = [
      'phan tich doanh thu theo ngay',
      'chay lai bao cao tuan nay',
      'loc du lieu theo ngay',
      'so sanh doanh thu theo hai nhom',
      'tao bieu do cho ket qua',
      'kiem tra ty le giu chan theo ngay',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'vi'))
  })

  it('recognizes jargon-dense folded Vietnamese by syllable structure', () => {
    // Arrange
    const requests = [
      'xem lai retention D14 cua campaign mua he',
      'lam report ARPU theo tung server',
      'phan tich ROAS theo cohort ngay cho game',
      'toi uu KPI va LTV bang dashboard doanh thu',
      'kiem tra funnel theo cohort ngay va nhom nguoi dung',
      'so sanh CPI voi ROAS cho campaign moi',
      'loc SKU trong bao cao roi tinh doanh thu',
      'tao cohort va dashboard cho phan tich user',
      'tong hop LTV D7 trong dashboard doanh thu',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'vi'))
  })

  it('keeps short ambiguous English jargon requests as en', () => {
    // Arrange
    const requests = [
      'Do not reset the server yet',
      'Hon, can you send the file',
      'To do a quick ROAS report by noon',
      'Can you ban the new SKU in the cohort report',
      'Do a quick KPI check for the team',
      'The funnel and ROAS report is due today',
      'A cohort dashboard can show the lift',
      'To do a KPI audit for the new app',
      'The SKU data is in a dashboard for us',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'en'))
  })

  it('keeps English grammar with one Vietnamese noun phrase as en', () => {
    // Arrange
    const requests = [
      'Send the bao cao to finance',
      'Chart doanh thu by region',
      'Review phan tich with the team',
      'Move the cohort bao cao to the dashboard',
      'Can you check doanh thu by month',
      'The phan tich report is ready for review',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'en'))
  })

  it('does not treat acronyms or digit-bearing tokens as syllables', () => {
    // Arrange
    const requests = [
      'ROAS KPI LTV D7 dashboard',
      'D7 and A/B test results are in the KPI report',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(['en', 'en'])
  })

  it('keeps a balanced Vietnamese-English sentence as mixed', () => {
    // Arrange
    const request = 'Analyze the phan tich report carefully today'

    // Act
    const actual = detectLanguage(request)

    // Assert
    expect(actual).toBe('mixed')
  })

  it('keeps accented Vietnamese requests as vi', () => {
    // Arrange
    const requests = [
      'phân tích doanh thu theo ngày',
      'chạy lại báo cáo tuần này',
      'kiểm tra tỷ lệ giữ chân',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(requests.map(() => 'vi'))
  })

  it('treats accented tokens as Vietnamese even when they fold to English stops', () => {
    // Arrange
    const cases = [
      { input: 'á', expected: 'vi' },
      { input: 'Tôi ăn cơm', expected: 'vi' },
      { input: 'Bé đi học', expected: 'vi' },
      { input: 'Tô phở ngon', expected: 'vi' },
      { input: 'Anh ăn chưa', expected: 'vi' },
      { input: 'Bé ở nhà', expected: 'vi' },
      { input: 'Mẹ nấu cơm', expected: 'vi' },
      { input: 'Cá bơi nhanh', expected: 'vi' },
      { input: 'Hè này vui', expected: 'vi' },
    ]

    // Act / Assert
    for (const { input, expected } of cases) expect(detectLanguage(input)).toBe(expected)
  })

  it('keeps empty, punctuation-only, acronym, and invalid-syllable inputs as en', () => {
    // Arrange
    const cases = [
      { input: '', expected: 'en' },
      { input: '?!.,', expected: 'en' },
      { input: 'ROAS KPI LTV D7', expected: 'en' },
      { input: 'aaa eou', expected: 'en' },
      { input: 'first', expected: 'en' },
      { input: 'back', expected: 'en' },
    ]

    // Act / Assert
    for (const { input, expected } of cases) expect(detectLanguage(input)).toBe(expected)
  })

  it('classifies clearly mixed requests as mixed', () => {
    // Arrange
    const requests = [
      'Analyze kiểm tra this English report',
      'Please kiểm tra this English report',
    ]

    // Act
    const actual = requests.map(detectLanguage)

    // Assert
    expect(actual).toEqual(['mixed', 'mixed'])
  })
})
