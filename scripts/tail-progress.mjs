#!/usr/bin/env node
// Pretty-tail a Codex live JSONL log: node tail-progress.mjs <logPath>
// Prints human-readable progress lines as the file grows, and exits automatically (code 0) when
// the end-of-run marker written by liveView appears. Optional fallback: set CODEX_TAIL_TIMEOUT_MS
// to exit 1 after that many ms if no marker ever arrives (e.g. the writer crashed).
import { closeSync, existsSync, openSync, readSync, watch, writeFileSync } from 'node:fs'
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
const EVENT_GAP_THRESHOLD_MS = 30_000
const MAX_CARRY_BYTES = 1024 * 1024
const TEST_PLATFORM_OVERRIDES = new Set(['darwin', 'linux', 'win32'])
const TEST_WINDOW_ID_ENV = 'CODEX_TAIL_TEST_WINDOW_ID'

// The pretty formatter lives in dist/. Degrade to raw JSONL passthrough when it is missing
// (unbuilt checkout) — following and marker-based exit must keep working regardless.
let formatEvent = (line) => line
try {
  const formatter = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'progressFormatter.js'))
  formatEvent = formatter.formatEvent
} catch {
  console.error('(dist/progressFormatter.js not built — showing raw JSONL lines)')
}

// Auto-close is also best-effort. A missing dist/ must not stop an unbuilt checkout from tailing.
let terminalCloser
try {
  terminalCloser = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'terminalCloser.js'))
} catch {
  terminalCloser = undefined
}

console.log('\x1b[1m╭─ Codex live progress ─────────────────────────────╮\x1b[0m')
console.log(`   log: ${logPath}`)
console.log('\x1b[1m╰───────────────────────────────────────────────────╯\x1b[0m\n')

let position = 0
let carry = ''
let carryBytes = 0
let watcher
let pollTimer
let timeoutTimer
let previousEventAtMs = null

const finish = (code, message) => {
  if (message) console.log(message)
  watcher?.close()
  clearInterval(pollTimer)
  clearTimeout(timeoutTimer)
  process.exit(code)
}

/** Return the validated status when the line is liveView's end-of-run marker. */
const parseRunFinishedStatus = (line) => {
  if (!line.includes(RUN_FINISHED_TYPE)) return null
  try {
    const event = JSON.parse(line)
    if (typeof event !== 'object' || event === null || event.type !== RUN_FINISHED_TYPE) return null
    if (event.status === 'completed' || event.status === 'failed' || event.status === 'interrupted') {
      return event.status
    }
    return 'interrupted'
  } catch {
    return null
  }
}

const resolveClosePlatform = () => {
  const testPlatform = process.env.CODEX_TAIL_TEST_PLATFORM
  // Test-only and never set in production; the command-log gate keeps normal runs on the host.
  if (
    process.env.CODEX_TAIL_CLOSE_CMD_LOG !== undefined &&
    TEST_PLATFORM_OVERRIDES.has(testPlatform)
  ) {
    return testPlatform
  }
  return process.platform
}

const tryCloseTerminal = (status) => {
  if (!terminalCloser) return false

  const platform = resolveClosePlatform()
  const decision = terminalCloser.decideTerminalClose({ status, platform, env: process.env })
  if (!decision.close) return false

  // Test-only and never set in production; setting it suppresses the real close and writes the
  // would-be argv to its path.
  const commandLogPath = process.env.CODEX_TAIL_CLOSE_CMD_LOG
  const testWindowId = process.env[TEST_WINDOW_ID_ENV]
  const deps = commandLogPath !== undefined
    ? {
        spawnSyncFn: () => ({
          status: 0,
          stdout: testWindowId === undefined ? '' : `${testWindowId}\n`,
          error: undefined,
        }),
        spawnFn: (command, args) => {
          writeFileSync(commandLogPath, JSON.stringify({ command, args }), 'utf8')
          return { on: () => {}, unref: () => {} }
        },
      }
    : undefined
  const closed = terminalCloser.closeTerminalWindow(
    {
      tty: process.env[terminalCloser.TERMINAL_TTY_ENV],
      delayMs: decision.delayMs,
      platform,
    },
    deps,
  )
  if (!closed) return false

  console.log(`\n(run completed — closing this window in ${decision.delayMs / 1000}s…)`)
  finish(0)
  return true
}

/** Return an event's timestamp in milliseconds, or null for old/malformed lines. */
const parseEventTimestamp = (line) => {
  try {
    const event = JSON.parse(line)
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return null
    if (typeof event.at !== 'string') return null
    const timestampMs = Date.parse(event.at)
    return Number.isFinite(timestampMs) ? timestampMs : null
  } catch {
    return null
  }
}

const handleLine = (line) => {
  const eventAtMs = parseEventTimestamp(line)
  if (previousEventAtMs !== null && eventAtMs !== null) {
    const gapMs = eventAtMs - previousEventAtMs
    if (gapMs > EVENT_GAP_THRESHOLD_MS) console.log(`… +${Math.round(gapMs / 1000)}s`)
  }
  previousEventAtMs = eventAtMs

  const formatted = formatEvent(line)
  if (formatted) console.log(formatted)
  const status = parseRunFinishedStatus(line)
  if (status === null) return
  if (tryCloseTerminal(status)) return
  finish(0, '\n(run finished — closing watcher)')
}

const resetCarry = () => {
  carry = ''
  carryBytes = 0
}

const appendCarry = (text) => {
  if (text.length === 0) return
  carry += text
  carryBytes += Buffer.byteLength(text)
  if (carryBytes <= MAX_CARRY_BYTES) return
  handleLine(carry)
  resetCarry()
}

const consumeText = (text) => {
  const lines = text.split('\n')
  if (lines.length === 1) {
    appendCarry(text)
    return
  }

  const firstLine = carry + (lines[0] ?? '')
  resetCarry()
  handleLine(firstLine)
  for (const line of lines.slice(1, -1)) handleLine(line)
  appendCarry(lines[lines.length - 1] ?? '')
}

const drain = () => {
  if (!existsSync(logPath)) return
  const fd = openSync(logPath, 'r')
  try {
    const buffer = Buffer.alloc(65536)
    let bytes = readSync(fd, buffer, 0, buffer.length, position)
    while (bytes > 0) {
      position += bytes
      consumeText(buffer.toString('utf8', 0, bytes))
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
