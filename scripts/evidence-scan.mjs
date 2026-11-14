const NUMBER_PATTERN = /[+-]?\d+(?:[.,]\d+)*%?/g

const requireText = (text, name = 'text') => {
  if (typeof text !== 'string') throw new TypeError(`${name} must be a string`)
  return text
}

const maskPattern = (text, pattern) => text.replace(pattern, (match) => match.replace(/[^\n]/g, ' '))

const stripMarkup = (text) => text
  .replace(/```[\s\S]*?(?:```|$)/g, (match) => match.replace(/[^\n]/g, ' '))
  .replace(/`[^`\n]*`/g, (match) => match.replace(/[^\n]/g, ' '))

const maskDates = (text) => {
  let cleaned = text
  cleaned = maskPattern(
    cleaned,
    /\b\d{4}-\d{2}-\d{2}(?:(?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  )
  cleaned = maskPattern(
    cleaned, /\b\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
  )
  cleaned = maskPattern(cleaned, /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)
  cleaned = maskPattern(cleaned, /\b(?:0?[1-9]|1[0-2])\/(?:19\d{2}|20\d{2}|2100)\b/g)
  cleaned = maskPattern(cleaned, /\b(?:19\d{2}|20\d{2}|2100)-(?:0?[1-9]|1[0-2])\b/g)
  return maskPattern(cleaned, /\b(?:19\d{2}|20\d{2}|2100)\b/g)
}

const maskCaptionTableNumbers = (text) => text.split('\n').map((line) => {
  if (!/<!--[Tt]\d+-->/.test(line)) return line
  return line.replace(
    /^\s*(?:\*\*)?(?:Bảng|Table|Hình|Figure|Biểu đồ)\s+\d+(?=[.:])/i,
    (match) => match.replace(/\d+$/, (number) => number.replace(/\d/g, ' ')),
  )
}).join('\n')

const maskIdentifiersAndComments = (text) => maskPattern(
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/^\s*(?:[-*+]\s*)?\d+[.)](?=\s)/gm, (match) => match.replace(/\d/g, ' ')),
  /\b[A-Za-z][A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*/g,
)

export function scanNumberTokens(text) {
  const cleaned = maskIdentifiersAndComments(maskDates(maskCaptionTableNumbers(stripMarkup(requireText(text)))))
  const results = []
  for (const [lineIndex, line] of cleaned.split(/\n/).entries()) {
    for (const match of line.matchAll(NUMBER_PATTERN)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (/[A-Za-z0-9]/.test(line[start - 1] ?? '') || /[A-Za-z0-9]/.test(line[end] ?? '')) continue
      results.push({ literal: match[0], line: lineIndex + 1, column: start + 1 })
    }
  }
  return results
}

const pipeRow = (line) => {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const withoutEnd = body.endsWith('|') ? body.slice(0, -1) : body
  const cells = withoutEnd.split('|').map((cell) => cell.trim())
  return cells.length > 1 ? cells : null
}

const isAlignment = (cells) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))

export function parseAnchors(text) {
  const source = requireText(text)
  const tokens = scanNumberTokens(source)
  const anchors = []
  for (const [lineIndex, line] of source.split(/\n/).entries()) {
    for (const match of line.matchAll(/<!--[Ff](\d+)-->/g)) {
      const anchorStart = match.index ?? 0
      const token = tokens
        .filter(({ line: tokenLine }) => tokenLine === lineIndex + 1)
        .findLast(({ literal, column }) => {
          const tokenStart = column - 1
          const tokenEnd = tokenStart + literal.length
          return tokenEnd <= anchorStart && /^[ \t]*$/.test(line.slice(tokenEnd, anchorStart))
        })
      const literal = token?.literal ?? null
      anchors.push({ id: `F${match[1]}`, literal, line: lineIndex + 1, column: token?.column ?? null })
    }
  }
  return anchors
}

const captionId = (line) => line.match(/<!--[Tt](\d+)-->/)?.[1]

export function parseTables(text) {
  const lines = requireText(text).split(/\n/)
  const tables = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = pipeRow(lines[index])
    const alignment = pipeRow(lines[index + 1])
    if (!header || !alignment || header.length !== alignment.length || !isAlignment(alignment)) continue
    let captionIndex = index - 1
    while (captionIndex >= 0 && lines[captionIndex].trim() === '') captionIndex -= 1
    const id = captionIndex >= 0 ? captionId(lines[captionIndex]) : undefined
    if (!id) continue
    const rows = []
    let bodyIndex = index + 2
    while (bodyIndex < lines.length) {
      const row = pipeRow(lines[bodyIndex])
      if (!row || row.length !== header.length) break
      rows.push(row)
      bodyIndex += 1
    }
    if (rows.length > 0) tables.push({ id: `T${id}`, line: captionIndex + 1, header, rows })
    index = bodyIndex - 1
  }
  return tables
}

export function stripAnchoredRegions(text, tables) {
  const source = requireText(text)
  if (!Array.isArray(tables)) throw new TypeError('tables must be an array')
  const lines = source.split(/\n/)
  const parsed = parseTables(source)
  const ids = new Set(tables.map((table) => table?.id))
  for (const table of parsed) {
    if (!ids.has(table.id)) continue
    const captionIndex = table.line - 1
    let headerIndex = captionIndex + 1
    while (headerIndex < lines.length
      && (!pipeRow(lines[headerIndex])
        || !pipeRow(lines[headerIndex + 1] ?? '')
        || !isAlignment(pipeRow(lines[headerIndex + 1])))) headerIndex += 1
    let end = headerIndex + 2
    while (end < lines.length && pipeRow(lines[end])?.length === table.header.length) end += 1
    for (let index = headerIndex; index < end; index += 1) lines[index] = lines[index].replace(/[^\n]/g, ' ')
  }
  return lines.join('\n')
}
