import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// @ts-expect-error — plain .mjs script, not part of the tsc build
import { DOMAIN_KEYWORDS, DOMAIN_TAGS_DEFAULT, SKILL_DOMAINS, domainTagGate, requestDomains } from '../scripts/skill-domains.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { buildDocFrequency, matchDetail, selectSkills } from '../scripts/skill-match.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { filterScenarios } from '../scripts/skill-eval.mjs'

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures')
const scenarioFiles = fs.readdirSync(fixtureDir).filter((file) => /^scenarios-.*\.json$/.test(file))
const allScenarios = scenarioFiles.flatMap((file) => JSON.parse(
  fs.readFileSync(path.join(fixtureDir, file), 'utf8'),
).scenarios)

describe('domain-tag skill selection', () => {
  it('tag map covers every expectAny skill and every plugin skill', () => {
    // Arrange
    const expected = new Set(allScenarios.flatMap((scenario) => scenario.expectAny ?? []))
    const pluginSkills = fs.readdirSync(path.join(process.cwd(), 'skills')).filter((name) => fs.existsSync(
      path.join(process.cwd(), 'skills', name, 'SKILL.md'),
    ))

    // Act
    const missing = [...new Set([...expected, ...pluginSkills])].filter((name) => !SKILL_DOMAINS[name])

    // Assert
    expect(missing).toEqual([])
    expect(Object.values(SKILL_DOMAINS).every((domains) => domains.length >= 1 && domains.length <= 2)).toBe(true)
  })

  it('plugin skill tags are supported by their own description', () => {
    // Arrange
    const skillsDir = path.join(process.cwd(), 'skills')

    // Act
    const unsupported = fs.readdirSync(skillsDir).flatMap((name) => {
      const file = path.join(skillsDir, name, 'SKILL.md')
      if (!fs.existsSync(file)) return []
      const frontmatter = fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .filter((line) => line.startsWith('name:') || line.startsWith('description:')).join(' ').toLowerCase()
      return SKILL_DOMAINS[name].filter((domain) => !DOMAIN_KEYWORDS[domain].some((keyword) => frontmatter.includes(keyword.toLowerCase())))
        .map((domain) => `${name}:${domain}`)
    })

    // Assert
    expect(unsupported).toEqual([])
  })

  it('requestDomains reads English and Vietnamese requests', () => {
    // Arrange / Act
    const cases = [
      ['Build a dashboard and analyze retention data', ['data', 'viz']],
      ['Plan a marketing campaign with a budget', ['finance', 'marketing']],
      ['Tôi cần lập ngân sách gia đình và quỹ khẩn cấp', ['finance', 'personal']],
      ['lap ke hoach kho hang va giao hang', ['logistics', 'product']],
    ]

    // Assert
    for (const [request, expected] of cases) expect(requestDomains(request)).toEqual(expected)
  })

  it('the boost changes ranking only when domain tags are on', () => {
    // Arrange
    const entries = [
      { name: 'd3-viz', description: 'Metrics analysis guidance', tokens: 1 },
      { name: 'data-quality-checks', description: 'Metrics analysis checks', tokens: 1 },
    ]

    // Act
    const off = selectSkills(entries, ['metrics analysis'], { tokenBudget: 2, domainTags: false })
    const on = selectSkills(entries, ['metrics analysis'], { tokenBudget: 2, domainTags: true })

    // Assert
    expect(off[0].name).toBe('d3-viz')
    expect(on[0].name).toBe('data-quality-checks')
  })

  it('domain tags off keeps selectSkills output unchanged', () => {
    // Arrange
    const entries = [
      { name: 'd3-viz', description: 'Metrics chart guidance', tokens: 1 },
      { name: 'data-quality-checks', description: 'Data quality checks', tokens: 1 },
    ]

    // Act / Assert
    for (const scenario of allScenarios.filter((item) => item.request)) {
      const terms = scenario.terms ?? []
      const off = selectSkills(entries, terms, { domainTags: false })
      const flatTerms = terms.flatMap((term) => typeof term === 'string' ? [term] : term.terms)
      const stats = buildDocFrequency(entries)
      for (const selected of off) {
        const entry = entries.find((candidate) => candidate.name === selected.name)
        expect(selected.score).toBe(matchDetail(entry, flatTerms, stats).score)
      }
    }
    expect(allScenarios.some((scenario) => {
      const terms = scenario.terms ?? []
      const flatTerms = terms.flatMap((term) => typeof term === 'string' ? [term] : term.terms)
      const domains = new Set(requestDomains(flatTerms.join(' ')))
      const on = selectSkills(entries, terms, { domainTags: true })
      return on.some((selected) => (SKILL_DOMAINS[selected.name] ?? []).some((domain) => domains.has(domain))
        && selected.score > matchDetail(entries.find((entry) => entry.name === selected.name), flatTerms, buildDocFrequency(entries)).score)
    })).toBe(true)
  })

  it('domainTagGate truth table', () => {
    // Arrange / Act / Assert
    const base = { hit1: 0.5, pass: 0.8 }
    expect(domainTagGate({ en: { on: { hit1: 0.53, pass: 0.8 }, off: base }, vi: { on: { hit1: 0.53, pass: 0.8 }, off: base } }).enable).toBe(true)
    expect(domainTagGate({ en: { on: { hit1: 0.53, pass: 0.8 }, off: base }, vi: { on: base, off: base } }).enable).toBe(false)
    expect(domainTagGate({ en: { on: base, off: base }, vi: { on: { hit1: 0.53, pass: 0.8 }, off: base } }).enable).toBe(false)
    expect(domainTagGate({ en: { on: { hit1: 0.53, pass: 0.79 }, off: base }, vi: { on: { hit1: 0.53, pass: 0.8 }, off: base } }).enable).toBe(false)
    expect(domainTagGate({ en: { on: { hit1: 0.52, pass: 0.8 }, off: base }, vi: { on: { hit1: 0.52, pass: 0.8 }, off: base } }).enable).toBe(true)
    expect(domainTagGate({ en: { on: { hit1: 0.519, pass: 0.8 }, off: base }, vi: { on: { hit1: 0.519, pass: 0.8 }, off: base } }).enable).toBe(false)
  })

  it('DOMAIN_TAGS_DEFAULT matches the decision recorded in the eval report', () => {
    // Arrange
    const report = fs.readFileSync(path.join(process.cwd(), 'docs', 'skill-selection-eval-report.md'), 'utf8')
    const section = report.slice(report.indexOf('## Domain tags gate (2026-11-14)'))

    // Act
    const decision = section.match(/DOMAIN_TAGS_DEFAULT\s*=\s*(true|false)/)?.[1]

    // Assert
    expect(decision).toBe(String(DOMAIN_TAGS_DEFAULT))
  })

  it('skill-eval filters by language and split', () => {
    // Arrange
    const holdout = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'scenarios-holdout.json'), 'utf8')).scenarios
    const vi = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'scenarios-vi.json'), 'utf8')).scenarios

    // Act
    const enUsed = filterScenarios(holdout, { language: 'en' })
    const viUsed = filterScenarios([...holdout, ...vi], { split: 'holdout', language: 'vi' })

    // Assert
    expect(enUsed).toHaveLength(70)
    expect(viUsed).toHaveLength(82)
  })
})
