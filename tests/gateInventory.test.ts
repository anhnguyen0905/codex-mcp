import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const inventoryPath = fileURLToPath(new URL('../docs/gate-inventory.md', import.meta.url))
const repoPath = (relativePath: string): string =>
  fileURLToPath(new URL(`../${relativePath}`, import.meta.url))
const normaliseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

type InventoryRow = {
  file: string
  anchor: string
  assumes: string
  appliesToNonCodeRuns: string
}

const inventoryRows = (document: string): InventoryRow[] => {
  const table = document
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('| ---'))
    .slice(1)
  return table.map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    return {
      file: cells[1],
      anchor: cells[2].replace(/^`|`$/g, ''),
      assumes: cells[4],
      appliesToNonCodeRuns: cells[5],
    }
  })
}

describe('gate inventory', () => {
  it('contains at least fifteen anchored gate rows', (): void => {
    // Arrange
    const document = readFileSync(inventoryPath, 'utf8')

    // Act
    const rows = inventoryRows(document)

    // Assert
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })

  it('cites existing files and exact anchors', (): void => {
    // Arrange
    const document = readFileSync(inventoryPath, 'utf8')
    const rows = inventoryRows(document)

    // Act
    const checks = rows.map((row) => ({
      row,
      fileText: readFileSync(repoPath(row.file), 'utf8'),
    }))

    // Assert
    checks.forEach(({ row, fileText }) => {
      expect(normaliseWhitespace(fileText)).toContain(normaliseWhitespace(row.anchor))
    })
  })

  it('uses the contract values for assumptions and non-code applicability', (): void => {
    // Arrange
    const rows = inventoryRows(readFileSync(inventoryPath, 'utf8'))
    const allowedAssumptions = new Set(['code', 'git', 'test'])
    const allowedApplicability = new Set(['yes', 'no', 'partly'])

    // Act
    const assumptionValues = rows.flatMap((row) => row.assumes.split(',').map((value) => value.trim()))

    // Assert
    assumptionValues.forEach((value) => expect(allowedAssumptions.has(value)).toBe(true))
    rows.forEach((row) => expect(allowedApplicability.has(row.appliesToNonCodeRuns)).toBe(true))
  })
})
