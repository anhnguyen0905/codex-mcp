import { describe, expect, test } from 'vitest'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { parseTasks, computeWaves, renderWaves } from '../scripts/task-waves.mjs'

const TASKS = `# Backlog

## T1: Add config loader
- Depends on: —
- Files: src/config.ts
- Acceptance: loads env
- Status: pending

## T2: Add logger
- Depends on: —
- Files: src/logger.ts
- Acceptance: logs
- Status: pending

## T3: Wire config into server
- Depends on: T1
- Files: src/server.ts, src/config.ts
- Acceptance: server boots
- Status: pending
`

describe('parseTasks', () => {
  test('extracts id, deps, and files per task', () => {
    const tasks = parseTasks(TASKS)

    expect(tasks.map((t: { id: string }) => t.id)).toEqual(['T1', 'T2', 'T3'])
    expect(tasks[0]).toMatchObject({ id: 'T1', dependsOn: [], files: ['src/config.ts'], status: 'pending' })
    expect(tasks[2]).toMatchObject({ id: 'T3', dependsOn: ['T1'], files: ['src/server.ts', 'src/config.ts'] })
  })

  test('parses a comma-separated Requirements field and defaults it when absent', () => {
    const tasks = parseTasks(`## T1: covered
- Requirements: R1.1, R2.3 , R4.2

## T2: uncovered
- Files: b.ts
`)

    expect(tasks[0].requirements).toEqual(['R1.1', 'R2.3', 'R4.2'])
    expect(tasks[1].requirements).toEqual([])
  })

  test('treats an em-dash / "none" dependency as no dependency', () => {
    const tasks = parseTasks('## T1: x\n- Depends on: —\n- Files: a.ts\n')
    expect(tasks[0].dependsOn).toEqual([])
  })

  test('ignores unfilled placeholder file/dep tokens', () => {
    const tasks = parseTasks('## T1: x\n- Depends on: T<n>\n- Files: <files to create>\n')
    expect(tasks[0].dependsOn).toEqual([])
    expect(tasks[0].files).toEqual([])
  })
})

