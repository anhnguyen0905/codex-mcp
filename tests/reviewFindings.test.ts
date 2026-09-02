import { describe, expect, test } from 'vitest'
import { parseReviewFindings, REVIEW_FINDINGS_INSTRUCTIONS } from '../src/reviewFindings.js'

const wrap = (json: unknown, prose = 'Some prose first.\n'): string =>
  `${prose}\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`

describe('parseReviewFindings', () => {
  test('parses a well-formed findings block into typed findings and improvements', () => {
    const message = wrap({
      findings: [
        { severity: 'HIGH', file: 'src/a.ts', line: 42, summary: 'returns 200 on missing id', expected: '404', observed: '200 with null body' },
        { severity: 'low', file: 'src/b.ts', line: null, summary: 'naming' },
      ],
      improvements: [{ id: 'IMP-1', summary: 'extract helper', file: 'src/a.ts:10' }],
    })

    const result = parseReviewFindings(message)

    expect(result.parsed).toBe(true)
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]).toMatchObject({ severity: 'HIGH', file: 'src/a.ts', line: 42 })
    expect(result.findings[1]).toMatchObject({ severity: 'LOW', line: null })
    expect(result.improvements).toEqual([{ id: 'IMP-1', summary: 'extract helper', file: 'src/a.ts:10' }])
    expect(result.dropped).toBe(0)
    expect(result.parseError).toBeUndefined()
  })

  test('reports parsed=false with a reason when no json block exists', () => {
    const result = parseReviewFindings('1. [HIGH] src/a.ts:3 — broken\n')

    expect(result.parsed).toBe(false)
    expect(result.findings).toEqual([])
    expect(result.parseError).toMatch(/no fenced json block/i)
  })

  test('reports parsed=false when the block is not valid JSON', () => {
    const result = parseReviewFindings('```json\n{ not json\n```')

    expect(result.parsed).toBe(false)
    expect(result.parseError).toMatch(/invalid json/i)
  })

  test('drops malformed entries fail-closed and counts them instead of inventing severities', () => {
    const message = wrap({
      findings: [
        { severity: 'HIGH', file: 'src/a.ts', line: 1, summary: 'ok' },
        { severity: 'URGENT', file: 'src/a.ts', line: 1, summary: 'bad severity' },
        { file: 'src/a.ts', summary: 'no severity' },
        'not an object',
      ],
      improvements: [{ summary: 'missing id' }, { id: 'IMP-2', summary: 'fine' }],
    })

    const result = parseReviewFindings(message)

    expect(result.parsed).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.improvements).toEqual([{ id: 'IMP-2', summary: 'fine' }])
    expect(result.dropped).toBe(4)
  })

  test('uses the LAST json block when several are present', () => {
    const message =
      wrap({ findings: [{ severity: 'LOW', file: 'x', line: 1, summary: 'first' }] }) +
      wrap({ findings: [{ severity: 'HIGH', file: 'y', line: 2, summary: 'last' }] }, '')

    const result = parseReviewFindings(message)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].summary).toBe('last')
  })

  test('handles null agentMessage and an empty findings list', () => {
    expect(parseReviewFindings(null).parsed).toBe(false)
    const empty = parseReviewFindings(wrap({ findings: [], improvements: [] }))
    expect(empty.parsed).toBe(true)
    expect(empty.findings).toEqual([])
  })

  test('the prompt instructions name the exact block shape Codex must emit', () => {
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toContain('```json')
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toContain('"findings"')
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toContain('"improvements"')
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toMatch(/CRITICAL\|HIGH\|MEDIUM\|LOW/)
  })
})
