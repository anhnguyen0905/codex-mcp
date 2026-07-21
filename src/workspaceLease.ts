import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Cross-process workspace lease: one Codex run per physical workspace, across ALL codex-mcp
 * server processes on this machine. Lease files live OUTSIDE the workspace (under
 * ~/.codex-mcp/locks/) because the workspace itself may sit in a cloud-synced folder
 * (OneDrive/Dropbox) where lockfiles are mirrored, delayed, or resurrected.
 */

const LOCKS_DIR_MODE = 0o700
const LEASE_FILE_MODE = 0o600

export interface LeaseInfo {
  pid: number
  startTimeMs: number
  runId: string
  hostname: string
  cwd: string
}

export interface WorkspaceLease {
  leasePath: string
  /** Best-effort unlink; tolerates an already-removed lease file. */
  release: () => void
}

export interface LeaseOptions {
  /** Override the default ~/.codex-mcp/locks directory (mostly for tests). */
  locksDir?: string
}

export type LeaseFn = (cwd: string, runId: string) => Promise<WorkspaceLease>

/** Location of the locks dir, honoring CODEX_MCP_LOCKS_DIR env, else ~/.codex-mcp/locks. */
export const defaultLocksDir = (): string =>
  process.env.CODEX_MCP_LOCKS_DIR ?? join(homedir(), '.codex-mcp', 'locks')

/** Canonicalize so symlinked variants of one workspace map to one lease. */
const canonicalCwd = (cwd: string): string => {
  try {
    return realpathSync.native(resolve(cwd))
  } catch {
    // cwd may not exist yet — fall back to plain path resolution.
    return resolve(cwd)
  }
}

/** Lease file path for a workspace: sha256 of the canonical cwd, outside the workspace. */
export const leasePathFor = (cwd: string, locksDir: string = defaultLocksDir()): string => {
  const digest = createHash('sha256').update(canonicalCwd(cwd)).digest('hex')
  return join(locksDir, `${digest}.json`)
}

const isErrnoCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code

/** True when a process with this pid exists (EPERM still means "exists"). */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrnoCode(error, 'ESRCH')
  }
}

/** O_EXCL create; false only on EEXIST (someone else holds the lease). */
const tryWriteLease = (leasePath: string, info: LeaseInfo): boolean => {
  try {
    writeFileSync(leasePath, JSON.stringify(info), { flag: 'wx', mode: LEASE_FILE_MODE })
    return true
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) return false
    throw error
  }
}

/** Parse an existing lease file; null when unreadable/corrupt (treated as stale). */
const readLease = (leasePath: string): LeaseInfo | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(leasePath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const info = parsed as Partial<LeaseInfo>
    if (typeof info.pid !== 'number' || typeof info.startTimeMs !== 'number') return null
    return info as LeaseInfo
  } catch {
    return null
  }
}

const busyError = (holder: LeaseInfo): Error =>
  new Error(
    `workspace busy (pid ${holder.pid} since ${new Date(holder.startTimeMs).toISOString()}): ` +
      `another codex-mcp process is running Codex in ${holder.cwd}. ` +
      'Wait for it to finish (or remove the lease file if the process is gone) before starting a new run.',
  )

const removeLeaseFile = (leasePath: string): void => {
  try {
    unlinkSync(leasePath)
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) throw error
  }
}

/**
 * Acquire the cross-process lease for a workspace. On contention: reclaims a stale lease
 * (owning pid dead) once, otherwise fails with a clear "workspace busy" error.
 */
export const acquireWorkspaceLease = async (
  cwd: string,
  runId: string,
  options: LeaseOptions = {},
): Promise<WorkspaceLease> => {
  const locksDir = options.locksDir ?? defaultLocksDir()
  mkdirSync(locksDir, { recursive: true, mode: LOCKS_DIR_MODE })
  const leasePath = leasePathFor(cwd, locksDir)
  const info: LeaseInfo = {
    pid: process.pid,
    startTimeMs: Date.now(),
    runId,
    hostname: hostname(),
    cwd: canonicalCwd(cwd),
  }
  const lease: WorkspaceLease = { leasePath, release: () => removeLeaseFile(leasePath) }

  if (tryWriteLease(leasePath, info)) return lease

  const holder = readLease(leasePath)
  if (holder !== null && isPidAlive(holder.pid)) throw busyError(holder)

  // Stale (owner dead) or corrupt: remove and retry exactly once.
  removeLeaseFile(leasePath)
  if (tryWriteLease(leasePath, info)) return lease

  const raced = readLease(leasePath)
  if (raced !== null) throw busyError(raced)
  throw new Error(`workspace busy: could not acquire lease at ${leasePath} (concurrent contention).`)
}