describe('computeWaves', () => {
  test('serializes a linear dependency chain into one task per wave', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: ['a.ts'] },
      { id: 'T2', dependsOn: ['T1'], files: ['b.ts'] },
      { id: 'T3', dependsOn: ['T2'], files: ['c.ts'] },
    ]

    const { waves, maxWidth, parallelizable } = computeWaves(tasks)

    expect(waves).toEqual([['T1'], ['T2'], ['T3']])
    expect(maxWidth).toBe(1)
    expect(parallelizable).toBe(false)
  })

  test('batches independent, file-disjoint tasks into one wave', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: ['a.ts'] },
      { id: 'T2', dependsOn: [], files: ['b.ts'] },
      { id: 'T3', dependsOn: [], files: ['c.ts'] },
    ]

    const { waves, maxWidth, parallelizable } = computeWaves(tasks)

    expect(waves).toEqual([['T1', 'T2', 'T3']])
    expect(maxWidth).toBe(3)
    expect(parallelizable).toBe(true)
  })

  test('serializes independent tasks that share a file', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: ['shared.ts'] },
      { id: 'T2', dependsOn: [], files: ['shared.ts', 'other.ts'] },
    ]

    const { waves } = computeWaves(tasks)

    expect(waves).toEqual([['T1'], ['T2']])
  })

  test('runs a task with no declared files alone in its wave', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: [] },
      { id: 'T2', dependsOn: [], files: ['b.ts'] },
    ]

    const { waves } = computeWaves(tasks)

    // T1 is exclusive (unknown blast radius) → its own wave; T2 follows.
    expect(waves).toEqual([['T1'], ['T2']])
  })

  test('places a dependent task in a later wave than its dependency, batching where possible', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: ['a.ts'] },
      { id: 'T2', dependsOn: [], files: ['b.ts'] },
      { id: 'T3', dependsOn: ['T1'], files: ['c.ts'] },
    ]

    const { waves } = computeWaves(tasks)

    expect(waves).toEqual([['T1', 'T2'], ['T3']])
  })

  test('orders ready tasks numerically (T10 after T2)', () => {
    const tasks = [
      { id: 'T2', dependsOn: [], files: ['b.ts'] },
      { id: 'T10', dependsOn: [], files: ['j.ts'] },
    ]

    const { waves } = computeWaves(tasks)

    expect(waves[0]).toEqual(['T2', 'T10'])
  })

  test('caps a wide wave at maxConcurrency and flows the rest into the next wave', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `T${i + 1}`,
      dependsOn: [],
      files: [`f${i}.ts`],
    }))

    const { waves, maxWidth } = computeWaves(tasks, { maxConcurrency: 2 })

    expect(maxWidth).toBe(2)
    expect(waves).toEqual([['T1', 'T2'], ['T3', 'T4'], ['T5']])
  })

  test('defaults the concurrency cap to 10', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `T${i + 1}`,
      dependsOn: [],
      files: [`f${i}.ts`],
    }))

    const { maxWidth, waves } = computeWaves(tasks)

    expect(maxWidth).toBe(10)
    expect(waves[0]).toHaveLength(10)
    expect(waves[1]).toHaveLength(2)
  })

  test('throws on a dependency cycle', () => {
    const tasks = [
      { id: 'T1', dependsOn: ['T2'], files: ['a.ts'] },
      { id: 'T2', dependsOn: ['T1'], files: ['b.ts'] },
    ]

    expect(() => computeWaves(tasks)).toThrow(/cycle/i)
  })

  test('throws on a dependency cycle involving a done task', () => {
    const tasks = parseTasks(`## T1: incorrectly done
- Depends on: T2
- Files: a.ts
- Status: done

## T2: pending participant
- Depends on: T1
- Files: b.ts
- Status: pending
`)

    expect(() => computeWaves(tasks)).toThrow(/dependency cycle among: T1, T2/i)
  })

  test('throws when every task in a dependency cycle is done', () => {
    const tasks = parseTasks(`## T1: done participant
- Depends on: T2
- Files: a.ts
- Status: done

## T2: also done participant
- Depends on: T1
- Files: b.ts
- Status: done
`)

    expect(() => computeWaves(tasks)).toThrow(/dependency cycle among: T1, T2/i)
  })

  test('throws on an unknown dependency', () => {
    const tasks = [{ id: 'T1', dependsOn: ['T9'], files: ['a.ts'] }]

    expect(() => computeWaves(tasks)).toThrow(/unknown dependency/i)
  })

  test('excludes a done task while treating it as a satisfied dependency', () => {
    const tasks = parseTasks(`## T1: finished
- Depends on: —
- Files: a.ts
- Status: done

## T2: next
- Depends on: T1
- Files: b.ts
- Status: pending
`)

    const result = computeWaves(tasks)

    expect(result.waves).toEqual([['T2']])
    expect(result.blocked).toEqual([])
    expect(result.inProgress).toEqual([])
  })

  test('blocks transitive dependents of a failed task with the failed ancestor in the reason', () => {
    const tasks = parseTasks(`## T1: failed root
- Files: a.ts
- Status: failed

## T2: direct dependent
- Depends on: T1
- Files: b.ts
- Status: pending

## T3: transitive dependent
- Depends on: T2
- Files: c.ts
- Status: pending

## T4: independent
- Files: d.ts
- Status: pending
`)

    const result = computeWaves(tasks)

    expect(result.waves).toEqual([['T4']])
    expect(result.blocked).toEqual([
      { id: 'T1', reason: 'status failed' },
      { id: 'T2', reason: 'depends on failed T1' },
      { id: 'T3', reason: 'depends on failed T1' },
    ])
  })

  test('parses an explicit unrecognized status as unknown and blocks its dependents', () => {
    const tasks = parseTasks(`## T1: malformed
- Files: a.ts
- Status: almost-done

## T2: dependent
- Depends on: T1
- Files: b.ts
- Status: pending
`)

    const result = computeWaves(tasks)

    expect(tasks[0].status).toBe('unknown')
    expect(result.waves).toEqual([])
    expect(result.blocked).toEqual([
      { id: 'T1', reason: 'status unknown' },
      { id: 'T2', reason: 'depends on unknown T1' },
    ])
  })

  test('lists in-progress tasks separately and blocks their transitive dependents as waiting', () => {
    const tasks = parseTasks(`## T1: active
- Files: a.ts
- Status: in-progress

## T2: direct dependent
- Depends on: T1
- Files: b.ts
- Status: pending

## T3: transitive dependent
- Depends on: T2
- Files: c.ts
- Status: pending
`)

    const result = computeWaves(tasks)

    expect(result.waves).toEqual([])
    expect(result.inProgress).toEqual(['T1'])
    expect(result.blocked).toEqual([
      { id: 'T2', reason: 'waits on in-progress T1' },
      { id: 'T3', reason: 'waits on in-progress T1' },
    ])
  })

  test('schedules a parsed task with no Status line as pending for backwards compatibility', () => {
    const tasks = parseTasks('## T1: legacy\n- Depends on: —\n- Files: a.ts\n')

    const result = computeWaves(tasks)

    expect(tasks[0].status).toBe('pending')
    expect(result.waves).toEqual([['T1']])
  })
})

