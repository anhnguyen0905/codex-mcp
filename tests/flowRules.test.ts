import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import registry from './fixtures/flow-rules.json'

interface PatternProof { clause: string; pattern: string; flags: 'i' | '' }
interface RuleDocument { path: string; patterns: PatternProof[] }
interface FlowRule {
  id: string
  obligation: string
  clauses: string[]
  documents: RuleDocument[]
  singleSource?: string
}
interface FlowRegistry { version: number; rules: FlowRule[] }
type DocumentReader = (documentPath: string) => string
interface RuleFailure { path: string; reason: string }

const data: FlowRegistry = registry
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cases = data.rules.flatMap((rule) => rule.documents.map((document) => ({ rule, document })))
const clauseCases = cases.flatMap(({ rule, document }) => (
  document.patterns.map((proof) => ({ rule, document, proof }))
))

function readText(documentPath: string): string {
  return readFileSync(documentPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function matchCount(text: string, pattern: string, flags: 'i' | ''): number {
  return [...text.matchAll(new RegExp(pattern, `${flags}g`))].length
}

function readRepositoryDocument(documentPath: string): string {
  return normalized(readText(path.resolve(root, documentPath)))
}

function evaluateRule(rule: FlowRule, readDocument: DocumentReader): RuleFailure[] {
  return rule.documents.flatMap((document) => {
    let text: string
    try {
      text = normalized(readDocument(document.path))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [{ path: document.path, reason: `could not read ${document.path}: ${message}` }]
    }
    return document.patterns.flatMap((proof) => {
      try {
        return matchCount(text, proof.pattern, proof.flags) === 1
          ? [] : [{ path: document.path, reason: `clause ${proof.clause} did not match` }]
      } catch {
        return [{ path: document.path, reason: 'invalid pattern' }]
      }
    })
  })
}

/** A one-document rule must justify itself; a multi-document rule must not carry a stale justification. */
function singleSourceProblem(rule: FlowRule): string | null {
  if (rule.documents.length === 1) {
    return /\.$/.test(rule.singleSource ?? '') ? null : 'one-document rule needs a singleSource sentence'
  }
  return rule.singleSource === undefined ? null : 'multi-document rule must not carry singleSource'
}

describe('flow rule registry schema', () => {
  test('uses registry version one', () => {
    // Arrange / Act
    const version = data.version
    // Assert
    expect(version).toBe(1)
  })

  test('contains exactly the required unique rule ids', () => {
    // Arrange / Act
    const ids = data.rules.map((rule) => rule.id)
    // Assert
    expect(ids).toEqual([
      'helper-fail-closed', 'outage-routing', 'cost-inclusion-set', 'done-is-last-write',
      'medium-low-routing', 'resume-selector-reset', 'decision-log-check', 'event-journal-archive',
    ])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('gives every rule a sentence obligation', () => {
    // Arrange / Act
    const obligations = data.rules.map((rule) => rule.obligation)
    // Assert
    for (const obligation of obligations) expect(obligation).toMatch(/\.$/)
  })

  test('lists each obligation clause exactly once', () => {
    for (const rule of data.rules) {
      expect(new Set(rule.clauses).size).toBe(rule.clauses.length)
      for (const clause of rule.clauses) expect(clause.length).toBeGreaterThan(0)
    }
  })

  test('requires every document to prove every clause of its rule exactly once', () => {
    // Arrange / Act / Assert
    for (const rule of data.rules) {
      for (const document of rule.documents) {
        const proven = document.patterns.map((proof) => proof.clause)
        expect(proven, `${rule.id} in ${document.path}`).toEqual(rule.clauses)
      }
    }
  })

  test('requires singleSource only for one-document rules', () => {
    // Arrange / Act / Assert
    for (const rule of data.rules) expect(singleSourceProblem(rule), rule.id).toBeNull()
  })

  test('keeps document paths unique within each rule', () => {
    // Arrange / Act / Assert
    for (const rule of data.rules) {
      const paths = rule.documents.map((document) => document.path)
      expect(new Set(paths).size).toBe(paths.length)
    }
  })

  test('keeps paths repository-relative without parent traversal', () => {
    // Arrange / Act / Assert
    for (const { document } of cases) {
      expect(path.isAbsolute(document.path)).toBe(false)
      expect(document.path).not.toMatch(/(^|[\\/])\.\.([\\/]|$)/)
      expect(document.path).not.toMatch(/^\.claude\/commands\//)
    }
  })

  test('requires every listed document to exist', () => {
    // Arrange / Act / Assert
    for (const { document } of cases) expect(existsSync(path.resolve(root, document.path))).toBe(true)
  })

  test('requires every pattern to compile with declared flags', () => {
    // Arrange / Act / Assert
    for (const { document } of cases) {
      for (const proof of document.patterns) {
        expect(['i', '']).toContain(proof.flags)
        expect(() => new RegExp(proof.pattern, proof.flags)).not.toThrow()
      }
    }
  })

  test('rejects unescaped literal dots outside bounded gap patterns', () => {
    const unescapedLiteralDot = /(?<!\\)\.(?!\{0,\d+\})/
    for (const { document } of cases) {
      for (const proof of document.patterns) {
        const pattern = proof.pattern.replace(/\[\^\.\]\{0,\d+\}/g, '')
        expect(pattern, `${document.path}: ${proof.clause}`).not.toMatch(unescapedLiteralDot)
      }
    }
  })

  test.each([
    ['one document without singleSource', 1, undefined, 'one-document rule needs a singleSource sentence'],
    ['one document with singleSource', 1, 'Only this skill owns the step.', null],
    ['two documents with singleSource', 2, 'Stale justification.', 'multi-document rule must not carry singleSource'],
    ['two documents without singleSource', 2, undefined, null],
  ])('singleSource rule: %s', (_label, documentCount, singleSource, expected) => {
    // Arrange
    const documents = Array.from({ length: documentCount }, (_, index) => ({ path: `d${index}.md`, patterns: [] }))
    const rule: FlowRule = { id: 'synthetic', obligation: 'Synthetic.', clauses: [], documents, singleSource }

    // Act
    const problem = singleSourceProblem(rule)

    // Assert
    expect(problem).toBe(expected)
  })
})

describe('flow rule conformance', () => {
  test.each(cases)('$rule.id is stated by $document.path', ({ document }) => {
    for (const proof of document.patterns) {
      expect(matchCount(readRepositoryDocument(document.path), proof.pattern, proof.flags)).toBe(1)
    }
  })
})

describe('flow rule removal proof', () => {
  test.each(clauseCases)(
    'removing $rule.id $proof.clause from $document.path fails only that clause',
    ({ rule, document, proof }) => {
      const source = readRepositoryDocument(document.path)
      expect(matchCount(source, proof.pattern, proof.flags)).toBe(1)
      const modified = new Map<string, string>([
        [document.path, source.replace(new RegExp(proof.pattern, `${proof.flags}g`), '')],
      ])
      expect(matchCount(modified.get(document.path)!, proof.pattern, proof.flags)).toBe(0)
      const failures = evaluateRule(
        rule,
        (documentPath) => modified.get(documentPath) ?? readRepositoryDocument(documentPath),
      )
      expect(failures).toContainEqual({ path: document.path, reason: `clause ${proof.clause} did not match` })
    },
  )

  test.each(data.rules)('reports every document when all $id statements are removed', (rule) => {
    // Arrange
    const modified = new Map<string, string>()
    for (const document of rule.documents) {
      let source = readRepositoryDocument(document.path)
      for (const proof of document.patterns) {
        source = source.replace(new RegExp(proof.pattern, `${proof.flags}g`), '')
      }
      modified.set(document.path, source)
    }
    // Act
    const failures = evaluateRule(rule, (documentPath) => modified.get(documentPath) ?? '')
    // Assert
    expect(failures.length).toBe(rule.documents.reduce((count, document) => count + document.patterns.length, 0))
  })
})

describe('evaluateRule', () => {
  const rule: FlowRule = {
    id: 'synthetic', obligation: 'A synthetic obligation.', clauses: ['alpha', 'beta'],
    documents: [
      { path: 'one.md', patterns: [{ clause: 'alpha', pattern: 'alpha', flags: 'i' }] },
      { path: 'two.md', patterns: [{ clause: 'beta', pattern: 'beta', flags: '' }] },
    ],
  }

  test('reports no failures when every document matches', () => {
    // Arrange
    const readDocument: DocumentReader = (documentPath) => documentPath === 'one.md' ? 'alpha' : 'beta'
    // Act
    const failures = evaluateRule(rule, readDocument)
    // Assert
    expect(failures).toEqual([])
  })

  test('reports a missing document', () => {
    // Arrange
    const readDocument: DocumentReader = (documentPath) => documentPath === 'one.md' ? 'alpha' : 'none'
    // Act
    const failures = evaluateRule(rule, readDocument)
    // Assert
    expect(failures).toEqual([{ path: 'two.md', reason: 'clause beta did not match' }])
  })

  test('reports an unreadable document without throwing', () => {
    // Arrange
    const readDocument: DocumentReader = () => { throw new Error('unreadable') }
    // Act
    const failures = evaluateRule(rule, readDocument)
    // Assert
    expect(failures).toEqual([
      { path: 'one.md', reason: 'could not read one.md: unreadable' },
      { path: 'two.md', reason: 'could not read two.md: unreadable' },
    ])
  })

  test('reports an invalid pattern distinctly', () => {
    // Arrange
    const invalidRule: FlowRule = {
      ...rule,
      documents: [{ path: 'one.md', patterns: [{ clause: 'bad', pattern: '[', flags: '' }] }],
    }
    // Act
    const failures = evaluateRule(invalidRule, () => 'alpha')
    // Assert
    expect(failures).toEqual([{ path: 'one.md', reason: 'invalid pattern' }])
  })

  test('counts zero, one, two, and case-insensitive occurrences', () => {
    expect(matchCount('none', 'alpha', '')).toBe(0)
    expect(matchCount('alpha', 'alpha', '')).toBe(1)
    expect(matchCount('alpha alpha', 'alpha', '')).toBe(2)
    expect(matchCount('ALPHA', 'alpha', 'i')).toBe(1)
  })

  test('normalizes CRLF and lone CR before evaluating synthetic documents', () => {
    const crRule: FlowRule = {
      id: 'cr', obligation: 'A CR obligation.', clauses: ['line'],
      documents: [{ path: 'cr.md', patterns: [{ clause: 'line', pattern: 'first second', flags: '' }] }],
    }
    const failures = evaluateRule(crRule, () => normalized('first\r\nsecond\rthird'))
    expect(failures).toEqual([])
  })
})
