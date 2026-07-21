import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

const EXIT_ASSERTION_FAILED = 1
const EXIT_PRECONDITION_FAILED = 2
const CODEX_TIMEOUT_MS = 300000
const TARGET_FILE = 'hello.txt'
const EXECUTE_LINE = 'codex-mcp e2e ok'
const CONTINUE_LINE = 'review feedback applied'

/** Assertion failure carrying the offending payload for diagnostics. */
export class AssertionFailure extends Error {
  constructor(message, payload) {
    super(message)
    this.name = 'AssertionFailure'
    this.payload = payload
  }
}

/** Environment precondition failure (e.g. codex not logged in) — exits with a distinct code. */
export class PreconditionFailure extends Error {
  constructor(message, payload) {
    super(message)
    this.name = 'PreconditionFailure'
    this.payload = payload
  }
}

/** Throw an AssertionFailure (with payload attached) unless the condition holds. */
export function assertThat(condition, message, payload) {
  if (!condition) {
    throw new AssertionFailure(message, payload)
  }
}

/** Extract the first text block from an MCP tool result, or throw. */
export function toolText(result, label) {
  const text = result?.content?.[0]?.text
  assertThat(typeof text === 'string', `${label}: tool result has no text content`, result)
  return text
}

/** Parse a tool result's text block as JSON, or throw with the raw text attached. */
export function parseToolPayload(result, label) {
  const text = toolText(result, label)
  try {
    return JSON.parse(text)
  } catch {
    throw new AssertionFailure(`${label}: tool result text is not valid JSON`, text)
  }
}

function readTargetFile(workdir) {
  const filePath = join(workdir, TARGET_FILE)
  assertThat(existsSync(filePath), `expected file was not created: ${filePath}`, { filePath })
  return readFileSync(filePath, 'utf8')
}

async function runSmoke(client, workdir) {
  // 1. Precondition: codex must be installed and logged in.
  const health = await client.callTool({ name: 'codex_health', arguments: {} })
  const healthPayload = parseToolPayload(health, 'codex_health')
  if (health.isError === true || healthPayload.loggedIn !== true) {
    throw new PreconditionFailure('precondition failed: codex not logged in', healthPayload)
  }
  console.log(`codex_health OK (version: ${healthPayload.version})`)

  // 2. codex_execute must succeed, return a session id, and create the file.
  const exec = await client.callTool({
    name: 'codex_execute',
    arguments: {
      prompt: `Create a file named ${TARGET_FILE} containing exactly the line "${EXECUTE_LINE}". Do nothing else.`,
      cwd: workdir,
      sandbox: 'workspace-write',
      timeoutMs: CODEX_TIMEOUT_MS,
    },
  })
  assertThat(exec.isError !== true, 'codex_execute returned isError=true', toolText(exec, 'codex_execute'))
  const execPayload = parseToolPayload(exec, 'codex_execute')
  assertThat(
    typeof execPayload.sessionId === 'string' && execPayload.sessionId.length > 0,
    'codex_execute did not return a sessionId',
    execPayload,
  )
  const executed = readTargetFile(workdir)
  assertThat(
    executed.trim() === EXECUTE_LINE,
    `${TARGET_FILE} content mismatch after codex_execute (expected "${EXECUTE_LINE}")`,
    { fileContent: executed, result: execPayload },
  )
  console.log(`codex_execute OK (sessionId: ${execPayload.sessionId})`)

  // 3. codex_continue must succeed and actually extend the file.
  const cont = await client.callTool({
    name: 'codex_continue',
    arguments: {
      sessionId: execPayload.sessionId,
      prompt: `Append a second line "${CONTINUE_LINE}" to ${TARGET_FILE}. Do nothing else.`,
      cwd: workdir,
      sandbox: 'workspace-write',
      timeoutMs: CODEX_TIMEOUT_MS,
    },
  })
  assertThat(cont.isError !== true, 'codex_continue returned isError=true', toolText(cont, 'codex_continue'))
  const contPayload = parseToolPayload(cont, 'codex_continue')
  const continued = readTargetFile(workdir)
  const lines = continued.trim().split('\n').map((line) => line.trim())
  assertThat(
    lines.length === 2 && lines[0] === EXECUTE_LINE && lines[1] === CONTINUE_LINE,
    `${TARGET_FILE} was not extended as instructed by codex_continue (expected 2 lines: "${EXECUTE_LINE}", "${CONTINUE_LINE}")`,
    { fileContent: continued, result: contPayload },
  )
  console.log('codex_continue OK (file extended as instructed)')

  console.log('PASS: smoke E2E succeeded (health, execute, continue all verified)')
}

async function main() {
  const workdir = mkdtempSync(join(tmpdir(), 'codex-mcp-e2e-'))
  const client = new Client({ name: 'smoke', version: '0.0.1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] })

  try {
    await client.connect(transport)
    await runSmoke(client, workdir)
  } catch (error) {
    if (error instanceof PreconditionFailure) {
      console.error(error.message)
      if (error.payload !== undefined) {
        console.error(JSON.stringify(error.payload, null, 2))
      }
      process.exitCode = EXIT_PRECONDITION_FAILED
    } else if (error instanceof AssertionFailure) {
      console.error(`FAIL: ${error.message}`)
      if (error.payload !== undefined) {
        console.error('payload:')
        console.error(typeof error.payload === 'string' ? error.payload : JSON.stringify(error.payload, null, 2))
      }
    } else {
      console.error('FAIL: unexpected error during smoke E2E')
      console.error(error)
    }
    process.exitCode = EXIT_ASSERTION_FAILED
  } finally {
    await client.close().catch(() => {})
    rmSync(workdir, { recursive: true, force: true })
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  await main()
}
