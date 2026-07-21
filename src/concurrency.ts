import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import type { LeaseFn } from './workspaceLease.js'

/** Global cap on concurrent Codex runs across all workspaces (override via CODEX_MCP_MAX_CONCURRENT). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 16

export const parseMaxConcurrent = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_RUNS
  const n = Number(raw)
  // Validate explicitly rather than `Number(raw) || 16`, which silently swallows a configured 0/NaN.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT_RUNS
}

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin'])

/**
 * Normalize a cwd into a lock key that identifies the physical directory: resolve symlinks
 * (falling back to path resolution when the dir can't be inspected) and fold case on platforms
 * whose default filesystems are case-insensitive, so "C:\Repo" and "c:\repo" share one lock.
 */
const realpathStable = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    // Leaf may not exist yet (e.g. a task that scaffolds a new dir). Realpath the deepest
    // existing ancestor and re-attach the missing tail so the key is identical before and
    // after the dir is created — otherwise a run that creates cwd mid-flight would let a
    // second run compute a divergent (now-resolvable) key and bypass the lock.
    const parent = dirname(path)
    if (parent === path) return resolvePath(path) // filesystem root: nothing left to resolve
    return join(realpathStable(parent), basename(path))
  }
}

export const cwdLockKey = (cwd: string, platform: NodeJS.Platform = process.platform): string => {
  const resolved = realpathStable(resolvePath(cwd))
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved
}

/**
 * Serializes Codex runs per workspace: two concurrent runs writing into the same cwd would
 * race on files and git state, so the second call fails fast with a clear message.
 * Layered: the in-memory slot (fast path, this process) is taken first, then the
 * cross-process lease file; both are released in reverse order in the same finally.
 */
export const createCwdGuard = (leaseFn: LeaseFn) => {
  const active = new Set<string>()
  return async <T>(cwd: string, runId: string, run: () => Promise<T>): Promise<T> => {
    const key = cwdLockKey(cwd)
    if (active.has(key)) {
      throw new Error(
        `Another Codex run is already active in ${key}. Wait for it to finish (or cancel it) before starting a new one.`,
      )
    }
    active.add(key)
    try {
      const lease = await leaseFn(cwd, runId)
      try {
        return await run()
      } finally {
        lease.release()
      }
    } finally {
      active.delete(key)
    }
  }
}

/**
 * Global backstop on how many Codex runs can be in flight at once across ALL workspaces. The
 * per-cwd guard doesn't bound this (distinct cwds each get their own lock), so a burst of
 * many-cwd calls could otherwise exhaust memory/file descriptors. Fails fast past the cap.
 */
export const createConcurrencyGate = (max: number) => {
  let active = 0
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      throw new Error(`Too many concurrent Codex runs (max ${max}). Wait for one to finish and retry.`)
    }
    active += 1
    try {
      return await run()
    } finally {
      active -= 1
    }
  }
}
