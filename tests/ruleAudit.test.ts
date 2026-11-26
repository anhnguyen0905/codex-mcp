import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { extractRules, ablateRule } from '../scripts/rule-audit.mjs'

describe('rule audit', () => {
  it('extracts rules from markdown constructs case-insensitively', () => {
    // Arrange
    const markdown = 'MUST act.\n- NEVER skip\n| ALWAYS check |\n# must title\n```\nnever omit\n```'

    // Act
    const rules = extractRules(markdown, 'fixture.md')

    // Assert
    expect(rules).toHaveLength(5)
  })

  it('keeps unchanged ids stable and suffixes duplicates', () => {
    // Arrange
    const first = extractRules('MUST act.\nMUST act.', 'fixture.md')
    const second = extractRules('ALWAYS change.\nMUST act.\nMUST act.', 'fixture.md')

    // Act
    const ids = second.slice(1).map((rule) => rule.id)

    // Assert
    expect(ids).toEqual([first[0].id, `${first[0].id}-2`])
  })

  it('ablates one rule without changing the source root', async () => {
    // Arrange
    const root = mkdtempSync(join(tmpdir(), 'rule-audit-root-'))
    const commands = join(root, 'commands')
    const skills = join(root, 'skills', 'preflight')
    mkdirSync(commands, { recursive: true })
    mkdirSync(skills, { recursive: true })
    writeFileSync(join(commands, 'codex-flow.md'), 'MUST preserve this.\n')
    writeFileSync(join(skills, 'SKILL.md'), 'ALWAYS verify.\n')
    for (const name of ['fast-path', 'executor-fallback', 'interview-elicitation', 'interview-ask-back', 'plan-research-first', 'plan-architecture', 'skill-selection', 'context-discipline', 'session-report', 'plan-backlog', 'exec-coding-standards', 'exec-self-testing', 'exec-typescript', 'parallel-execution', 'task-loop', 'review-conformance', 'review-quality', 'review-security', 'review-feedback', 'review-dual', 'run-ledger', 'final-review']) {
      mkdirSync(join(root, 'skills', name), { recursive: true })
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), '')
    }
    const rules = extractRules('MUST preserve this.\n', 'commands/codex-flow.md')
    const before = readFileSync(join(commands, 'codex-flow.md'), 'utf8')
    const output = mkdtempSync(join(tmpdir(), 'rule-audit-out-'))

    // Act
    await ablateRule(root, rules[0].id, output)

    // Assert
    expect(readFileSync(join(commands, 'codex-flow.md'), 'utf8')).toBe(before)
    expect(readFileSync(join(output, 'commands', 'codex-flow.md'), 'utf8')).toBe('\n')
  })

  it('ablates the second duplicate and preserves source whitespace', async () => {
    // Arrange
    const root = mkdtempSync(join(tmpdir(), 'rule-audit-duplicate-'))
    mkdirSync(join(root, 'commands'), { recursive: true })
    mkdirSync(join(root, 'skills'), { recursive: true })
    const raw = 'MUST  keep one.\nMUST  keep one.\n'
    writeFileSync(join(root, 'commands', 'codex-flow.md'), raw)
    const names = ['preflight', 'fast-path', 'executor-fallback', 'interview-elicitation', 'interview-ask-back', 'plan-research-first', 'plan-architecture', 'skill-selection', 'context-discipline', 'session-report', 'plan-backlog', 'exec-coding-standards', 'exec-self-testing', 'exec-typescript', 'parallel-execution', 'task-loop', 'review-conformance', 'review-quality', 'review-security', 'review-feedback', 'review-dual', 'run-ledger', 'final-review']
    for (const name of names) {
      mkdirSync(join(root, 'skills', name), { recursive: true })
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), '')
    }
    const second = extractRules(raw, 'commands/codex-flow.md')[1]
    const output = mkdtempSync(join(tmpdir(), 'rule-audit-duplicate-out-'))

    // Act
    await ablateRule(root, second.id, output)

    // Assert
    expect(readFileSync(join(output, 'commands', 'codex-flow.md'), 'utf8')).toBe('MUST  keep one.\n\n')
  })

  it('returns exit 2 for unknown ids, in-root output, symlink output, and missing values', () => {
    // Arrange
    const script = join(process.cwd(), 'scripts', 'rule-audit.mjs')
    const unknown = spawnSync(process.execPath, [script, 'ablate', '--rule', 'R-nope', '--out', tmpdir()], { encoding: 'utf8' })
    const root = mkdtempSync(join(tmpdir(), 'rule-audit-cli-root-'))
    mkdirSync(join(root, 'commands'), { recursive: true })
    mkdirSync(join(root, 'skills', 'preflight'), { recursive: true })
    writeFileSync(join(root, 'commands', 'codex-flow.md'), 'MUST keep.\n')
    const names = ['preflight', 'fast-path', 'executor-fallback', 'interview-elicitation', 'interview-ask-back', 'plan-research-first', 'plan-architecture', 'skill-selection', 'context-discipline', 'session-report', 'plan-backlog', 'exec-coding-standards', 'exec-self-testing', 'exec-typescript', 'parallel-execution', 'task-loop', 'review-conformance', 'review-quality', 'review-security', 'review-feedback', 'review-dual', 'run-ledger', 'final-review']
    for (const name of names) {
      mkdirSync(join(root, 'skills', name), { recursive: true })
      writeFileSync(join(root, 'skills', name, 'SKILL.md'), '')
    }
    const valid = extractRules('MUST keep.\n', 'commands/codex-flow.md')[0].id
    const inside = spawnSync(process.execPath, [script, 'ablate', '--root', root, '--rule', valid, '--out', root], { encoding: 'utf8' })
    const link = join(mkdtempSync(join(tmpdir(), 'rule-audit-link-')), 'out')
    symlinkSync(join(root, 'commands'), link)
    const symlinked = spawnSync(process.execPath, [script, 'ablate', '--root', root, '--rule', valid, '--out', join(link, 'sub')], { encoding: 'utf8' })
    const missing = spawnSync(process.execPath, [script, 'ablate', '--rule'], { encoding: 'utf8' })

    // Act
    const results = [unknown.status, inside.status]

    // Assert
    expect(results).toEqual([2, 2])
    expect(inside.status).toBe(2)
    expect(symlinked.status).toBe(2)
    expect(missing.status).toBe(2)
    expect(readdirSync(join(root, 'commands'))).toEqual(['codex-flow.md'])
  })

  it('reports matching text and JSON totals', () => {
    // Arrange
    const script = join(process.cwd(), 'scripts', 'rule-audit.mjs')
    const text = spawnSync(process.execPath, [script, 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)
    const json = JSON.parse(spawnSync(process.execPath, [script, 'list', '--json'], { encoding: 'utf8' }).stdout)

    // Act
    const match = text.match(/^rules: (\d+) bytes: (\d+)$/)

    // Assert
    expect(match?.slice(1).map(Number)).toEqual([json.totals.count, json.totals.bytes])
  })
})
