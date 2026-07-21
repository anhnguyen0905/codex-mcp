#!/usr/bin/env node
/**
 * Capture a version-pinned Codex CLI protocol fixture for tests/protocolFixtures.test.ts.
 *
 * Runs the real CLI (`codex exec --json ... -- -` with the prompt on stdin, mirroring
 * src/argsBuilder.ts) against a trivial prompt in a throwaway temp dir, and stores the raw
 * stdout JSONL as tests/fixtures/protocol/codex-<version>.jsonl plus a meta sidecar.
 *
 * Exit codes: 0 success, 2 not logged in, 1 any other failure.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'protocol')
const PROMPT = 'Reply with exactly: pong. Do not run commands.'
const CAPTURE_TIMEOUT_MS = 180_000
/**
 * Codex binary to invoke. Override with CODEX_BIN when `codex` on PATH is a wrapper/shim that
 * injects extra flags (e.g. terminal multiplexer shims) — those pollute the captured protocol
 * stream with environment-specific events.
 */
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'

/**
 * Event/item types handled by src/eventParser.ts (applyEvent/applyItem). Anything else is
 * counted as an unknown event, matching ParsedEvents.unknownEvents. Keep in sync with the parser.
 */
const KNOWN_EVENT_TYPES = new Set(['thread.started', 'turn.completed', 'turn.failed'])
const KNOWN_ITEM_TYPES = new Set(['agent_message', 'file_change', 'command_execution', 'error'])

const fail = (message, code = 1) => {
  console.error(`refresh-protocol-fixtures: ${message}`)
  process.exit(code)
}

const codexVersion = async () => {
  const { stdout } = await execFileAsync(CODEX_BIN, ['--version'])
  // e.g. "codex-cli 0.144.6" -> "0.144.6"
  const match = stdout.trim().match(/(\d+\.\d+\.\d+\S*)/)
  if (!match) throw new Error(`could not parse version from: ${stdout.trim()}`)
  return match[1]
}

/**
 * Builds an isolated CODEX_HOME seeded only with the user's auth credentials. Without this,
 * machine-local config (custom hooks, hook-trust bypass, model overrides, ...) leaks extra
 * events into the fixture and the capture stops being a canonical protocol sample.
 */
const makeIsolatedCodexHome = () => {
  const userAuth = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(userAuth)) {
    fail('no ~/.codex/auth.json found — run `codex login` first', 2)
  }
  const isolatedHome = mkdtempSync(join(tmpdir(), 'codex-protocol-home-'))
  copyFileSync(userAuth, join(isolatedHome, 'auth.json'))
  return isolatedHome
}

const assertLoggedIn = async (env) => {
  try {
    const { stdout, stderr } = await execFileAsync(CODEX_BIN, ['login', 'status'], { env })
    const output = `${stdout}\n${stderr}`
    if (!/logged in/i.test(output) || /not logged in/i.test(output)) {
      fail('codex CLI is not logged in — run `codex login` first', 2)
    }
  } catch {
    fail('`codex login status` failed — run `codex login` first', 2)
  }
}

/** Mirrors the unknown-event counting in src/eventParser.ts so the meta sidecar can pin it. */
const countUnknownEvents = (jsonl) => {
  let unknown = 0
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // parse errors are asserted separately, not counted here
    }
    if (typeof event !== 'object' || event === null) continue
    if (event.type === 'item.completed') {
      if (!KNOWN_ITEM_TYPES.has(event.item?.type)) unknown += 1
    } else if (!KNOWN_EVENT_TYPES.has(event.type)) {
      unknown += 1
    }
  }
  return unknown
}

/** Runs `codex exec --json ... -- -` with the prompt on stdin (the src/argsBuilder.ts pattern). */
const captureJsonl = (cwd, env) =>
  new Promise((resolvePromise, rejectPromise) => {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-c',
      'model_reasoning_effort="low"',
      '--',
      '-',
    ]
    const child = spawn(CODEX_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`codex exec timed out after ${CAPTURE_TIMEOUT_MS}ms`))
    }, CAPTURE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        rejectPromise(new Error(`codex exec exited with code ${code}: ${stderr.slice(0, 2000)}`))
        return
      }
      resolvePromise(stdout)
    })
    child.stdin.end(PROMPT)
  })

/** Replaces every occurrence of the user's home directory with `~` so fixtures are portable. */
const redactHome = (text) => text.split(homedir()).join('~')

const main = async () => {
  const isolatedHome = makeIsolatedCodexHome()
  const env = { ...process.env, CODEX_HOME: isolatedHome }
  const tempCwd = mkdtempSync(join(tmpdir(), 'codex-protocol-fixture-'))
  let rawJsonl
  let version
  try {
    await assertLoggedIn(env)
    version = await codexVersion()
    console.error(`Capturing protocol fixture with codex ${version}...`)
    rawJsonl = await captureJsonl(tempCwd, env)
  } finally {
    rmSync(tempCwd, { recursive: true, force: true })
    rmSync(isolatedHome, { recursive: true, force: true })
  }

  if (rawJsonl.trim().length === 0) throw new Error('codex exec produced no stdout')

  const jsonl = redactHome(rawJsonl)
  const meta = {
    codexVersion: version,
    capturedAt: new Date().toISOString(),
    prompt: PROMPT,
    synthetic: false,
    expectedUnknownEvents: countUnknownEvents(jsonl),
  }

  mkdirSync(FIXTURE_DIR, { recursive: true })
  const fixturePath = join(FIXTURE_DIR, `codex-${version}.jsonl`)
  const metaPath = join(FIXTURE_DIR, `codex-${version}.meta.json`)
  writeFileSync(fixturePath, jsonl.endsWith('\n') ? jsonl : `${jsonl}\n`)
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)

  console.error(`Wrote ${fixturePath}`)
  console.error(`Wrote ${metaPath} (expectedUnknownEvents: ${meta.expectedUnknownEvents})`)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
