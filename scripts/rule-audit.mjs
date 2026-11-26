import { promises as fs, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { FLOW_COMMAND_PATH, flowSkillNames } from './flow-skill-map.mjs'

const rulePattern = /\b(MUST|NEVER|ALWAYS)\b/i
const normalizedText = (text) => text.trim().replace(/\s+/g, ' ')
const ruleSources = new WeakMap()
const readFlag = (args, flag) => {
  const index = args.indexOf(flag)
  const value = index < 0 ? undefined : args[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export function extractRules(text, file) {
  const source = text.replace(/\r\n/g, '\n')
  const spans = []
  const structuralLines = new Set()
  let inFence = false
  source.split('\n').forEach((line, index) => {
    const isFence = /^\s*```/.test(line)
    if (isFence || inFence || /^\s*(?:[-*+]\s+|\|.*\||#{1,6}\s)/.test(line)) structuralLines.add(index + 1)
    if (isFence) inFence = !inFence
  })
  const add = (value, line, start) => {
    if (rulePattern.test(value)) spans.push({ text: normalizedText(value), line, start, raw: value })
  }
  source.split('\n').forEach((line, index) => {
    if (structuralLines.has(index + 1)) add(line, index + 1, source.split('\n').slice(0, index).join('\n').length + (index ? 1 : 0))
  })
  for (const match of source.matchAll(/[^.!?\n]*[.!?](?=\s|$)/g)) {
    const line = source.slice(0, match.index).split('\n').length
    if (!structuralLines.has(line)) add(match[0], line, match.index)
  }
  const counts = new Map()
  return spans.map(({ text, line, start, raw }) => {
    const count = (counts.get(text) ?? 0) + 1
    counts.set(text, count)
    const suffix = count === 1 ? '' : `-${count}`
    const hash = createHash('sha256').update(`${file}\n${text}`).digest('hex').slice(0, 10)
    const rule = { id: `R-${hash}${suffix}`, file, line, bytes: Buffer.byteLength(text), text }
    ruleSources.set(rule, { start, raw })
    return rule
  })
}

export async function listRules(root = process.cwd()) {
  const files = [FLOW_COMMAND_PATH, ...flowSkillNames().map((name) => `skills/${name}/SKILL.md`)]
  const rules = []
  for (const relative of files) rules.push(...extractRules(await fs.readFile(path.join(root, relative), 'utf8'), relative))
  return rules
}

export async function ablateRule(root, id, outDir) {
  const rules = await listRules(root)
  const rule = rules.find((candidate) => candidate.id === id)
  if (!rule) throw new Error(`unknown rule id: ${id}`)
  const destination = path.resolve(outDir)
  const realRoot = realpathSync(path.resolve(root))
  let nearest = destination
  while (!existsSync(nearest)) nearest = path.dirname(nearest)
  const realDestination = path.join(realpathSync(nearest), path.relative(nearest, destination))
  const relative = path.relative(realRoot, realDestination)
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('output directory must be outside the repository root')
  await fs.cp(path.join(root, 'commands'), path.join(destination, 'commands'), { recursive: true })
  await fs.cp(path.join(root, 'skills'), path.join(destination, 'skills'), { recursive: true })
  const target = path.join(destination, rule.file)
  const content = await fs.readFile(target, 'utf8')
  const source = ruleSources.get(rule)
  if (!source || content.slice(source.start, source.start + source.raw.length) !== source.raw) throw new Error('rule source span changed')
  await fs.writeFile(target, content.slice(0, source.start) + content.slice(source.start + source.raw.length), 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const root = readFlag(args, '--root') ?? process.cwd()
  const run = async () => {
    if (args[0] === 'list') {
      const rules = await listRules(root)
      const totals = { count: rules.length, bytes: rules.reduce((sum, rule) => sum + rule.bytes, 0) }
      if (args.includes('--json')) process.stdout.write(JSON.stringify({ rules, totals }) + '\n')
      else process.stdout.write(rules.map((rule) => `${rule.id} ${rule.file}:${rule.line} ${rule.bytes} ${rule.text}`).concat(`rules: ${totals.count} bytes: ${totals.bytes}`).join('\n') + '\n')
      return
    }
    if (args[0] === 'ablate') {
      const id = readFlag(args, '--rule')
      const out = readFlag(args, '--out')
      if (!id || !out) throw new Error('usage: ablate requires --rule <id> and --out <dir>')
      await ablateRule(root, id, out)
    }
    else throw new Error('usage: rule-audit.mjs list [--json] [--root <dir>] | ablate --rule <id> --out <dir>')
  }
  run().catch((error) => { process.stderr.write(`rule-audit: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2 })
}
