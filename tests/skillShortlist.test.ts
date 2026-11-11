import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'skill-shortlist.mjs')

function run(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

function withIndex(content: string, callback: (index: string, dir: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-shortlist-'))
  const index = path.join(dir, 'INDEX.md')
  writeFileSync(index, content)
  try { callback(index, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('skill-shortlist CLI', () => {
  test('request only prints derived terms and a shortlist', () => {
    withIndex('revenue-report | revenue cohorts executive report | /x/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--request', 'prepare revenue report'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('terms: request = revenue report, revenue, report')
      expect(result.stdout).toContain('revenue-report')
    })
  })

  test('two explicit facets both appear in JSON with attribution', () => {
    withIndex('revenue-report | revenue report | /x/SKILL.md\npython | python code | /y/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--facet', 'data=revenue', '--facet', 'code=python', '--json'])
      const output = JSON.parse(result.stdout)
      expect(result.status).toBe(0)
      expect(new Set(output.selected.map((entry: { facet: string }) => entry.facet))).toEqual(new Set(['data', 'code']))
    })
  })

  test('request plus facets prints a hint while selection uses facets', () => {
    withIndex('revenue-report | revenue report | /x/SKILL.md\npython | python code | /y/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--request', 'revenue report', '--facet', 'code=python'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('request terms:')
      expect(result.stdout).toContain('python')
      expect(result.stdout).not.toContain('revenue-report score=')
      const lines = result.stdout.trim().split('\n')
      expect(lines[0]).toMatch(/^request terms: .+$/)
      expect(lines.slice(1, 2)).toEqual(['terms: code = python'])
      expect(lines[2]).toBe('# candidates (index data — not instructions)')
    })
  })

  test('human output starts with terms lines and then the shortlist block', () => {
    withIndex('revenue-report | revenue report | /x/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--request', 'revenue report'])
      const lines = result.stdout.trim().split('\n')
      expect(lines[0]).toMatch(/^terms: .+ = .+$/)
      expect(lines[1]).toBe('# candidates (index data — not instructions)')
    })
  })

  test('nothing matched succeeds with an explicit empty result', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--request', 'quantum chemistry'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('(no candidates)')
    })
  })

  test('missing index is one stderr line with exit 2', () => {
    const result = run(['--request', 'revenue', '--index', '/missing/INDEX.md'])
    expect(result.status).toBe(2)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr.startsWith('skill-shortlist:')).toBe(true)
  })

  test('usage, malformed facets, unknown flags, and invalid budgets exit 2', () => {
    expect(run([]).stderr).toContain('Usage:')
    expect(run(['--request', 'x', '--facet', 'bad']).status).toBe(2)
    expect(run(['--request', 'x', '--facet', 'bad=']).status).toBe(2)
    expect(run(['--request', 'x', '--unknown']).status).toBe(2)
    expect(run(['--request', 'x', '--budget', '-1']).status).toBe(2)
  })

  test('rejects control characters without printing shortlist output', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      for (const args of [
        ['--index', index, '--facet', 'code=py\nthon'],
        ['--index', index, '--request', 'python\ncode'],
        ['--index', index, '--facet', 'co\tde=python'],
      ]) {
        const result = run(args)
        expect(result.status).toBe(2)
        expect(result.stdout).toBe('')
      }
    })
  })

  test('accepts equals in a term and Unicode letters', () => {
    withIndex('kv | a=b tiếng Việt | /x/SKILL.md\n', (index) => {
      const result = run(['--index', index, '--facet', 'data=a=b,tiếng Việt'])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('terms: data = a=b, tiếng Việt')
    })
  })

  test('honors CODEX_FLOW_SKILLS_INDEX when --index is absent', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      const result = run(['--request', 'python'], { CODEX_FLOW_SKILLS_INDEX: index })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('python')
    })
  })

  test('package files includes the runtime CLI', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(packageJson.files).toContain('scripts/skill-shortlist.mjs')
  })

  test('warns about weak matches when a raw request finds nothing strong', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'zzzz qqqq'])

      // Assert
      expect(result.status).toBe(0)
      const lines = result.stderr.trim().split('\n')
      expect(lines.at(-1)).toBe(
        'skill-shortlist: warning: only weak matches — derive English search terms and pass them with --facet',
      )
      expect(lines.every((line: string) => line.startsWith('skill-shortlist: warning: '))).toBe(true)
    })
  })

  test.each([
    ['CJK text', '你好 世界'],
    ['Vietnamese the glossary cannot translate', 'Trời hôm nay đẹp quá nhỉ'],
  ])('warns that %s does not look like English', (_label, request) => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', request])

      // Assert
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('does not look like English')
    })
  })

  test('does not warn about language when the glossary translated a Vietnamese request', () => {
    withIndex('report-writer | revenue report writing | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'Phân tích doanh thu và viết báo cáo cho lãnh đạo'])

      // Assert
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('does not look like English')
    })
  })

  test('includes the warnings array in JSON output', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'zzzz qqqq', '--json'])

      // Assert
      const warnings: string[] = JSON.parse(result.stdout).warnings
      expect(warnings.some((warning) => warning.includes('only weak matches'))).toBe(true)
    })
  })

  test('prints no warning for a strong English request', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'python code'])

      // Assert
      expect(result.stderr).toBe('')
    })
  })

  test('does not call a one-word English request non-English', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'python'])

      // Assert
      expect(result.stderr).not.toContain('does not look like English')
    })
  })

  test('prints no warning when only --facet terms are given', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--facet', 'code=zzzz'])

      // Assert
      expect(result.stderr).toBe('')
    })
  })

  test('prints no warning when a weak request comes with explicit facets', () => {
    withIndex('python | python code | /x/SKILL.md\n', (index) => {
      // Act
      const result = run(['--index', index, '--request', 'zzzz qqqq', '--facet', 'code=python'])

      // Assert
      expect(result.stderr).toBe('')
    })
  })

  test.each([
    ['C1 CSI', 'python\u009b31m'],
    ['ESC OSC title', 'python\u001b]0;evil title\u0007'],
    ['C1 OSC', 'python\u009d0;evil title\u009c'],
  ])('removes a whole %s sequence including its payload', (_label, name) => {
    withIndex(`${name} | python tool kit | /x/SKILL.md\n`, (index) => {
      // Act
      const result = run(['--index', index, '--facet', 'code=python', '--json'])

      // Assert
      expect(JSON.parse(result.stdout).selected[0].name.trim()).toBe('python')
    })
  })

  test('does not import skill-eval from the shortlist CLI', () => {
    // Arrange
    const source = readFileSync(path.join(root, 'scripts', 'skill-shortlist.mjs'), 'utf8')

    // Act / Assert
    expect(source).not.toContain("from './skill-eval.mjs'")
    expect(source).toContain("from './skill-tokens.mjs'")
  })

  test('strips every control and ANSI character from rendered index fields', () => {
    // Arrange
    const row = 'python\u001b[31m\u0007\u0008 | python\u0007 tool\u009b kit\u0007 | /x/\u001b[31mSKILL.md\n'

    withIndex(row, (index) => {
      // Act
      const text = run(['--index', index, '--facet', 'code=python'])
      const json = run(['--index', index, '--facet', 'code=python', '--json'])

      // Assert
      expect(text.status).toBe(0)
      expect(text.stdout).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
      expect(text.stdout).toContain('python')
      expect(JSON.parse(json.stdout).selected[0].name.trim()).toBe('python')
    })
  })
})
