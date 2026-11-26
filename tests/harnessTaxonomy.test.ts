import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { CAUSES, isCause, parseCauses } from '../scripts/harness-taxonomy.mjs'

describe('harness taxonomy', () => {
  it('parses valid causes while preserving order and repeats', () => {
    // Arrange
    const input = ' infra, skill-gap, infra '

    // Act
    const actual = parseCauses(input)

    // Assert
    expect(actual).toEqual(['infra', 'skill-gap', 'infra'])
    expect(CAUSES).toHaveLength(7)
    expect(isCause('infra')).toBe(true)
  })

  it('rejects unknown causes', () => {
    // Arrange / Act / Assert
    expect(() => parseCauses('infra,unknown')).toThrow('invalid cause: unknown')
    expect(isCause('unknown')).toBe(false)
  })
})
