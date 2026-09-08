import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { parseReviewFindings, REVIEW_FINDINGS_INSTRUCTIONS, reviewFindingsSchema } from '../src/reviewFindings.js'

const wrap = (json: unknown, prose = 'Some prose first.\n'): string =>
  `${prose}\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`

describe('parseReviewFindings', () => {
  test('parses a well-formed findings block into typed findings and improvements', () => {
    const message = wrap({
      findings: [
        { severity: 'HIGH', file: 'src/a.ts', line: 42, summary: 'returns 200 on missing id', expected: '404', observed: '200 with null body' },
        { severity: 'low', file: 'src/b.ts', line: 7, summary: 'naming', expected: 'clear name', observed: 'ambiguous name' },
      ],
      improvements: [{ id: 'IMP-1', summary: 'extract helper', file: 'src/a.ts:10' }],
    })

    const result = parseReviewFindings(message)

    expect(result.parsed).toBe(true)
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0]).toMatchObject({ severity: 'HIGH', file: 'src/a.ts', line: 42 })
    expect(result.findings[1]).toMatchObject({ severity: 'LOW', line: 7 })
    expect(result.improvements).toEqual([{ id: 'IMP-1', summary: 'extract helper', file: 'src/a.ts:10' }])
    expect(result.dropped).toBe(0)
    expect(result.droppedReasons).toEqual([])
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

  test('reports parsed=false when the findings array is missing', () => {
    const result = parseReviewFindings(wrap({ note: 'done' }))

    expect(result.parsed).toBe(false)
    expect(result.parseError).toBe('missing findings array')
    expect(result.droppedReasons).toEqual([])
  })

  test('reports parsed=false when the improvements array is missing', () => {
    const result = parseReviewFindings(wrap({ findings: [] }))

    expect(result.parsed).toBe(false)
    expect(result.parseError).toBe('missing improvements array')
  })

  test('drops malformed entries fail-closed and counts them instead of inventing severities', () => {
    const message = wrap({
      findings: [
        { severity: 'HIGH', file: 'src/a.ts', line: 1, summary: 'ok', expected: 'expected', observed: 'observed' },
        { severity: 'URGENT', file: 'src/a.ts', line: 1, summary: 'bad severity', expected: 'expected', observed: 'observed' },
        { file: 'src/a.ts', summary: 'no severity', expected: 'expected', observed: 'observed' },
        { severity: 'LOW', file: 'src/a.ts', line: 2, summary: 'no observed', expected: 'expected' },
        'not an object',
      ],
      improvements: [{ summary: 'missing id' }, { id: 'IMP-2', summary: 'fine' }],
    })

    const result = parseReviewFindings(message)

    expect(result.parsed).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.improvements).toEqual([{ id: 'IMP-2', summary: 'fine' }])
    expect(result.dropped).toBe(5)
    expect(result.droppedReasons).toEqual([
      'findings[1].severity',
      'findings[2].severity',
      'findings[3].observed',
      'findings[4]',
      'improvements[0].id',
    ])
  })

  test('drops a finding whose line is missing and names the field in droppedReasons', () => {
    // Arrange
    const message = wrap({
      findings: [{ severity: 'HIGH', file: 'src/a.ts', summary: 'no line', expected: 'e', observed: 'o' }],
      improvements: [],
    })

    // Act
    const result = parseReviewFindings(message)

    // Assert
    expect(result.parsed).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.droppedReasons).toEqual(['findings[0].line'])
  })

  test('drops a finding whose line is null instead of defaulting it', () => {
    // Arrange
    const message = wrap({
      findings: [{ severity: 'HIGH', file: 'src/a.ts', line: null, summary: 'null line', expected: 'e', observed: 'o' }],
      improvements: [],
    })

    // Act
    const result = parseReviewFindings(message)

    // Assert
    expect(result.findings).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.droppedReasons).toEqual(['findings[0].line'])
  })

  test('keeps droppedReasons in findings-then-improvements order, one entry per dropped item', () => {
    // Arrange
    const message = wrap({
      findings: [
        { severity: 'HIGH', file: 'src/a.ts', line: 1, summary: 'ok', expected: 'e', observed: 'o' },
        { severity: 'HIGH', file: '', line: 2, summary: 'empty file', expected: 'e', observed: 'o' },
        { severity: 'HIGH', file: 'src/c.ts', line: 1.5, summary: 'fractional line', expected: 'e', observed: 'o' },
      ],
      improvements: [{ id: 'IMP-1', summary: 'fine' }, { id: 'IMP-2' }],
    })

    // Act
    const result = parseReviewFindings(message)

    // Assert
    expect(result.droppedReasons).toEqual(['findings[1].file', 'findings[2].line', 'improvements[1].summary'])
    expect(result.dropped).toBe(result.droppedReasons.length)
  })

  test('uses the LAST json block when several are present', () => {
    const message =
      wrap({ findings: [{ severity: 'LOW', file: 'x', line: 1, summary: 'first', expected: 'first expected', observed: 'first observed' }], improvements: [] }) +
      wrap({ findings: [{ severity: 'HIGH', file: 'y', line: 2, summary: 'last', expected: 'last expected', observed: 'last observed' }], improvements: [] }, '')

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
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toMatch(/Both "findings" and "improvements" arrays are required/)
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toMatch(/must include non-empty "expected" and "observed" strings/)
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toMatch(/CRITICAL\|HIGH\|MEDIUM\|LOW/)
    expect(REVIEW_FINDINGS_INSTRUCTIONS).toMatch(/must include an integer "line"/)
  })
})

