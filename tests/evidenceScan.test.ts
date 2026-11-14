import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { parseAnchors, parseTables, scanNumberTokens, stripAnchoredRegions } from '../scripts/evidence-scan.mjs'

describe('evidence scan', () => {
  it('scans formatted prose numbers while masking dates, identifiers, code, comments, and markers', () => {
    const text = [
      '2026-11-13T12:30:00Z 13/11/2026 2025 item005abc D1-2 Q04',
      '1. Inline `777` and 12.345 plus 1,23%. <!--F12-->',
    ].join('\n')

    const actual = scanNumberTokens(text)

    expect(actual).toEqual([
      { literal: '12.345', line: 2, column: 21 },
      { literal: '1,23%', line: 2, column: 33 },
    ])
  })

  it('masks the table number on a captioned line', () => {
    const text = 'Bảng 1. Funnel theo country <!--T1--> [Q04]'

    expect(scanNumberTokens(text)).toEqual([])
  })

  it('keeps measured numbers on a caption line', () => {
    const text = 'Bảng 2. 12.345 user <!--T2-->'

    expect(scanNumberTokens(text)).toEqual([{ literal: '12.345', line: 1, column: 9 }])
  })

  it('does not mask outside captioned lines', () => {
    const text = 'Bảng 1. x'

    expect(scanNumberTokens(text)).toEqual([{ literal: '1', line: 1, column: 6 }])
  })

  it('masks English and emphasised captions', () => {
    const texts = ['Table 3: rows <!--T3-->', '**Bảng 4.** rows <!--T4-->']

    expect(texts.flatMap((text) => scanNumberTokens(text))).toEqual([])
  })

  it('keeps anchor binding columns after masking', () => {
    const text = 'Bảng 5. total 42<!--F1--> <!--T5-->'
    const tokens = scanNumberTokens(text)

    expect(parseAnchors(text)).toEqual([{ id: 'F1', literal: '42', line: 1, column: 15 }])
    expect(tokens).toContainEqual({ literal: '42', line: 1, column: 15 })
  })

  it('binds only an immediately preceding number to each figure anchor', () => {
    const text = '42<!--F1--> 43 <!--F2--> word 44 nope<!--F3-->\n<!--F004--> 45<!--F12--> 46<!--F13-->'

    expect(parseAnchors(text)).toEqual([
      { id: 'F1', literal: '42', line: 1, column: 1 },
      { id: 'F2', literal: '43', line: 1, column: 13 },
      { id: 'F3', literal: null, line: 1, column: null },
      { id: 'F004', literal: null, line: 2, column: null },
      { id: 'F12', literal: '45', line: 2, column: 13 },
      { id: 'F13', literal: '46', line: 2, column: 26 },
    ])
    expect(scanNumberTokens(text).map(({ literal }) => literal)).toEqual(['42', '43', '44', '45', '46'])
  })

  it('rejects masked or non-token numbers and binds a valid number after a date', () => {
    const text = 'abc42<!--F1--> 2026-11-13<!--F2--> D1-2<!--F3--> `42`<!--F4--> 2026-11-13 is 42<!--F5-->'
    const anchors = parseAnchors(text)
    const tokens = scanNumberTokens(text)

    expect(anchors).toEqual([
      { id: 'F1', literal: null, line: 1, column: null },
      { id: 'F2', literal: null, line: 1, column: null },
      { id: 'F3', literal: null, line: 1, column: null },
      { id: 'F4', literal: null, line: 1, column: null },
      { id: 'F5', literal: '42', line: 1, column: 78 },
    ])
    expect(anchors.filter(({ literal }) => literal !== null).every((anchor) =>
      tokens.some((token) => token.literal === anchor.literal && token.line === anchor.line),
    )).toBe(true)
  })

  it('parses only captioned GitHub pipe tables and trims cells', () => {
    const text = [
      'Caption <!--T12-->', '', ' | Name | Value | ', '| :--- | ---: |', '| A | 1 |', '| B | 2 |',
      '', 'Uncaptioned', '| X | Y |', '| --- | --- |', '| 3 | 4 |',
    ].join('\n')

    expect(parseTables(text)).toEqual([{
      id: 'T12', line: 1, header: ['Name', 'Value'], rows: [['A', '1'], ['B', '2']],
    }])
  })

  it('strips verified table rows while preserving line count and captions', () => {
    const text = 'Caption <!--T1-->\n| A | B |\n| --- | --- |\n| 1 | 2 |\nOutside 3\n'
    const stripped = stripAnchoredRegions(text, parseTables(text))

    expect(stripped.split('\n')).toHaveLength(text.split('\n').length)
    expect(stripped).toContain('Caption <!--T1-->')
    expect(stripped).toContain('Outside 3')
    expect(scanNumberTokens(stripped)).toEqual([{ literal: '3', line: 5, column: 9 }])
  })
})
