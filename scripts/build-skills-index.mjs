// Builds a grep-friendly index of local skills so /codex-flow can SELECT the
// few relevant skills for a task instead of blind-loading whole collections.
//
// Usage:
//   node scripts/build-skills-index.mjs [skillRootDir ...] [--out <file>] [--remote <file>]
//   node scripts/build-skills-index.mjs --vet <SKILL.md path> [--manifest <file>]
//   node scripts/build-skills-index.mjs --vet-repo <dir> [--manifest <file>]
//                                       [--trust <owner>/<repo> ...]
//
// Defaults:
//   roots: ~/.claude/skills, ~/claude-skill-library, and the skills/ dir of every
//          installed plugin (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills,
//          newest version per plugin) — those that exist
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
//   - Installed plugin skills are TRUSTED like ~/.claude/skills: the user chose to
//     install that plugin, and its skills are already loadable by the agent. Indexing
//     them only makes selection aware of what is already on the machine — without it,
//     selection reports "no skill exists" for domains a plugin already covers.
//
// vetted.json format (flat map, keyed by absolute SKILL.md path):
//   { "<path>": { "gitCommit": "<sha|null>", "sha256": "<hex>", "vettedAt": "<ISO>" } }
//
// `--vet` computes that record for one SKILL.md and writes it into the manifest
// (derived from the path's `remote`/`quarantine` segment unless --manifest is given).
//
// `--vet-repo <dir>` is the batch form with risk triage: every SKILL.md under <dir>
// (same symlink/quarantine/containment rules as indexing) is risk-scanned by
// `scanSkillRisk` and attributed to a source repo by `resolveSkillSource`.
// One-file-at-a-time vetting left hundreds of remote skills unvetted — i.e. the gate
// blocked everything instead of controlling anything; triage makes it usable at scale.
//
// AUTO-PIN RULE (two gates, both required):
//   1. the scan is CLEAN, and
//   2. the source repo is allowlisted.
// Anything else is reported, never pinned, with its reason(s) — `risk-findings`,
// `source-not-allowlisted`, or both. Severity alone is not signal: a security or
// fuzzing skill legitimately discusses bypassing safety and piping curl to sh, and a
// research skill legitimately fetches URLs, so provenance decides whether a finding is
// domain-normal or a supply-chain problem.
//
// Source resolution: the enclosing checkout's `origin` remote normalised to
// `owner/repo`, else the `<library>/remote/<owner>__<repo>/…` clone-dir convention.
// Allowlist = union of `--trust <owner>/<repo>` (repeatable), the JSON array at
// `<library>/vet-allowlist.json` when present, and a tiny hardcoded publisher default
// (see DEFAULT_TRUSTED_SOURCES).
//
// `--vet <file>` stays ungated by the allowlist: a human naming one file IS the override.

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
const VET_ALLOWLIST_NAME = 'vet-allowlist.json'

// Sources whose skills may be auto-pinned by --vet-repo when they scan CLEAN. Risk
// severity alone is not signal enough: a security or fuzzing skill legitimately
// discusses bypassing safety and piping downloads to a shell, while an unknown repo
// doing the same is a supply-chain problem. Provenance disambiguates the two.
// Deliberately tiny — extend per machine via --trust or <library>/vet-allowlist.json.
const DEFAULT_TRUSTED_SOURCES = [
  'anthropics/skills', // first-party skills from the vendor of the agent itself
  'trailofbits/skills', // named security firm; its skills discuss attack shapes by design
  'expo/skills', // first-party skills from the Expo platform team
  'obra/superpowers', // widely used reference collection by a known maintainer
  'obra/superpowers-lab', // the same maintainer's experimental companion collection
]

const PLUGIN_CACHE_SEGMENTS = ['.claude', 'plugins', 'cache']
const PLUGIN_SKILLS_DIR_NAME = 'skills'

