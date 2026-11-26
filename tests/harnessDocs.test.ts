import { mkdtempSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')

describe('harness learning documentation', () => {
  it('pins the harness-change rule under the Harness changes process-rule section', () => {
    // Arrange
    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    // Act
    const conventions = agents.slice(agents.indexOf('## Harness changes (process rule, not CI-enforced)'), agents.indexOf('## Style'))
    // Assert
    expect(conventions).toContain('node scripts/harness-change.mjs add')
  })

  it('checks that every quoted Harness learning CLI form is accepted by its helper', () => {
    // Arrange
    const workflow = readFileSync(path.join(root, 'docs/workflow.md'), 'utf8')
    const section = workflow.slice(workflow.indexOf('## Harness learning'), workflow.indexOf('## Profile pilot'))
    const forms = [...section.matchAll(/`([\w-]+\.mjs) ([a-z][\w-]*)[^`]*`/gu)].map((match) => ({ script: match[1], command: match[2] }))
    const expected = ['run-ledger.mjs append', 'run-ledger.mjs summary', 'verifier-guard.mjs arm', 'playbook.mjs merge', 'harness-change.mjs add', 'skill-ablation.mjs prompts', 'rule-audit.mjs list']
    const formKeys = new Set(forms.map(({ script, command }) => `${script} ${command}`))
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'harness-docs-'))
    const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'harness-home-'))
    const env = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_MCP_RUN_LEDGER: path.join(tempRoot, 'ledger.jsonl'), CODEX_MCP_HARNESS_CHANGES: path.join(tempRoot, 'changes.jsonl') }

    // Act
    const results = forms.map(({ script, command }) => ({ script, command, result: spawnSync(process.execPath, [path.join(root, 'scripts', script), '__not_a_command__'], { cwd: tempRoot, env, encoding: 'utf8' }) }))

    // Assert
    for (const form of expected) expect(formKeys.has(form), `missing documented CLI form: ${form}`).toBe(true)
    expect(forms.length).toBeGreaterThan(0)
    for (const { script, command, result } of results) {
      expect(result.status, `${script} ${command} should reject an unknown command`).toBe(2)
      expect(result.stderr).toMatch(new RegExp(`\\b${command.replaceAll('.', '\\\\.') }\\b`, 'u'))
    }
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