describe('renderWaves', () => {
  test('summarizes waves and flags parallel ones', () => {
    const out = renderWaves(computeWaves(parseTasks(TASKS)))

    expect(out).toContain('Wave 1')
    expect(out).toMatch(/T1.*T2/) // T1 and T2 batch in wave 1
    expect(out).toContain('T3')
    expect(out).toContain('Blocked: none')
    expect(out).toContain('In progress: none')
  })

  test('prints blocked and in-progress scheduling state', () => {
    const result = computeWaves(parseTasks(`## T1: active
- Files: a.ts
- Status: in-progress

## T2: waiting
- Depends on: T1
- Files: b.ts
- Status: pending
`))

    const out = renderWaves(result)

    expect(out).toContain('- T2: waits on in-progress T1')
    expect(out).toContain('In progress: T1')
  })

  test('prints a failed root task under Blocked even when it has no dependents', () => {
    const result = computeWaves(parseTasks(`## T1: failed root
- Files: a.ts
- Status: failed
`))

    const out = renderWaves(result)

    expect(result.waves).toEqual([])
    expect(result.blocked).toEqual([{ id: 'T1', reason: 'status failed' }])
    expect(out).toContain('Blocked:\n- T1: status failed')
  })
})

describe('parseTasks — hardening', () => {
  test('a following non-task section does not bleed into the last task', () => {
    // Without the header reset, "## Notes" bullets would overwrite T1.files/dependsOn.
    const md = `## T1: real
- Files: real.ts

## Notes
- Files: notes.md
- Depends on: T1
`
    const tasks = parseTasks(md)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'T1', files: ['real.ts'], dependsOn: [] })
  })

  test('recognizes a lowercase dependency reference', () => {
    const tasks = parseTasks('## T2: x\n- Depends on: t1\n- Files: a.ts\n')
    expect(tasks[0].dependsOn).toEqual(['T1'])
  })
})

describe('computeWaves — hardening', () => {
  test('rejects duplicate task ids', () => {
    const tasks = [
      { id: 'T1', dependsOn: [], files: ['a.ts'] },
      { id: 'T1', dependsOn: [], files: ['b.ts'] },
    ]
    expect(() => computeWaves(tasks)).toThrow(/duplicate.*T1/i)
  })

  test('falls back to the documented default when maxConcurrency is invalid', () => {
    // 12 disjoint tasks; a broken cap that becomes Infinity would put them all in one wave.
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `T${i + 1}`,
      dependsOn: [],
      files: [`f${i}.ts`],
    }))
    for (const bad of [0, -1, NaN, 'abc' as unknown as number, undefined as unknown as number]) {
      const { waves, maxWidth } = computeWaves(tasks, { maxConcurrency: bad })
      expect(maxWidth).toBeLessThanOrEqual(10) // default cap enforced
      expect(waves.flat()).toHaveLength(12)
    }
  })
})
