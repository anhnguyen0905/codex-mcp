import { isDirectRun } from './direct-run.mjs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const TEST_COMMAND_PATTERNS = [
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*vitest(?:\.cmd|\.exe)?(?=$|[\s'"])/i,
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*jest(?:\.cmd|\.exe)?(?=$|[\s'"])/i,
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*npm(?:\.cmd|\.exe)?\s+(?:run\s+)?test(?=$|[\s'":])/i,
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*pytest(?:\.cmd|\.exe)?(?=$|[\s'"])/i,
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*go(?:\.cmd|\.exe)?\s+test(?=$|[\s'"])/i,
  /(?:^|[\s;&|('"])(?:[^\s;&|('"/\\]*[\/\\])*cargo(?:\.cmd|\.exe)?\s+test(?=$|[\s'"])/i,
]

const EMPTY_TOKENS = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 }

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const numberOrZero = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const isTestCommand = (command) => TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
const longestBacktickRun = (text) => Math.max(...[...text.matchAll(/`+/g)].map((match) => match[0].length), 0)
const formatFailedCommand = (command, exitCode) => {
  const safeCommand = command.replace(/\r?\n|\r/g, ' ')
  const fence = '`'.repeat(longestBacktickRun(safeCommand) + 1)
  return `  - exit ${exitCode}: ${fence} ${safeCommand} ${fence}`
}

export function digestLines(lines) {
  const commands = []
  const failedCommands = []
  const fileCounts = new Map()
  const tokens = { ...EMPTY_TOKENS }
  const stamps = []
  let testRuns = 0
  let finalStatus = null
  let skippedLines = 0

  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      skippedLines += 1
      continue
    }
    if (!isRecord(event) || typeof event.at !== 'string') {
      skippedLines += 1
      continue
    }
    const stamp = Date.parse(event.at)
    if (Number.isFinite(stamp)) stamps.push(stamp)

    if (event.type === 'live.run_finished' && typeof event.status === 'string') finalStatus = event.status
    if (event.type === 'item.completed' && isRecord(event.item)) {
      if (event.item.type === 'command_execution' && typeof event.item.command === 'string') {
        const command = event.item.command
        commands.push(command)
        if (isTestCommand(command)) testRuns += 1
        if (typeof event.item.exit_code === 'number' && event.item.exit_code !== 0) {
          failedCommands.push({ command: command.slice(0, 120), exitCode: event.item.exit_code })
        }
      }
      if (event.item.type === 'file_change' && Array.isArray(event.item.changes)) {
        for (const change of event.item.changes) {
          if (isRecord(change) && typeof change.path === 'string') {
            fileCounts.set(change.path, (fileCounts.get(change.path) ?? 0) + 1)
          }
        }
      }
    }
    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      tokens.input += numberOrZero(event.usage.input_tokens)
      tokens.cachedInput += numberOrZero(event.usage.cached_input_tokens)
      tokens.output += numberOrZero(event.usage.output_tokens)
      tokens.reasoningOutput += numberOrZero(event.usage.reasoning_output_tokens)
    }
  }

  const durationSeconds = stamps.length < 2 ? null : (stamps.at(-1) - stamps[0]) / 1000
  const filesChangedMoreThanOnce = [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ path: filePath, count }))
  return {
    commands,
    failedCommands,
    testRuns,
    filesChangedMoreThanOnce,
    tokens,
    durationSeconds,
    finalStatus,
    skippedLines,
  }
}

export function formatDigest(digest) {
  return [
    `Commands: ${digest.commands.length}`,
    `Failed commands: ${digest.failedCommands.length}`,
    ...digest.failedCommands.map(({ command, exitCode }) => formatFailedCommand(command, exitCode)),
    `Test runs: ${digest.testRuns}`,
    `Files changed more than once: ${digest.filesChangedMoreThanOnce.length}`,
    ...digest.filesChangedMoreThanOnce.map(({ path: filePath, count }) => `  - ${filePath} ×${count}`),
    `Tokens: input ${digest.tokens.input}, cached input ${digest.tokens.cachedInput}, output ${digest.tokens.output}, reasoning output ${digest.tokens.reasoningOutput}`,
    `Duration seconds: ${digest.durationSeconds ?? 'null'}`,
    `Final status: ${digest.finalStatus ?? 'null'}`,
    `Skipped lines: ${digest.skippedLines}`,
  ].join('\n')
}

const usageError = (message) => {
  process.stderr.write(`trajectory-digest: ${message}\n`)
  process.exitCode = 2
}

if (isDirectRun(import.meta.url)) {
  const args = process.argv.slice(2)
  const logIndex = args.indexOf('--log')
  const logPath = logIndex >= 0 ? args[logIndex + 1] : undefined
  const isValidLogPath = typeof logPath === 'string' && !logPath.startsWith('--')
  const hasUnexpectedArgument = args.some((arg, index) => {
    if (index === logIndex || index === logIndex + 1) return false
    return arg !== '--json'
  })
  if (!isValidLogPath || hasUnexpectedArgument || args.filter((arg) => arg === '--log').length !== 1) {
    usageError('usage: --log <path> [--json]')
  } else {
    readFile(logPath, 'utf8')
      .then((content) => {
        const digest = digestLines(content.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== ''))
        process.stdout.write(args.includes('--json') ? `${JSON.stringify(digest)}\n` : `${formatDigest(digest)}\n`)
      })
      .catch((error) => {
        usageError(error instanceof Error ? error.message : 'unable to read log')
      })
  }
}