const validFinding = {
  severity: 'HIGH' as const,
  file: 'src/a.ts',
  line: 3,
  summary: 'drops the id',
  expected: '404',
  observed: '200',
}

const validPayload = {
  parsed: true,
  findings: [validFinding],
  improvements: [{ id: 'IMP-1', summary: 'extract helper' }],
  dropped: 0,
  droppedReasons: [],
}

const firstIssuePath = (result: z.ZodSafeParseResult<unknown>): string =>
  result.success ? '' : (result.error.issues[0]?.path.join('.') ?? '')

describe('reviewFindingsSchema', () => {
  test('accepts a fully populated payload including optional parseError', () => {
    // Arrange
    const payload = { ...validPayload, parseError: undefined }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(true)
  })

  test('rejects a payload without droppedReasons', () => {
    // Arrange
    const { droppedReasons: _omitted, ...withoutReasons } = validPayload

    // Act
    const result = reviewFindingsSchema.safeParse(withoutReasons)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('droppedReasons')
  })

  test('rejects droppedReasons entries that are not strings', () => {
    // Arrange
    const payload = { ...validPayload, dropped: 1, droppedReasons: [{ field: 'findings[0].line' }] }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('droppedReasons.0')
  })

  test('rejects a finding whose line is missing', () => {
    // Arrange
    const { line: _omitted, ...findingWithoutLine } = validFinding
    const payload = { ...validPayload, findings: [findingWithoutLine] }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('findings.0.line')
  })

  test('rejects a finding whose line is not an integer', () => {
    // Arrange
    const payload = { ...validPayload, findings: [{ ...validFinding, line: 3.5 }] }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('findings.0.line')
  })

  test('rejects a payload whose top-level findings is not an array', () => {
    // Arrange
    const payload = { ...validPayload, findings: { severity: 'HIGH' } }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('findings')
  })

  test('rejects a non-string parseError', () => {
    // Arrange
    const payload = { ...validPayload, parsed: false, parseError: 500 }

    // Act
    const result = reviewFindingsSchema.safeParse(payload)

    // Assert
    expect(result.success).toBe(false)
    expect(firstIssuePath(result)).toBe('parseError')
  })

  test('every parseReviewFindings result validates and keeps dropped === droppedReasons.length', () => {
    // Arrange
    const messages = [
      wrap({ findings: [validFinding], improvements: [] }),
      wrap({
        findings: [{ ...validFinding, line: null }, 'not an object'],
        improvements: [{ summary: 'missing id' }],
      }),
      wrap({ findings: 'not an array', improvements: [] }),
      'no fenced block at all',
    ]

    // Act
    const results = messages.map((message) => parseReviewFindings(message))

    // Assert
    for (const result of results) {
      expect(reviewFindingsSchema.safeParse(result).success).toBe(true)
      expect(result.dropped).toBe(result.droppedReasons.length)
    }
    expect(results[1].droppedReasons).toEqual(['findings[0].line', 'findings[1]', 'improvements[0].id'])
  })

  test('reports parsed=false naming findings when the field is present but not an array', () => {
    // Arrange
    const message = wrap({ findings: { severity: 'HIGH' }, improvements: [] })

    // Act
    const result = parseReviewFindings(message)

    // Assert
    expect(result.parsed).toBe(false)
    expect(result.parseError).toBe('missing findings array')
    expect(result.dropped).toBe(0)
    expect(result.droppedReasons).toEqual([])
  })
})
