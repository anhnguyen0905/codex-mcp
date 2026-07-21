// Builds a grep-friendly index of local skills so /codex-flow can SELECT the
// few relevant skills for a task instead of blind-loading whole collections.
//
// Usage:
//   node scripts/build-skills-index.mjs [skillRootDir ...] [--out <file>] [--remote <file>]
//   node scripts/build-skills-index.mjs --vet <SKILL.md path> [--manifest <file>]
//
// Defaults:
//   roots: ~/.claude/skills and ~/claude-skill-library (those that exist)
//   out:   ~/.claude/skill-library/INDEX.md
//
// Index format (one line per skill, grep-friendly):
//   <name> | <description> | <absolute path to SKILL.md> [| vetted:<true|false>]
//
// SECURITY MODEL (skill supply chain):
//   - Directories named `quarantine` are NEVER indexed. sync-awesome-skills --clone
//     lands third-party repos in <lib>/quarantine/remote/; promotion out of
//     quarantine happens only through the explicit vet flow below.
//   - Symlinked SKILL.md dirents are rejected (lstat semantics via readdir dirents),
//     and every indexed file's realpath must resolve inside its scan root —
//     anything else is skipped with a warning.
//   - Remote-origin rule: an entry is remote-origin when its path relative to a
//     scan root contains a `remote` or `quarantine` path segment. Remote-origin
//     entries are verified against the vet manifest `<root>/vetted.json` and
//     marked `vetted:true` only when the recorded sha256 matches the current
//     SKILL.md content; a missing record or hash mismatch (e.g. after `git pull`)
//     yields `vetted:false` plus a stderr warning. Local (non-remote) skills are
//     indexed exactly as before and never require a manifest.
//   - URL pointer entries merged from REMOTE.md are never loadable directly; they
//     must be cloned (into quarantine) and vetted before use.
//
// vetted.json format (flat map, keyed by absolute SKILL.md path):
//   { "<path>": { "gitCommit": "<sha|null>", "sha256": "<hex>", "vettedAt": "<ISO>" } }
//
// `--vet` computes that record for one SKILL.md and writes it into the manifest
// (derived from the path's `remote`/`quarantine` segment unless --manifest is given).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '__pycache__', '.venv'])
const MAX_SCAN_DEPTH = 6
const QUARANTINE_DIR_NAME = 'quarantine'
const REMOTE_DIR_NAME = 'remote'
const VET_MANIFEST_NAME = 'vetted.json'

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

/** sha256 hex digest of a SKILL.md content string. */
export const sha256Of = (content) => createHash('sha256').update(content ?? '', 'utf8').digest('hex')

/**
 * Compute a vet record pinning a SKILL.md to its current content: sha256 of the
 * file, HEAD commit of the enclosing git checkout (null when not a checkout),
 * and the vetting timestamp.
 */
export async function computeVetRecord(skillFile) {
  const resolved = path.resolve(skillFile)
  const content = await fs.readFile(resolved, 'utf8')
  let gitCommit = null
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      path.dirname(resolved),
      'rev-parse',
      'HEAD',
    ])
    gitCommit = stdout.trim()
  } catch {
    gitCommit = null // not inside a git checkout — hash pinning still applies
  }
  return { gitCommit, sha256: sha256Of(content), vettedAt: new Date().toISOString() }
}

/** A record verifies only when its pinned sha256 matches the current content. */
export function verifyVetRecord(record, content) {
  return Boolean(record?.sha256) && record.sha256 === sha256Of(content)
}

/** Load `<root>/vetted.json`. Missing file is normal ({}), corrupt file warns. */
export async function loadVetManifest(manifestFile) {
  let raw
  try {
    raw = await fs.readFile(manifestFile, 'utf8')
  } catch {
    return { records: {}, warning: null } // no manifest yet — every remote entry is unvetted
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { records: {}, warning: `ignored malformed vet manifest (not an object): ${manifestFile}` }
    }
    return { records: parsed, warning: null }
  } catch (error) {
    return { records: {}, warning: `ignored unreadable vet manifest ${manifestFile}: ${error.message}` }
  }
}

/** True when a root-relative path crosses a remote/ or quarantine/ segment. */
export function isRemoteOrigin(relPath) {
  return relPath
    .split(path.sep)
    .some((segment) => segment === REMOTE_DIR_NAME || segment === QUARANTINE_DIR_NAME)
}

/**
 * Resolve a candidate file's realpath and require it to stay inside the scan
 * root. Returns { real, warning } — real is null when the file must be skipped.
 */
export async function resolveInsideRoot(file, rootReal) {
  let real
  try {
    real = await fs.realpath(file)
  } catch (error) {
    return { real: null, warning: `skipped unresolvable SKILL.md: ${file} (${error.message})` }
  }
  const rel = path.relative(rootReal, real)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      real: null,
      warning: `skipped SKILL.md whose realpath escapes the index root: ${file} -> ${real}`,
    }
  }
  return { real, warning: null }
}

