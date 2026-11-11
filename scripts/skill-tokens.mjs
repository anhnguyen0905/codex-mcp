import { readFileSync } from 'node:fs'

import { DISTILL_TOKENS_CAP } from './skill-match.mjs'

const sizeCache = new Map()

/** Estimate the distilled context cost of an indexed skill entry. */
export function tokensOf(entry) {
  if (!entry.file || /^https?:\/\//.test(entry.file)) return DISTILL_TOKENS_CAP
  if (sizeCache.has(entry.file)) return sizeCache.get(entry.file)
  let tokens = DISTILL_TOKENS_CAP
  try {
    tokens = Math.min(Math.ceil(readFileSync(entry.file, 'utf8').length / 4), DISTILL_TOKENS_CAP)
  } catch {
    // Keep the conservative fallback for remote or unavailable files.
  }
  sizeCache.set(entry.file, tokens)
  return tokens
}
