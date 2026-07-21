#!/usr/bin/env node
// Pretty-tail a Codex live JSONL log: node tail-progress.mjs <logPath>
// Prints human-readable progress lines as the file grows, and exits automatically (code 0) when
// the end-of-run marker written by liveView appears. Optional fallback: set CODEX_TAIL_TIMEOUT_MS
// to exit 1 after that many ms if no marker ever arrives (e.g. the writer crashed).
import { closeSync, existsSync, openSync, readSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const logPath = process.argv[2]
if (!logPath) {
  console.error('usage: tail-progress.mjs <logPath>')
  process.exit(1)
}

// Keep in sync with LIVE_RUN_FINISHED_TYPE in src/progressFormatter.ts. Detected here without
// importing dist/ so auto-exit works even in a checkout that has not been built.
const RUN_FINISHED_TYPE = 'live.run_finished'

// The pretty formatter lives in dist/. Degrade to raw JSONL passthrough when it is missing
// (unbuilt checkout) — following and marker-based exit must keep working regardless.
let formatEvent = (line) => line
try {
  const formatter = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'progressFormatter.js'))
  formatEvent = formatter.formatEvent
} catch {
  console.error('(dist/progressFormatter.js not built — showing raw JSONL lines)')
}

console.log('\x1b[1m╭─ Codex live progress ─────────────────────────────╮\x1b[0m')
console.log(`   log: ${logPath}`)
console.log('\x1b[1m╰───────────────────────────────────────────────────╯\x1b[0m\n')

let position = 0
let carry = ''
let watcher
let pollTimer
let timeoutTimer

const finish = (code, message) => {
  if (message) console.log(message)
  watcher?.close()
  clearInterval(pollTimer)
  clearTimeout(timeoutTimer)
  process.exit(code)
}

/** True when the line is liveView's end-of-run marker. */
const isRunFinishedLine = (line) => {
  if (!line.includes(RUN_FINISHED_TYPE)) return false
  try {
    const event = JSON.parse(line)
    return typeof event === 'object' && event !== null && event.type === RUN_FINISHED_TYPE
  } catch {
    return false
  }
}

const handleLine = (line) => {
  const formatted = formatEvent(line)
  if (formatted) console.log(formatted)
  if (isRunFinishedLine(line)) {
    finish(0, '\n(run finished — closing watcher)')
  }
}

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
      for (const line of lines) handleLine(line)
      bytes = readSync(fd, buffer, 0, buffer.length, position)
    }
  } finally {
    closeSync(fd)
  }
}

const timeoutMs = Number.parseInt(process.env.CODEX_TAIL_TIMEOUT_MS ?? '', 10)
if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
  timeoutTimer = setTimeout(() => {
    finish(1, `\n(no end-of-run marker after ${timeoutMs}ms — giving up)`)
  }, timeoutMs)
}

drain()
const dir = dirname(logPath)
watcher = watch(dir, () => drain())
// Poll as a fallback in case fs.watch misses events on network drives.
pollTimer = setInterval(drain, 1000)
console.log('(following… exits automatically when the run finishes)')
