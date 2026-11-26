import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')

describe('harness learning documentation', () => {
  it('pins the harness-change rule under Hard conventions', () => {
    // Arrange
    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    // Act
    const conventions = agents.slice(agents.indexOf('## Harness changes (process rule, not CI-enforced)'), agents.indexOf('## Style'))
    // Assert
    expect(conventions).toContain('node scripts/harness-change.mjs add')
  })

  it.each([
    'harness-taxonomy.mjs', 'run-ledger.mjs', 'verifier-guard.mjs', 'trajectory-digest.mjs',
    'playbook.mjs', 'context-slice.mjs', 'harness-change.mjs', 'skill-ablation.mjs',
    'flow-skill-map.mjs', 'rule-audit.mjs', 'skill-match.mjs', 'skill-match-evolve.mjs',
  ])('documents %s in Harness learning', (helper) => {
    // Arrange
    const workflow = readFileSync(path.join(root, 'docs/workflow.md'), 'utf8')
    // Act
    const section = workflow.slice(workflow.indexOf('## Harness learning'), workflow.indexOf('## Profile pilot'))
    // Assert
    expect(section).toContain(helper)
  })
})
