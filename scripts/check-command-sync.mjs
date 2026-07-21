// Command sync gate: commands/codex-flow.md is the single source of truth for
// the /codex-flow command; .claude/commands/codex-flow.md must be a byte-exact
// copy. Exits 1 with a fix hint when any pair has drifted.
//
// Usage: node scripts/check-command-sync.mjs

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// [canonical source, mirror that must match it byte-for-byte]
export const SYNC_PAIRS = [['commands/codex-flow.md', '.claude/commands/codex-flow.md']]

// Pure: byte-equality of two buffers.
export const buffersEqual = (a, b) => Buffer.compare(a, b) === 0

const checkPair = ([source, mirror]) => {
  let sourceBytes
  let mirrorBytes
  try {
    sourceBytes = readFileSync(path.join(REPO_ROOT, source))
  } catch (error) {
    return `  ERROR reading ${source}: ${error.message}`
  }
  try {
    mirrorBytes = readFileSync(path.join(REPO_ROOT, mirror))
  } catch (error) {
    return `  ERROR reading ${mirror}: ${error.message}`
  }
  if (!buffersEqual(sourceBytes, mirrorBytes)) {
    return `  DRIFT ${mirror} differs from ${source} (${mirrorBytes.length} vs ${sourceBytes.length} bytes). Fix: cp "${source}" "${mirror}"`
  }
  return null
}

const main = () => {
  const problems = SYNC_PAIRS.map(checkPair).filter((p) => p !== null)
  if (problems.length > 0) {
    console.error('command sync: drift detected:')
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  console.log(`command sync: ${SYNC_PAIRS.length} pair(s) byte-identical`)
  process.exit(0)
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) main()
