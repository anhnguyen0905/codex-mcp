import { execFile, type ExecFileException } from 'node:child_process'

export const DEFAULT_MAX_PATCH_BYTES = 64 * 1024
const GIT_TIMEOUT_MS = 15 * 1000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

export interface WorkspaceDiff {
  /** `git status --porcelain` output: one line per changed/untracked file. */
  status: string
  /** Unified diff of tracked changes vs HEAD, possibly truncated. */
  patch: string
  truncated: boolean
}

export type DiffFn = (cwd: string) => Promise<WorkspaceDiff | null>

export interface CaptureOptions {
  maxPatchBytes?: number
}

const isMaxBufferError = (error: ExecFileException): boolean =>
  error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

const runGit = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        // A diff bigger than maxBuffer is still useful: keep the partial output and
        // let the caller's truncation flag it, instead of dropping the whole diff.
        if (error && !isMaxBufferError(error)) reject(error)
        else resolve(stdout)
      },
    )
  })

/**
 * Capture what changed in the workspace so the caller can review without re-reading files.
 * Returns null when cwd is not a git repo (or git is unavailable) — never throws.
 */
export const captureWorkspaceDiff = async (
  cwd: string,
  options: CaptureOptions = {},
): Promise<WorkspaceDiff | null> => {
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  try {
    const [status, patch] = await Promise.all([
      runGit(cwd, ['status', '--porcelain']),
      runGit(cwd, ['diff', 'HEAD']),
    ])
    const truncated = patch.length > maxPatchBytes
    return {
      status: status.trimEnd(),
      patch: truncated ? patch.slice(0, maxPatchBytes) : patch,
      truncated,
    }
  } catch {
    return null
  }
}
