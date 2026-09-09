/**
 * Path canonicalization shared by the server and `scripts/scope-check.mjs`.
 *
 * `codex_review`'s `scope.files` must fold exactly the way the sequential scope trip-wire
 * folds the paths git reports, otherwise a finding on a declared file could be annotated
 * out of scope (or the reverse) purely because the two sides disagreed on separators or
 * case. The script stays stdlib-only and independently runnable, so the logic is
 * duplicated here on purpose and pinned by a parity test that imports both over one
 * shared vector.
 */

// Only these two platforms fold case in practice; treating Linux paths as
// case-insensitive would hide a genuinely different file.
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'win32'])

/**
 * Normalize one path for comparison: drop `.` segments and repeated separators, keep a
 * leading `/` so an absolute path never folds onto a relative declaration, and fold case
 * on case-insensitive platforms. On win32 only, `\` is also a separator.
 *
 * Deliberately does NOT trim, does NOT rewrite `\` off win32, and does NOT resolve `..`:
 * on POSIX a leading space and a backslash are legal filename characters, and a `..`
 * segment cannot be resolved without knowing the real tree, so folding any of them here
 * would let a real file named `src\secret.ts`, ` secret.ts`, or `src/../secret.ts`
 * canonicalize onto a declared path. Byte-identical to `canonicalPath` in
 * `scripts/scope-check.mjs`.
 */
export function canonicalPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof filePath !== 'string') throw new TypeError('filePath must be a string')
  const withSlashes = platform === 'win32' ? filePath.replaceAll('\\', '/') : filePath
  const segments = withSlashes.split('/').filter((segment) => segment !== '' && segment !== '.')
  const joined = segments.join('/')
  const rooted = withSlashes.startsWith('/') ? `/${joined}` : joined
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? rooted.toLowerCase() : rooted
}
