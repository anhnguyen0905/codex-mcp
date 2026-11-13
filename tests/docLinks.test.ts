import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs')

const githubSlug = (heading: string): string => heading
  .toLowerCase()
  .replace(/[^\p{L}\p{N} -]/gu, '')
  .trim().replace(/ /g, '-')

const markdownLinks = (source: string): Array<{ text: string; target: string }> => {
  const links: Array<{ text: string; target: string }> = []
  let inFence = false
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      links.push({ text: match[1], target: match[2].trim().split(/\s+/)[0] })
    }
  }
  return links
}

const headingsIn = (source: string): Set<string> => new Set(
  source.split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .filter((heading): heading is string => Boolean(heading))
    .map(githubSlug),
)

const brokenLinks = (docPath: string): string[] => {
  const broken: string[] = []
  const doc = path.basename(docPath)
  for (const { text, target } of markdownLinks(readFileSync(docPath, 'utf8'))) {
    if (/^(?:https?:|mailto:)/i.test(target)) continue
    const [fileTarget, anchor] = target.split('#', 2)
    const targetPath = path.resolve(path.dirname(docPath), fileTarget || doc)
    if (!existsSync(targetPath)) {
      broken.push(`${doc}: [${text}](${target}) — target file missing`)
      continue
    }
    if (anchor && !headingsIn(readFileSync(targetPath, 'utf8')).has(anchor)) {
      broken.push(`${doc}: [${text}](${target}) — anchor missing`)
    }
  }
  return broken
}

const tempDoc = (content: string, files: Record<string, string> = {}): string => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doc-links-'))
  const docPath = path.join(directory, 'doc.md')
  writeFileSync(docPath, content)
  for (const [name, fileContent] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), fileContent)
  }
  return docPath
}

describe('documentation links', () => {
  it('slugifies headings using GitHub-style rules', () => {
    // Arrange
    const headings = [
      'Baseline procedure', 'How to read this', 'Run ledger & gate inventory',
      'Quy trình đánh giá', '  Leading and trailing  ',
    ]
    // Act
    const slugs = headings.map(githubSlug)
    // Assert
    expect(slugs).toEqual([
      'baseline-procedure', 'how-to-read-this', 'run-ledger--gate-inventory',
      'quy-trình-đánh-giá', 'leading-and-trailing',
    ])
  })

  it('resolves every relative documentation link and anchor', () => {
    // Arrange
    const docs = readdirSync(docsDir).filter((file) => file.endsWith('.md'))
    // Act / Assert
    for (const doc of docs) {
      const docPath = path.join(docsDir, doc)
      expect(brokenLinks(docPath)).toEqual([])
    }
  })

  it('reports a missing linked file', () => {
    // Arrange
    const docPath = tempDoc('[missing](nope.md)')
    // Act
    const broken = brokenLinks(docPath)
    // Assert
    expect(broken).toEqual(['doc.md: [missing](nope.md) — target file missing'])
  })

  it('reports a missing anchor in an existing file', () => {
    // Arrange
    const docPath = tempDoc('[missing](target.md#nope)', { 'target.md': '# Present\n' })
    // Act
    const broken = brokenLinks(docPath)
    // Assert
    expect(broken).toEqual(['doc.md: [missing](target.md#nope) — anchor missing'])
  })

  it('reports a missing same-file anchor', () => {
    // Arrange
    const docPath = tempDoc('# Present\n\n[missing](#nope)')
    // Act
    const broken = brokenLinks(docPath)
    // Assert
    expect(broken).toEqual(['doc.md: [missing](#nope) — anchor missing'])
  })

  it('accepts a valid temp link and anchor', () => {
    // Arrange
    const docPath = tempDoc('[present](target.md#present)', { 'target.md': '# Present\n' })
    // Act
    const broken = brokenLinks(docPath)
    // Assert
    expect(broken).toEqual([])
  })
})