async function collectSkillFiles(dir, depth, found, warnings) {
  if (depth > MAX_SCAN_DEPTH) return
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name)
    if (dirent.isSymbolicLink()) {
      // readdir dirents carry lstat semantics: symlinks are reported as
      // symlinks, never as files/dirs — reject them before any readFile.
      warnings.push(`skipped symlink (symlinked skills are not indexed): ${full}`)
      continue
    }
    if (dirent.isDirectory()) {
      if (dirent.name === QUARANTINE_DIR_NAME) {
        warnings.push(`skipped quarantine directory (unvetted clones are never indexed): ${full}`)
        continue
      }
      if (IGNORED_DIRS.has(dirent.name)) continue
      await collectSkillFiles(full, depth + 1, found, warnings)
    } else if (dirent.name === 'SKILL.md' && dirent.isFile()) {
      found.push(full)
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
    const rootReal = await fs.realpath(resolved)
    let manifest = null // lazy-loaded once per root, only when a remote-origin entry appears
    const files = []
    await collectSkillFiles(resolved, 0, files, warnings)
    for (const file of files) {
      const { real, warning } = await resolveInsideRoot(file, rootReal)
      if (!real) {
        warnings.push(warning)
        continue
      }
      const content = await fs.readFile(real, 'utf8').catch(() => '')
      const meta = parseSkillMeta(content)
      const entry = {
        name: meta.name ?? path.basename(path.dirname(file)),
        description: meta.description ?? '(no description)',
        file,
      }
      if (isRemoteOrigin(path.relative(rootReal, real))) {
        if (manifest === null) {
          manifest = await loadVetManifest(path.join(resolved, VET_MANIFEST_NAME))
          if (manifest.warning) warnings.push(manifest.warning)
        }
        const record = manifest.records[path.resolve(file)] ?? manifest.records[real]
        const vetted = verifyVetRecord(record, content)
        if (!vetted) {
          warnings.push(`unvetted remote skill (vet before loading, see vetted.json): ${file}`)
        }
        entries.push({ ...entry, vetted })
      } else {
        entries.push(entry)
      }
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, warnings }
}

const sanitizeField = (text) => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '/').trim()

/**
 * Parse an INDEX.md/REMOTE.md catalog back into { name, description, file }
 * entries; a trailing `vetted:<true|false>` field becomes a boolean `vetted`.
 */
export function parseCatalog(content) {
  const entries = []
  for (const line of (content ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const fields = line.split(' | ')
    if (fields.length < 3) continue
    let end = fields.length
    let vetted
    const vettedMatch = fields[end - 1].trim().match(/^vetted:(true|false)$/)
    if (vettedMatch) {
      if (fields.length < 4) continue
      vetted = vettedMatch[1] === 'true'
      end--
    }
    entries.push({
      name: fields[0].trim(),
      description: fields.slice(1, end - 1).join(' | ').trim(),
      file: fields[end - 1].trim(),
      ...(vetted === undefined ? {} : { vetted }),
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
    '# Format: <name> | <description> | <SKILL.md path> [| vetted:<true|false>]',
    '# Remote-origin entries carry a vetted flag; load ONLY vetted:true remote skills.',
    '',
  ]
  const lines = entries.map(
    (e) =>
      `${sanitizeField(e.name)} | ${sanitizeField(e.description)} | ${e.file}` +
      (typeof e.vetted === 'boolean' ? ` | vetted:${e.vetted}` : ''),
  )
  return [...header, ...lines, ''].join('\n')
}

/**
 * Derive the vet manifest location for a skill path: the parent directory of
 * its `remote`/`quarantine` segment is the library dir holding vetted.json.
 */
function deriveManifestFile(skillFile) {
  const segments = skillFile.split(path.sep)
  const index = segments.findIndex(
    (segment) => segment === REMOTE_DIR_NAME || segment === QUARANTINE_DIR_NAME,
  )
  if (index <= 0) {
    throw new Error(
      `cannot derive the vet manifest for ${skillFile} — the path has no remote/ or quarantine/ segment; pass --manifest <file>`,
    )
  }
  return path.join(segments.slice(0, index).join(path.sep) || path.sep, VET_MANIFEST_NAME)
}

/** Compute + persist a vet record for one SKILL.md. Returns { vetted, manifest, record }. */
async function runVet(skillFile, manifestArg) {
  const resolved = path.resolve(skillFile)
  const record = await computeVetRecord(resolved)
  const manifestFile = path.resolve(manifestArg ?? deriveManifestFile(resolved))
  const { records, warning } = await loadVetManifest(manifestFile)
  if (warning) console.warn(`⚠ ${warning}`)
  const updated = { ...records, [resolved]: record }
  await fs.mkdir(path.dirname(manifestFile), { recursive: true })
  await fs.writeFile(manifestFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  return { vetted: resolved, manifest: manifestFile, record }
}

/**
 * Parse argv, build and write the index — or, with --vet, record a vet pin.
 * Returns { count, out, warnings } (index mode) or { vetted, manifest, record }.
 */
export async function runCli(argv) {
  const roots = []
  let out = null
  let remote = null
  let vet = null
  let manifest = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out' || arg === '-o') {
      out = argv[++i]
      if (!out) throw new Error(`${arg} requires a file path`)
    } else if (arg === '--remote' || arg === '-r') {
      remote = argv[++i]
      if (!remote) throw new Error(`${arg} requires a file path`)
    } else if (arg === '--vet') {
      vet = argv[++i]
      if (!vet) throw new Error(`${arg} requires a SKILL.md path`)
    } else if (arg === '--manifest') {
      manifest = argv[++i]
      if (!manifest) throw new Error(`${arg} requires a file path`)
    } else {
      roots.push(arg)
    }
  }

  if (vet) return runVet(vet, manifest)
  if (manifest) throw new Error('--manifest is only valid together with --vet')

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
    .then((summary) => {
      if (summary.vetted) {
        console.log(`Vetted ${summary.vetted}`)
        console.log(`→ ${summary.manifest} (sha256 ${summary.record.sha256.slice(0, 12)}…)`)
        console.log('Rebuild the index to mark it vetted:true: node scripts/build-skills-index.mjs')
        return
      }
      const { count, local, out, warnings } = summary
      for (const warning of warnings) console.warn(`⚠ ${warning}`)
      console.log(`Indexed ${count} skill(s) (${local} local, ${count - local} remote) → ${out}`)
    })
    .catch((error) => {
      console.error(`build-skills-index: ${error.message}`)
      process.exit(1)
    })
}