/**
 * Compare two version directory names newest-last: numeric segment by segment
 * (so 0.10.0 sorts after 0.9.0), falling back to a lexical compare for
 * non-numeric names (e.g. `dev`, `main`).
 */
export function compareVersionDirs(a, b) {
  const parse = (name) => name.split('.').map((segment) => Number.parseInt(segment, 10))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i]
    const r = right[i]
    if (Number.isNaN(l) || Number.isNaN(r) || l === undefined || r === undefined) {
      return a.localeCompare(b)
    }
    if (l !== r) return l - r
  }
  return 0
}

/** Directory names directly under `dir` (no symlinks, sorted). Missing dir → []. */
async function readSubdirNames(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return dirents
    .filter((dirent) => dirent.isDirectory() && !dirent.isSymbolicLink())
    .map((dirent) => dirent.name)
    .sort()
}

/**
 * Discover the skills/ dir of every installed plugin under
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/[<version>/]skills, keeping only
 * the newest version per plugin so multiple cached releases don't duplicate entries.
 */
export async function pluginSkillRoots(homeDir = os.homedir()) {
  const cacheDir = path.join(homeDir, ...PLUGIN_CACHE_SEGMENTS)
  const roots = []
  for (const marketplace of await readSubdirNames(cacheDir)) {
    for (const plugin of await readSubdirNames(path.join(cacheDir, marketplace))) {
      const pluginDir = path.join(cacheDir, marketplace, plugin)
      const unversioned = path.join(pluginDir, PLUGIN_SKILLS_DIR_NAME)
      if (await fs.stat(unversioned).then((s) => s.isDirectory(), () => false)) {
        roots.push(unversioned)
        continue
      }
      const versions = await readSubdirNames(pluginDir)
      const newest = versions.sort(compareVersionDirs).at(-1)
      if (!newest) continue
      const skillsDir = path.join(pluginDir, newest, PLUGIN_SKILLS_DIR_NAME)
      if (await fs.stat(skillsDir).then((s) => s.isDirectory(), () => false)) roots.push(skillsDir)
    }
  }
  return roots
}

/**
 * Scan roots when none are passed: the user's own skills, the skill library, and
 * every installed plugin's skills (all trusted — see the security model above).
 */
export async function defaultRoots(homeDir = os.homedir()) {
  return [
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, 'claude-skill-library'),
    ...(await pluginSkillRoots(homeDir)),
  ]
}

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

