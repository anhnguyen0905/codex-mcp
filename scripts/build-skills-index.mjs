// Builds a grep-friendly index of local skills so /codex-flow can SELECT the
// few relevant skills for a task instead of blind-loading whole collections.
//
// Usage:
//   node scripts/build-skills-index.mjs [skillRootDir ...] [--out <file>]
//
// Defaults:
//   roots: ~/.claude/skills and ~/claude-skill-library (those that exist)
//   out:   ~/.claude/skill-library/INDEX.md
//
// Index format (one line per skill, grep-friendly):
//   <name> | <description> | <absolute path to SKILL.md>

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '__pycache__', '.venv'])
const MAX_SCAN_DEPTH = 6

const defaultRoots = () => [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), 'claude-skill-library'),
]

const defaultOut = () => path.join(os.homedir(), '.claude', 'skill-library', 'INDEX.md')

const stripQuotes = (value) => value.replace(/^(['"])(.*)\1$/, '$2').trim()

/** Extract { name, description } from a SKILL.md body (frontmatter first, heading fallback). */
export function parseSkillMeta(content) {
  const meta = { name: null, description: null }
  if (!content) return meta

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (frontmatter) {
    const lines = frontmatter[1].split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(name|description):\s*(.+)$/)
      if (!kv || meta[kv[1]]) continue
      if (/^[>|][+-]?$/.test(kv[2].trim())) {
        // YAML folded (>) / literal (|) block scalar: join the indented continuation lines
        const block = []
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
        meta[kv[1]] = block.join(' ')
      } else {
        meta[kv[1]] = stripQuotes(kv[2])
      }
    }
    if (meta.name || meta.description) return meta
  }

  const body = frontmatter ? content.slice(frontmatter[0].length) : content
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (!meta.name && line.startsWith('#')) {
      meta.name = line.replace(/^#+\s*/, '').trim()
      continue
    }
    if (!line.startsWith('#')) {
      meta.description = line
      break
    }
  }
  return meta
}

async function collectSkillFiles(dir, depth, found) {
  if (depth > MAX_SCAN_DEPTH) return
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      if (IGNORED_DIRS.has(dirent.name)) continue
      await collectSkillFiles(path.join(dir, dirent.name), depth + 1, found)
    } else if (dirent.name === 'SKILL.md') {
      found.push(path.join(dir, 'SKILL.md'))
    }
  }
}

/** Scan roots for SKILL.md files. Returns { entries, warnings }; missing roots warn, never throw. */
export async function buildIndex(roots) {
  const entries = []
  const warnings = []

  for (const root of roots) {
    const resolved = path.resolve(root)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isDirectory()) {
      warnings.push(`skipped missing root: ${resolved}`)
      continue
    }
    const files = []
    await collectSkillFiles(resolved, 0, files)
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8').catch(() => '')
      const meta = parseSkillMeta(content)
      entries.push({
        name: meta.name ?? path.basename(path.dirname(file)),
        description: meta.description ?? '(no description)',
        file,
      })
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, warnings }
}

const sanitizeField = (text) => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '/').trim()

/** Parse an INDEX.md/REMOTE.md catalog back into { name, description, file } entries. */
export function parseCatalog(content) {
  const entries = []
  for (const line of (content ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const fields = line.split(' | ')
    if (fields.length < 3) continue
    entries.push({
      name: fields[0].trim(),
      description: fields.slice(1, -1).join(' | ').trim(),
      file: fields[fields.length - 1].trim(),
    })
  }
  return entries
}

/**
 * Merge remote catalog entries into locally scanned ones. Local skills (fetched,
 * reviewed, saved to the library) always shadow remote entries with the same name.
 */
export function mergeRemoteEntries(localEntries, catalogContent) {
  const localNames = new Set(localEntries.map((e) => e.name.toLowerCase()))
  const remote = parseCatalog(catalogContent).filter((e) => !localNames.has(e.name.toLowerCase()))
  return [...localEntries, ...remote].sort((a, b) => a.name.localeCompare(b.name))
}

/** Render entries as the grep-friendly INDEX.md content. */
export function renderIndex(entries) {
  const header = [
    '# Skill Index — generated by codex-flow build-skills-index',
    `# Rebuilt: ${new Date().toISOString()}`,
    '# Format: <name> | <description> | <SKILL.md path>',
    '',
  ]
  const lines = entries.map(
    (e) => `${sanitizeField(e.name)} | ${sanitizeField(e.description)} | ${e.file}`,
  )
  return [...header, ...lines, ''].join('\n')
}

/** Parse argv, build and write the index. Returns { count, out, warnings }. */
export async function runCli(argv) {
  const roots = []
  let out = null
  let remote = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out' || arg === '-o') {
      out = argv[++i]
      if (!out) throw new Error(`${arg} requires a file path`)
    } else if (arg === '--remote' || arg === '-r') {
      remote = argv[++i]
      if (!remote) throw new Error(`${arg} requires a file path`)
    } else {
      roots.push(arg)
    }
  }

  const scanRoots = roots.length > 0 ? roots : defaultRoots()
  const outFile = path.resolve(out ?? process.env.CODEX_FLOW_SKILLS_INDEX ?? defaultOut())

  const { entries: localEntries, warnings } = await buildIndex(scanRoots)

  // The remote catalog (synced from awesome-claude-skills) is the foundation layer;
  // locally vetted skills shadow it by name.
  const remoteFile = remote ?? path.join(path.dirname(outFile), 'REMOTE.md')
  const catalogContent = await fs.readFile(path.resolve(remoteFile), 'utf8').catch(() => '')
  const entries = mergeRemoteEntries(localEntries, catalogContent)

  if (entries.length === 0) {
    throw new Error(
      `no skills found under: ${scanRoots.join(', ')} — pass skill directories as arguments`,
    )
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, renderIndex(entries), 'utf8')
  return { count: entries.length, local: localEntries.length, out: outFile, warnings }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then(({ count, local, out, warnings }) => {
      for (const warning of warnings) console.warn(`⚠ ${warning}`)
      console.log(`Indexed ${count} skill(s) (${local} local, ${count - local} remote) → ${out}`)
    })
    .catch((error) => {
      console.error(`build-skills-index: ${error.message}`)
      process.exit(1)
    })
}
