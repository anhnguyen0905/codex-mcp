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
