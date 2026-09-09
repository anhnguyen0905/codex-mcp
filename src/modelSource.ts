import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where a recorded model identifier came from, so a metric line never claims more certainty than
 * it has: `event` is the model Codex itself reported for the run, `override` the `--model` value
 * this server passed, `config` a value read out of `~/.codex/config.toml` (i.e. what the CLI would
 * *probably* default to — unverified against the actual run).
 */
export type ModelSource = 'event' | 'override' | 'config'

export interface ResolvedModel {
  model: string
  source: ModelSource
}

/** Longest model id accepted from any source; a longer value is treated as garbage, not truncated. */
const MAX_MODEL_ID_CHARS = 200

/** Normalize an untrusted model identifier: non-empty, trimmed, bounded. Undefined otherwise. */
const validModelId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_ID_CHARS) return undefined
  return trimmed
}

// Strict top-level `model = "<id>"`. Rejects single-quoted/bare values, and any value containing a
// quote or backslash (TOML escapes are not interpreted here). An optional `#` comment may follow.
const MODEL_LINE_PATTERN = /^model\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/
const TABLE_HEADER_PATTERN = /^\[/

/**
 * Read the model from Codex config TOML text. Deliberately NOT a TOML parser: only a bare
 * top-level `model = "<id>"` line counts, because a `model` key inside a `[profiles.x]` or
 * `[model_providers.x]` table is not the default model for a run. Scanning stops at the first
 * table header. Pure — no filesystem access.
 */
export const parseConfigModel = (tomlText: string): string | undefined => {
  for (const rawLine of tomlText.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // Every subsequent key belongs to a table, so the top-level scope is over.
    if (TABLE_HEADER_PATTERN.test(line)) return undefined
    const match = MODEL_LINE_PATTERN.exec(line)
    if (match) return validModelId(match[1])
  }
  return undefined
}

export interface ConfiguredModelOptions {
  /** Codex home directory. Defaults to CODEX_HOME, else ~/.codex (matches sessionStore). */
  codexHome?: string
}

/** One memoized parse of a config.toml, keyed by the file identity it was parsed from. */
interface ConfigModelCacheEntry {
  readonly mtimeMs: number
  readonly size: number
  /** sha1 of the exact bytes that produced `model`, so an in-place rewrite cannot be reused. */
  readonly contentHash: string
  readonly model: string | undefined
}

/**
 * Content fingerprint of a config.toml. Hashes the raw bytes, not the decoded text, so two
 * different invalid-UTF-8 rewrites of the same length cannot collapse onto one hash via U+FFFD.
 * sha1 is a change detector here, never a security claim.
 */
const contentHashOf = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex')

/**
 * Bound on distinct config paths held at once. A server sees one CODEX_HOME in practice; the cap
 * only stops a caller that varies `codexHome` per call from growing the map without limit.
 */
const MAX_CACHED_CONFIG_PATHS = 32

const configModelCache = new Map<string, ConfigModelCacheEntry>()

/** Drop every memoized config.toml parse. For tests and for callers that change CODEX_HOME. */
export const clearModelCache = (): void => {
  configModelCache.clear()
}

/**
 * Resolved config.toml paths currently memoized, in insertion (eviction) order. Introspection for
 * tests and diagnostics only — a frozen copy, so no caller can mutate the cache through it.
 */
export const modelCachePaths = (): readonly string[] =>
  Object.freeze([...configModelCache.keys()])

/**
 * Best-effort read of the configured default model from `<codexHome>/config.toml`.
 * Read-only and never throws: a missing, unreadable, or malformed file yields undefined so a
 * metric line simply omits the model rather than failing the run.
 *
 * Memoized per resolved path on (mtimeMs, size, sha1 of the content) — every call still stats the
 * file, so an edited or newly created config is picked up. When the stat key matches the cached
 * one the file is still read once and hashed (the deliberate cost of never trusting mtime+size,
 * which a same-millisecond same-length rewrite leaves untouched); only the parse is skipped.
 * A missing or unreadable file is never cached: it drops any stale entry and returns undefined.
 */
export const readConfiguredModel = (options: ConfiguredModelOptions = {}): string | undefined => {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  // Resolved (not merely joined) so a relative `codexHome` cannot key two different files — the
  // one it names now and the one it names after process.cwd() moves — under the same cache entry.
  const configPath = resolve(codexHome, 'config.toml')

  let stats
  try {
    stats = statSync(configPath)
  } catch {
    configModelCache.delete(configPath)
    return undefined
  }

  const cached = configModelCache.get(configPath)
  const hasSameStatKey =
    cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size

  let bytes: Buffer
  try {
    bytes = readFileSync(configPath)
  } catch {
    configModelCache.delete(configPath)
    return undefined
  }

  const contentHash = contentHashOf(bytes)
  if (hasSameStatKey && cached.contentHash === contentHash) return cached.model
  const model = parseConfigModel(bytes.toString('utf8'))

  if (!configModelCache.has(configPath) && configModelCache.size >= MAX_CACHED_CONFIG_PATHS) {
    // Evict the least recently inserted path only, so every other path stays memoized.
    const oldestPath = configModelCache.keys().next().value
    if (oldestPath !== undefined) configModelCache.delete(oldestPath)
  }
  configModelCache.set(configPath, {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    contentHash,
    model,
  })
  return model
}

/**
 * Resolve which model to record for a run, by descending authority:
 * event stream > explicit `--model` override > configured default. Undefined when no source has a
 * usable identifier, so the metric entry omits both `model` and `modelSource` (R7.1).
 */
export const resolveModel = (
  eventModel: string | undefined,
  overrideModel: string | undefined,
  options: ConfiguredModelOptions = {},
): ResolvedModel | undefined => {
  const fromEvent = validModelId(eventModel)
  if (fromEvent) return { model: fromEvent, source: 'event' }
  const fromOverride = validModelId(overrideModel)
  if (fromOverride) return { model: fromOverride, source: 'override' }
  const fromConfig = validModelId(readConfiguredModel(options))
  return fromConfig ? { model: fromConfig, source: 'config' } : undefined
}
