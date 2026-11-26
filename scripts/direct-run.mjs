import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function isDirectRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof importMetaUrl !== 'string' || importMetaUrl.length === 0) {
    throw new TypeError('importMetaUrl must be a non-empty string')
  }
  if (!argv1) return false

  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(importMetaUrl))
  } catch {
    // Missing paths and platform URL differences use the best available lexical check.
    return pathToFileURL(path.resolve(argv1)).href === importMetaUrl
  }
}
