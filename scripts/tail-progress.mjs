#!/usr/bin/env node
// Pretty-tail a Codex live JSONL log: node tail-progress.mjs <logPath>
// Prints human-readable progress lines as the file grows, then keeps the window open.
import { closeSync, existsSync, openSync, readSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const logPath = process.argv[2]
if (!logPath) {
  console.error('usage: tail-progress.mjs <logPath>')
  process.exit(1)
}

const { formatEvent } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'progressFormatter.js'))

console.log('\x1b[1m╭─ Codex live progress ─────────────────────────────╮\x1b[0m')
console.log(`   log: ${logPath}`)
console.log('\x1b[1m╰───────────────────────────────────────────────────╯\x1b[0m\n')

let position = 0
let carry = ''

const drain = () => {
  if (!existsSync(logPath)) return
  const fd = openSync(logPath, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    let bytes = readSync(fd, buffer, 0, buffer.length, position)
    while (bytes > 0) {
      position += bytes
      carry += buffer.toString('utf8', 0, bytes)
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const formatted = formatEvent(line)
        if (formatted) console.log(formatted)
      }
      bytes = readSync(fd, buffer, 0, buffer.length, position)
    }
  } finally {
    closeSync(fd)
  }
}

drain()
const dir = dirname(logPath)
watch(dir, () => drain())
// Poll as a fallback in case fs.watch misses events on network drives.
setInterval(drain, 1000)
console.log('(following… close this window when the run finishes)')
