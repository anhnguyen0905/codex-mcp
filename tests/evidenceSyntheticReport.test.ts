import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { checkManifest } from '../scripts/evidence-check.mjs'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/evidence-v2-synthetic')

const withCopy = (mutate: (directory: string) => void) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'evidence-synthetic-'))
  cpSync(fixture, directory, { recursive: true })
  try {
    mutate(directory)
    return checkManifest(path.join(directory, 'evidence.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const pairs = (result: { findings: Array<{ check: string, id: string }> }) => result.findings
  .map(({ check, id }) => `${check}:${id}`).sort()

const reportPath = (directory: string) => path.join(directory, 'REPORT.md')
const manifestPath = (directory: string) => path.join(directory, 'evidence.json')
const csvPath = (directory: string, name: string) => path.join(directory, 'results', name)
const csvRecords = (directory: string, name: string) => {
  const lines = readFileSync(csvPath(directory, name), 'utf8').trim().split(/\r?\n/)
  const headers = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]))
  })
}
const sumColumn = (records: Array<Record<string, string>>, column: string) => records
  .reduce((total, record) => total + Number(record[column]), 0)

describe('synthetic evidence v2 report', () => {
  it('clean synthetic report passes', () => {
    // Arrange / Act
    const result = withCopy(() => {})
    // Assert
    expect(result).toMatchObject({ status: 'pass', findings: [] })
  })

  it.each([
    ['headline anchor', (d: string) => writeFileSync(reportPath(d), readFileSync(reportPath(d), 'utf8').replace('28,80%<!--F3-->', '28,81%<!--F3-->')), ['anchor-mismatch:F3']],
    ['region anchor', (d: string) => writeFileSync(reportPath(d), readFileSync(reportPath(d), 'utf8').replace('25,00%<!--F22-->', '57,93%<!--F22-->')), ['anchor-mismatch:F22']],
    ['region unanchored', (d: string) => writeFileSync(reportPath(d), readFileSync(reportPath(d), 'utf8').replace('25,00%<!--F22-->', '30,00%')), ['unanchored-number:REPORT.md']],
    ['unsourced claim', (d: string) => { const p = manifestPath(d); const m = JSON.parse(readFileSync(p, 'utf8')) as { claims: Array<{ id: string, sources: string[] }> }; m.claims[3].sources = []; writeFileSync(p, JSON.stringify(m)) }, ['claim-no-figure:C4', 'claim-unsourced:C4']],
    ['table cell', (d: string) => writeFileSync(reportPath(d), readFileSync(reportPath(d), 'utf8').replace('| R01 | 140 | 48 | 34.29 |', '| R01 | 140 | 48 | 34.30 |')), ['table-mismatch:T1']],
    ['failure share', (d: string) => writeFileSync(reportPath(d), readFileSync(reportPath(d), 'utf8').replace('46,59%<!--F16-->', '32,50%<!--F16-->')), ['anchor-mismatch:F16']],
    ['new percentage', (d: string) => writeFileSync(reportPath(d), `${readFileSync(reportPath(d), 'utf8')}\nTỷ lệ mới là 12,34%.\n`), ['unanchored-number:REPORT.md']],
    ['shared source cell', (d: string) => writeFileSync(csvPath(d, 'Q04.csv'), readFileSync(csvPath(d, 'Q04.csv'), 'utf8').replace('R03,120,30,25.00', 'R03,120,30,26.00')), ['figure-mismatch:F22', 'table-mismatch:T1']],
  ])('catches %s with the exact finding set', (_name, mutate, expected) => {
    // Arrange / Act
    const result = withCopy(mutate)
    // Assert
    expect(pairs(result)).toEqual(expected)
  })

  it('breakdowns reconcile with the funnel totals', () => {
    // Arrange
    const result = withCopy((directory) => {
      const funnel = csvRecords(directory, 'Q02.csv')[0]
      const potential = Number(funnel.potential_buyers)
      const actual = Number(funnel.actual_buyers)
      expect(sumColumn(csvRecords(directory, 'Q04.csv'), 'potential_buyers')).toBe(potential)
      expect(sumColumn(csvRecords(directory, 'Q04.csv'), 'actual_buyers')).toBe(actual)
      expect(sumColumn(csvRecords(directory, 'Q05.csv'), 'potential_buyers')).toBe(potential)
      expect(sumColumn(csvRecords(directory, 'Q05.csv'), 'actual_buyers')).toBe(actual)
      expect(sumColumn(csvRecords(directory, 'Q06.csv'), 'orders')).toBe(actual)
      expect(sumColumn(csvRecords(directory, 'Q07.csv'), 'potential_buyers')).toBe(potential)
      expect(sumColumn(csvRecords(directory, 'Q07.csv'), 'actual_buyers')).toBe(actual)
      expect(sumColumn(csvRecords(directory, 'Q08.csv'), 'buyers')).toBe(actual)
    })
    // Act / Assert
    expect(result.findings).toEqual([])
  })

  it('every figure re-derives from the CSVs', () => {
    // Arrange / Act
    const result = withCopy((directory) => {
      for (const name of ['Q01.csv', 'Q02.csv', 'Q03.csv', 'Q04.csv', 'Q05.csv', 'Q06.csv', 'Q07.csv', 'Q08.csv', 'Q09.csv', 'Q10.csv']) {
        const file = csvPath(directory, name)
        const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
        const transformed = lines.map((line, lineIndex) => lineIndex === 0 ? line : line.split(',').map((cell) => {
          const value = Number(cell)
          return Number.isFinite(value) ? String(Math.round((value * 1.5 + 1) * 10000) / 10000) : cell
        }).join(','))
        writeFileSync(file, `${transformed.join('\n')}\n`)
      }
    })
    // Assert
    const mismatches = result.findings.filter(({ check }) => check === 'figure-mismatch').map(({ id }) => id)
    expect(mismatches).toEqual(Array.from({ length: 47 }, (_, index) => `F${index + 1}`))
  })
})
