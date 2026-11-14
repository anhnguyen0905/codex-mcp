import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { LANGUAGE_TERMS } from '../scripts/language-terms.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { checkLanguage, main } from '../scripts/language-check.mjs'

const tempFile = (contents: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'language-check-'))
  const file = path.join(directory, 'REPORT.md')
  writeFileSync(file, contents)
  return { directory, file }
}

describe('language check', () => {
  it('term list has at least 100 well-formed entries', () => {
    // Arrange
    const domains = ['game', 'iap', 'analytics', 'marketing']

    // Act
    const entries = LANGUAGE_TERMS

    // Assert
    expect(entries.length).toBeGreaterThanOrEqual(100)
    expect(Object.isFrozen(entries)).toBe(true)
    expect(new Set(entries.map((entry) => entry.en.toLowerCase())).size).toBe(entries.length)
    for (const domain of domains) expect(entries.filter((entry) => entry.domain === domain).length).toBeGreaterThanOrEqual(20)
    for (const entry of entries) {
      expect(typeof entry.en).toBe('string')
      expect(typeof entry.allowEnglish).toBe('boolean')
      expect(domains).toContain(entry.domain)
      expect(entry.vi.length).toBeGreaterThan(0)
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.vi)).toBe(true)
      for (const variant of entry.vi) {
        expect(typeof variant).toBe('string')
        expect(variant.toLowerCase()).not.toBe(entry.en.toLowerCase())
      }
    }
  })

  it('Vietnamese variants carry diacritics', () => {
    // Arrange
    const variants = LANGUAGE_TERMS.flatMap((entry) => entry.vi)
    const vietnamese = /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu

    // Act
    const accented = variants.filter((variant) => vietnamese.test(variant))

    // Assert
    expect(accented.length / variants.length).toBeGreaterThanOrEqual(0.8)
  })

  it('reports an untranslated English term in a Vietnamese deliverable with its line', () => {
    // Arrange
    const text = 'Tóm tắt\nConversion rate của funnel là 4%.\n'

    // Act
    const findings = checkLanguage(text, 'vi')

    // Assert
    expect(findings).toEqual([
      { check: 'untranslated-term', term: 'conversion rate', line: 2 },
      { check: 'untranslated-term', term: 'funnel', line: 2 },
    ])
  })

  it('reports a Vietnamese term in an English deliverable', () => {
    // Arrange
    const text = 'The doanh thu increased this quarter.\n'

    // Act
    const findings = checkLanguage(text, 'en')

    // Assert
    expect(findings).toEqual([{ check: 'wrong-language-term', term: 'doanh thu', line: 1 }])
  })

  it.each([
    ['fenced block', '```potential buyer```'],
    ['inline code', '`potential buyer`'],
    ['URL', 'https://example.test/potential-buyer?term=potential%20buyer'],
    ['HTML comment', '<!-- potential buyer -->'],
    ['table header row', '| potential buyer |\n| --- |'],
    ['identifier', 'potential_buyer and potentialBuyer'],
    ['allowEnglish term', 'CR'],
    ['gloss in parentheses', 'người mua tiềm năng (potential buyer)'],
  ])('ignores %s', (_label, ignored) => {
    // Arrange
    const text = `${ignored}\npotential buyer\n`

    // Act
    const findings = checkLanguage(text, 'vi')

    // Assert
    expect(findings).toEqual([{ check: 'untranslated-term', term: 'potential buyer', line: text.split(/\r?\n/).length - 1 }])
  })

  it('matches plural English forms', () => {
    // Arrange
    const text = 'The report contains 10 potential buyers, several repeat buyers, and countries.\n'

    // Act
    const findings = checkLanguage(text, 'vi')

    // Assert
    expect(findings.map((finding) => finding.term)).toEqual(['country', 'potential buyer', 'repeat buyer'])
  })

  it('CRLF input reports the same line numbers as LF', () => {
    // Arrange
    const lf = `${Array.from({ length: 39 }, () => 'Dòng nội dung').join('\n')}\npotential buyer\n`
    const crlf = lf.replace(/\n/g, '\r\n')
    const glossLf = `${Array.from({ length: 29 }, () => 'Dòng nội dung').join('\n')}\nngười mua tiềm năng (potential buyer)\n`
    const glossCrlf = glossLf.replace(/\n/g, '\r\n')

    // Act
    const lfFindings = checkLanguage(lf, 'vi')
    const crlfFindings = checkLanguage(crlf, 'vi')
    const glossFindings = checkLanguage(glossCrlf, 'vi')

    // Assert
    expect(lfFindings).toEqual([{ check: 'untranslated-term', term: 'potential buyer', line: 40 }])
    expect(crlfFindings).toEqual(lfFindings)
    expect(glossFindings).toEqual([])
  })

  it('text after a URL on the same line is still checked', () => {
    // Arrange
    const text = 'Xem https://x.y/a để biết potential buyer theo country\n'

    // Act
    const findings = checkLanguage(text, 'vi')

    // Assert
    expect(findings.map((finding) => finding.term)).toEqual(['country', 'potential buyer'])
  })

  it('longest term wins on overlap', () => {
    // Arrange
    const conversion = 'Conversion rate tăng'
    const failure = 'fail events tăng'

    // Act
    const conversionFindings = checkLanguage(conversion, 'vi')
    const failureFindings = checkLanguage(failure, 'vi')

    // Assert
    expect(conversionFindings).toEqual([{ check: 'untranslated-term', term: 'conversion rate', line: 1 }])
    expect(failureFindings.map((finding) => finding.term)).toEqual(['fail event'])
  })

  it('reports one finding per term per line', () => {
    // Arrange
    const text = 'potential buyer và potential buyer\n'

    // Act
    const findings = checkLanguage(text, 'vi')

    // Assert
    expect(findings).toEqual([{ check: 'untranslated-term', term: 'potential buyer', line: 1 }])
  })

  it('English project docs produce no wrong-language findings', () => {
    // Arrange
    const files = ['README.md', 'docs/gate-inventory.md']

    // Act
    const findings = files.flatMap((file) => checkLanguage(readFileSync(file, 'utf8'), 'en'))

    // Assert
    expect(findings).toEqual([])
  })

  it('usage errors exit 2', () => {
    // Arrange
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    let stdout = ''
    let stderr = ''
    process.stdout.write = ((chunk: string) => { stdout += chunk; return true }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) => { stderr += chunk; return true }) as typeof process.stderr.write
    try {
      // Act
      const missingFlag = main(['--language', 'vi'])
      const badLanguage = main(['--deliverable', 'README.md', '--language', 'fr'])
      const missingFile = main(['--deliverable', 'not-a-real-file.md', '--language', 'vi'])

      // Assert
      expect([missingFlag, badLanguage, missingFile]).toEqual([2, 2, 2])
      expect(stderr).toContain('--deliverable is required')
      expect(stderr).toContain('language must be en or vi')
      expect(stdout).toBe('')
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
  })

  it('CLI --json reports status and findings', () => {
    // Arrange
    const failing = tempFile('potential buyer\n')
    const clean = tempFile('người mua tiềm năng\n')
    const originalOut = process.stdout.write
    const originalErr = process.stderr.write
    let stdout = ''
    let stderr = ''
    process.stdout.write = ((chunk: string) => { stdout += chunk; return true }) as typeof process.stdout.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      // Act
      const failExit = main(['--deliverable', failing.file, '--language', 'vi', '--json'])
      const failResult = JSON.parse(stdout)
      stdout = ''
      const passExit = main(['--deliverable', clean.file, '--language', 'vi', '--json'])
      const passResult = JSON.parse(stdout)

      // Assert
      expect(failExit).toBe(1)
      expect(failResult).toEqual({ status: 'fail', language: 'vi', findings: [{ check: 'untranslated-term', term: 'potential buyer', line: 1 }] })
      expect(passExit).toBe(0)
      expect(passResult.status).toBe('pass')
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
      rmSync(failing.directory, { recursive: true, force: true })
      rmSync(clean.directory, { recursive: true, force: true })
    }
  })
})
