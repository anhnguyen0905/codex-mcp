import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { assertAbsoluteCwd, buildContinueArgs, buildExecuteArgs } from './argsBuilder.js'
import { runCodex, type RunOptions } from './codexRunner.js'
import { parseEvents } from './eventParser.js'
import { createLiveView, type LiveView } from './liveView.js'
import { SANDBOX_MODES, type RunOutcome } from './types.js'

const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000
const HEALTH_TIMEOUT_MS = 30 * 1000

type RunFn = (args: string[], options: Omit<RunOptions, 'spawnFn'>) => Promise<RunOutcome>
type LiveViewFactory = (cwd: string) => LiveView

const NULL_VIEW: LiveView = { onStdout: undefined, close: () => {}, logPath: null }

export interface ServerDeps {
  runFn?: RunFn
  liveViewFactory?: LiveViewFactory
}

const terminalEnabled = (requested?: boolean): boolean =>
  requested ?? process.env.CODEX_MCP_TERMINAL === '1'

const sandboxSchema = z.enum(SANDBOX_MODES).default('workspace-write')
const timeoutSchema = z.number().int().positive().max(MAX_TIMEOUT_MS).optional()

const executeShape = {
  prompt: z.string().describe('Task or plan for Codex to execute (can embed full plan text)'),
  cwd: z.string().describe('Absolute path of the workspace Codex should work in'),
  sandbox: sandboxSchema.describe('Codex sandbox policy (default: workspace-write)'),
  model: z.string().optional().describe('Codex model override, e.g. gpt-5.1-codex'),
  timeoutMs: timeoutSchema.describe('Max execution time in ms (default: 30 minutes)'),
  terminal: z
    .boolean()
    .optional()
    .describe('Open a Terminal window streaming live progress (default: env CODEX_MCP_TERMINAL=1)'),
}

const continueShape = {
  sessionId: z.string().describe('Session/thread id returned by a previous codex_execute call'),
  prompt: z.string().describe('Follow-up instruction, e.g. review findings to fix'),
  cwd: z.string().describe('Absolute path of the workspace Codex should work in'),
  sandbox: sandboxSchema.describe('Codex sandbox policy (default: workspace-write)'),
  model: z.string().optional().describe('Codex model override'),
  timeoutMs: timeoutSchema.describe('Max execution time in ms (default: 30 minutes)'),
  terminal: z
    .boolean()
    .optional()
    .describe('Open a Terminal window streaming live progress (default: env CODEX_MCP_TERMINAL=1)'),
}

const toToolResult = (payload: unknown, isError: boolean) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  isError,
})

interface RunAndReportDeps {
  runFn: RunFn
  view: LiveView
}

const runAndReport = async (
  { runFn, view }: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
) => {
  try {
    const outcome = await runFn(args, { ...options, onStdout: view.onStdout })
    const parsed = parseEvents(outcome.stdout)
    const isError = outcome.timedOut || outcome.exitCode !== 0 || parsed.errors.length > 0
    const payload = {
      ...parsed,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      stderr: outcome.stderr.slice(-2000),
      liveLog: view.logPath,
    }
    return toToolResult(payload, isError)
  } finally {
    view.close()
  }
}

const errorResult = (error: unknown) =>
  toToolResult({ error: error instanceof Error ? error.message : String(error) }, true)

export const createServer = (deps: ServerDeps = {}): McpServer => {
  const runFn: RunFn = deps.runFn ?? runCodex
  const liveViewFactory: LiveViewFactory = deps.liveViewFactory ?? createLiveView
  const openView = (cwd: string, requested?: boolean): LiveView =>
    terminalEnabled(requested) ? liveViewFactory(cwd) : NULL_VIEW
  const server = new McpServer({ name: 'codex-mcp', version: '0.1.0' })

  server.registerTool(
    'codex_execute',
    {
      title: 'Execute a task with Codex',
      description:
        'Start a new Codex session that executes a plan/task in the given workspace. ' +
        'Returns sessionId (keep it to send review feedback later), agent message, file changes and commands run.',
      inputSchema: executeShape,
    },
    async (input) => {
      try {
        const args = buildExecuteArgs(input)
        const view = openView(input.cwd, input.terminal)
        return await runAndReport({ runFn, view }, args, { cwd: input.cwd, timeoutMs: input.timeoutMs })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'codex_continue',
    {
      title: 'Continue a Codex session',
      description:
        'Resume an existing Codex session by sessionId with a follow-up prompt — ' +
        'typically review feedback that Codex should address. Preserves Codex context.',
      inputSchema: continueShape,
    },
    async (input) => {
      try {
        assertAbsoluteCwd(input.cwd)
        const args = buildContinueArgs(input)
        const view = openView(input.cwd, input.terminal)
        return await runAndReport({ runFn, view }, args, { cwd: input.cwd, timeoutMs: input.timeoutMs })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'codex_health',
    {
      title: 'Check Codex CLI health',
      description: 'Report installed Codex CLI version and login status.',
      inputSchema: {},
    },
    async () => {
      try {
        const cwd = process.cwd()
        const [version, login] = await Promise.all([
          runFn(['--version'], { cwd, timeoutMs: HEALTH_TIMEOUT_MS }),
          runFn(['login', 'status'], { cwd, timeoutMs: HEALTH_TIMEOUT_MS }),
        ])
        const loginText = `${login.stdout}\n${login.stderr}`
        const payload = {
          version: version.stdout.trim(),
          loggedIn: /logged in/i.test(loginText) && !/not logged in/i.test(loginText),
          loginStatus: loginText.trim(),
        }
        return toToolResult(payload, version.exitCode !== 0)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  return server
}