// Risk patterns for batch triage. Deliberately small, explicit and line-oriented: a
// hit means "a human must read this file", never "this file is malicious". False
// positives cost one read; a silent pass pins an unread skill as trusted forever.
const RISK_PATTERNS = [
  {
    name: 'override-instructions',
    // Classic prompt injection: the skill body tries to displace prior/system instructions.
    regex:
      /\b(?:ignore|disregard|forget|override|supersede|overrule)\b[^.\n]{0,60}\b(?:previous|prior|earlier|above|all|any|system|operator|user)\b[^.\n]{0,40}\b(?:instruction|prompt|rule|directive|guideline|order)/i,
  },
  {
    name: 'bypass-review-or-safety',
    // A skill should never instruct the agent to route around review, approval or safety gates.
    regex:
      /\b(?:bypass|skip|disable|circumvent|suppress|ignore|avoid|turn off)\b[^.\n]{0,50}\b(?:review|approval|confirmation|permission|safety|guardrail|sandbox|policy|audit|check)/i,
  },
  {
    name: 'remote-exfiltration',
    // A remote URL on the same line as an upload/POST verb is the shape of data leaving the machine.
    regex:
      /(?=[^\n]*https?:\/\/)(?=[^\n]*(?:-X\s*POST|--data\b|--data-binary\b|--upload-file\b|\s-T\s|\bPOST\b|\.post\(|method:\s*['"]?POST))/i,
  },
  {
    name: 'credential-path-access',
    // Reading credential-ish paths is never part of a legitimate skill body.
    regex:
      /(?:~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\.netrc\b|\bkeychain\b|security\s+find-generic-password|(?:^|[\s'"`/=])\.env(?:\.[\w-]+)?\b|\b(?:api[_-]?key|access[_-]?token|secret)s?\.(?:txt|json|ya?ml|env)\b)/i,
  },
  {
    name: 'download-piped-to-shell',
    // `curl … | sh` executes unreviewed remote code with the user's privileges.
    regex: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b/i,
  },
  {
    name: 'opaque-base64-blob',
    // A long unbroken base64 run hides payloads from anyone skimming the skill.
    regex: /[A-Za-z0-9+/]{200,}={0,2}/,
  },
  {
    name: 'destructive-command',
    // Recursive/forced deletion and disk overwrites can destroy the operator's machine.
    regex: /\brm\s+-[a-z]*(?:rf|fr|r\s+-f|f\s+-r)[a-z]*\s+\S|\bmkfs\b|\bdd\s+if=\S+\s+of=\/dev\/|\bgit\s+push\s+--force\b/i,
  },
  {
    name: 'write-outside-workspace',
    // Writing to home dotfiles or system dirs persists behaviour beyond the current task.
    regex:
      /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bwriteFile\b|\bwrite_text\b|\b(?:append|write|add|install|persist|save|copy)\b[^.\n]{0,40})\s*['"]?(?:~\/\.[\w.-]+|\/(?:etc|usr|bin|sbin|var|Library|System)\/)/i,
  },
]

const MAX_EXCERPT_LENGTH = 160

/**
 * Risk-scan a SKILL.md body for prompt-injection / exfiltration / destructive shapes.
 * Returns { findings: [{ pattern, line, excerpt }] } — one finding per pattern per
 * matching line, `line` being 1-based. An empty findings array means CLEAN.
 */
export function scanSkillRisk(content) {
  const findings = []
  const lines = (content ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    for (const { name, regex } of RISK_PATTERNS) {
      if (!regex.test(line)) continue
      findings.push({
        pattern: name,
        line: i + 1,
        excerpt: line.trim().slice(0, MAX_EXCERPT_LENGTH),
      })
    }
  }
  return { findings }
}

/**
 * Normalise a git remote URL to a lowercase `owner/repo`. Handles scp-style
 * (`git@host:owner/repo.git`), URL-style (`https://host/owner/repo.git`) and
 * credentialed URLs. Returns null when no owner/repo pair can be read.
 */
export function normalizeGitRemote(url) {
  if (!url) return null
  const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!trimmed) return null
  const scp = trimmed.match(/^[\w.-]+@[^:/]+:(.+)$/) // git@github.com:owner/repo
  const withoutHost = scp
    ? scp[1]
    : trimmed.replace(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?[^/]+\//i, '') // scheme://[user@]host/
  const segments = withoutHost.split('/').filter(Boolean)
  if (segments.length < 2) return null
  return `${segments.at(-2)}/${segments.at(-1)}`.toLowerCase()
}

/**
 * Read `owner/repo` out of the `<library>/remote/<owner>__<repo>/…` layout that
 * sync-awesome-skills clones into — the fallback when a skill dir is not a git
 * checkout (e.g. the .git dir was stripped). Returns null when absent.
 */
export function sourceFromClonePath(skillFile) {
  const segments = path.resolve(skillFile).split(path.sep)
  for (let i = segments.length - 1; i >= 0; i--) {
    const match = segments[i].match(/^([\w.-]+)__([\w.-]+)$/)
    if (match) return `${match[1]}/${match[2]}`.toLowerCase()
  }
  return null
}

/**
 * Resolve which repo a SKILL.md came from: the enclosing checkout's `origin`
 * remote first (authoritative), else the `owner__repo` clone-dir convention.
 * `cache` memoises the git lookup per directory across a batch run.
 */
export async function resolveSkillSource(skillFile, cache = new Map()) {
  const dir = path.dirname(path.resolve(skillFile))
  if (!cache.has(dir)) {
    let origin = null
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin'])
      origin = normalizeGitRemote(stdout)
    } catch {
      origin = null // not a checkout, or no origin remote — fall back to the path convention
    }
    cache.set(dir, origin)
  }
  return cache.get(dir) ?? sourceFromClonePath(skillFile)
}

/**
 * Build the auto-pin allowlist as the union of (highest precedence first) explicit
 * --trust flags, `<library>/vet-allowlist.json` when present, and the tiny
 * hardcoded default publisher set. Returns { sources: Set, warning }.
 */
export async function loadVetAllowlist(libDir, trusted = []) {
  const sources = new Set(
    [...trusted, ...DEFAULT_TRUSTED_SOURCES].map((source) => source.trim().toLowerCase()),
  )
  const file = path.join(libDir, VET_ALLOWLIST_NAME)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { sources, warning: null } // no per-library allowlist — defaults + --trust only
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return { sources, warning: `ignored malformed vet allowlist (not a JSON array): ${file}` }
    }
    for (const source of parsed) {
      if (typeof source === 'string' && source.trim()) sources.add(source.trim().toLowerCase())
    }
    return { sources, warning: null }
  } catch (error) {
    return { sources, warning: `ignored unreadable vet allowlist ${file}: ${error.message}` }
  }
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
  // Duplicate names distort selection and averages (the same skill can be taken
  // twice); selection keeps the strongest entry, but the roots should be cleaned.
  const nameCounts = new Map()
  for (const entry of entries) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1)
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      warnings.push(`duplicate skill name "${name}" (${count} entries) — consider deduplicating the scanned roots`)
    }
  }
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
 * Manifest location for a batch vet: the repo dir's own remote/quarantine segment
 * when it has one, else the segment carried by the skills found beneath it. Falls
 * back to the same "pass --manifest" error as single-file vetting.
 */
function deriveManifestForRepo(dir, files) {
  try {
    return deriveManifestFile(dir)
  } catch (error) {
    if (files.length === 0) throw error
    return deriveManifestFile(files[0]) // a file may cross remote/ below the given dir
  }
}

/**
 * Batch-vet every SKILL.md under `dir`: auto-pin a file only when it scans CLEAN *and*
 * comes from an allowlisted source, then report everything else with its reason
 * (`risk-findings`, `source-not-allowlisted`, or both) for a human to read.
 * Returns { vettedCount, vettedFiles, flagged, allowlist, manifest, warnings }.
 */
async function runVetRepo(dir, manifestArg, trusted = []) {
  const resolved = path.resolve(dir)
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat?.isDirectory()) {
    throw new Error(`--vet-repo requires an existing directory: ${resolved}`)
  }
  const rootReal = await fs.realpath(resolved)

  const files = []
  const warnings = []
  await collectSkillFiles(resolved, 0, files, warnings)
  files.sort()

  // Resolve the manifest before any scanning so a misused path fails fast.
  const manifestFile = path.resolve(manifestArg ?? deriveManifestForRepo(resolved, files))

  const { sources: allowlist, warning: allowlistWarning } = await loadVetAllowlist(
    path.dirname(manifestFile),
    trusted,
  )
  if (allowlistWarning) warnings.push(allowlistWarning)

  const records = {}
  const vettedFiles = []
  const flagged = []
  const sourceCache = new Map()
  for (const file of files) {
    const { real, warning } = await resolveInsideRoot(file, rootReal)
    if (!real) {
      warnings.push(warning)
      continue
    }
    const content = await fs.readFile(real, 'utf8').catch(() => null)
    if (content === null) {
      warnings.push(`skipped unreadable SKILL.md: ${file}`)
      continue
    }
    const { findings } = scanSkillRisk(content)
    const source = await resolveSkillSource(real, sourceCache)
    // Two independent gates: risky content, and content from a publisher nobody vouched
    // for. A finding is domain-legitimate in a security skill and alarming elsewhere, so
    // neither gate alone is enough signal to auto-pin.
    const reasons = [
      ...(findings.length > 0 ? ['risk-findings'] : []),
      ...(source && allowlist.has(source) ? [] : ['source-not-allowlisted']),
    ]
    if (reasons.length > 0) {
      flagged.push({ file, source, reasons, findings })
      continue
    }
    records[path.resolve(file)] = await computeVetRecord(real)
    vettedFiles.push(file)
  }

  const { records: existing, warning } = await loadVetManifest(manifestFile)
  if (warning) warnings.push(warning)
  const updated = { ...existing, ...records }
  await fs.mkdir(path.dirname(manifestFile), { recursive: true })
  await fs.writeFile(manifestFile, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')

  return {
    vettedCount: vettedFiles.length,
    vettedFiles,
    flagged,
    allowlist: [...allowlist].sort(),
    manifest: manifestFile,
    warnings,
  }
}

/**
 * Parse argv, build and write the index — or, with --vet/--vet-repo, record vet pins.
 * Returns { count, out, warnings } (index mode), { vetted, manifest, record } (--vet),
 * or { vettedCount, vettedFiles, flagged, manifest, warnings } (--vet-repo).
 */
export async function runCli(argv) {
  const roots = []
  let out = null
  let remote = null
  let vet = null
  let vetRepo = null
  let manifest = null
  const trusted = []

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
    } else if (arg === '--vet-repo') {
      vetRepo = argv[++i]
      if (!vetRepo) throw new Error(`${arg} requires a directory path`)
    } else if (arg === '--trust') {
      const source = argv[++i]
      if (!source) throw new Error(`${arg} requires an <owner>/<repo> source`)
      trusted.push(source)
    } else if (arg === '--manifest') {
      manifest = argv[++i]
      if (!manifest) throw new Error(`${arg} requires a file path`)
    } else {
      roots.push(arg)
    }
  }

  if (vet && vetRepo) throw new Error('--vet and --vet-repo are mutually exclusive')
  // --vet is an explicit human decision about one file: it IS the allowlist override.
  if (vet) return runVet(vet, manifest)
  if (vetRepo) return runVetRepo(vetRepo, manifest, trusted)
  if (trusted.length > 0) throw new Error('--trust is only valid together with --vet-repo')
  if (manifest) throw new Error('--manifest is only valid together with --vet/--vet-repo')

  const scanRoots = roots.length > 0 ? roots : await defaultRoots()
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
      if (typeof summary.vettedCount === 'number') {
        for (const warning of summary.warnings) console.warn(`⚠ ${warning}`)
        console.log(`Vetted ${summary.vettedCount} skill(s) → ${summary.manifest}`)
        console.log(`Allowlisted sources: ${summary.allowlist.join(', ')}`)
        if (summary.flagged.length > 0) {
          const countBy = (reason) =>
            summary.flagged.filter((f) => f.reasons.includes(reason)).length
          console.log(
            `\n${summary.flagged.length} file(s) NOT vetted ` +
              `(${countBy('risk-findings')} with risk findings, ` +
              `${countBy('source-not-allowlisted')} from a non-allowlisted source) — read these yourself:`,
          )
          for (const { file, source, reasons, findings } of summary.flagged) {
            console.log(`\n  ${file}`)
            console.log(`    source: ${source ?? 'unknown'} — ${reasons.join(', ')}`)
            for (const finding of findings) {
              console.log(`    [${finding.pattern}] line ${finding.line}: ${finding.excerpt}`)
            }
          }
          console.log(
            '\nTrust a publisher so its clean skills auto-pin: --trust <owner>/<repo>' +
              `\n(or list it in ${path.join(path.dirname(summary.manifest), VET_ALLOWLIST_NAME)})` +
              '\nVet one file regardless of its source: --vet <SKILL.md>',
          )
        }
        console.log('\nRebuild the index to mark vetted skills: node scripts/build-skills-index.mjs')
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
