import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { assertAbsoluteCwd, buildContinueArgs, buildExecuteArgs } from './argsBuilder.js'
import { runCodex, type RunOptions } from './codexRunner.js'
import { parseEvents } from './eventParser.js'
import { createLiveView, type LiveView } from './liveView.js'
import { combineSinks, createProgressNotifier, type ProgressSink } from './progressNotifier.js'
import { captureWorkspaceDiff, type DiffFn } from './workspaceDiff.js'
import { listSessions, MAX_LIMIT as MAX_SESSIONS_LIMIT } from './sessionStore.js'
import { SANDBOX_MODES, type RunOutcome } from './types.js'

const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000
const HEALTH_TIMEOUT_MS = 30 * 1000

type RunFn = (args: string[], options: Omit<RunOptions, 'spawnFn'>) => Promise<RunOutcome>
type LiveViewFactory = (cwd: string) => LiveView

const NULL_VIEW: LiveView = { onStdout: undefined, close: () => {}, logPath: null }

export interface ServerDeps {
  runFn?: RunFn
  liveViewFactory?: LiveViewFactory
  diffFn?: DiffFn
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

const sessionsShape = {
  cwd: z
    .string()
    .optional()
    .describe('Filter to sessions whose recorded cwd matches this path exactly.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_SESSIONS_LIMIT)
    .optional()
    .describe(`Cap on returned sessions (default 50, hard cap ${MAX_SESSIONS_LIMIT}).`),
}

const reviewShape = {
  cwd: z.string().describe('Absolute path of the workspace to review'),
  focus: z
    .string()
    .optional()
    .describe('Optional focus for the review, e.g. "security of the auth module"'),
  model: z.string().optional().describe('Codex model override'),
  timeoutMs: timeoutSchema.describe('Max execution time in ms (default: 30 minutes)'),
  terminal: z
    .boolean()
    .optional()
    .describe('Open a Terminal window streaming live progress (default: env CODEX_MCP_TERMINAL=1)'),
}

const buildReviewPrompt = (focus?: string): string =>
  [
    'Review the uncommitted changes in this workspace (inspect `git status` and `git diff HEAD`).',
    'Report findings ordered by severity (CRITICAL/HIGH/MEDIUM/LOW) with file:line references,',
    'covering correctness, security, error handling and maintainability.',
    'Do not modify any files — this is a read-only review.',
    ...(focus ? [`Focus especially on: ${focus}`] : []),
  ].join('\n')

const toToolResult = (payload: unknown, isError: boolean) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  isError,
})

interface RunAndReportDeps {
  runFn: RunFn
  view: LiveView
  diffFn: DiffFn
  progressSink?: ProgressSink
}

const safeDiff = async (diffFn: DiffFn, cwd: string) => {
  try {
    return await diffFn(cwd)
  } catch {
    return null
  }
}

const runAndReport = async (
  { runFn, view, diffFn, progressSink }: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
) => {
  try {
    const onStdout = combineSinks(view.onStdout, progressSink)
    const outcome = await runFn(args, { ...options, onStdout })
    const parsed = parseEvents(outcome.stdout)
    const aborted = outcome.aborted ?? false
    const isError = outcome.timedOut || aborted || outcome.exitCode !== 0 || parsed.errors.length > 0
    // Skip the diff for cancelled/timed-out runs: it delays releasing the cwd lock,
    // and the caller is about to retry or give up anyway.
    const shouldDiff = !aborted && !outcome.timedOut
    const payload = {
      ...parsed,
      diff: shouldDiff ? await safeDiff(diffFn, options.cwd) : null,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      aborted,
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

interface RunToolExtra {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (notification: ServerNotification) => Promise<void>
}

/** Stream formatted progress to the MCP client, but only when it asked for it (progressToken). */
const progressSinkFor = (extra: RunToolExtra): ProgressSink | undefined => {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) return undefined
  return createProgressNotifier((message, progress) => {
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message },
      })
      .catch(() => {})
  })
}

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin'])

/**
 * Normalize a cwd into a lock key that identifies the physical directory: resolve symlinks
 * (falling back to path resolution when the dir can't be inspected) and fold case on platforms
 * whose default filesystems are case-insensitive, so "C:\Repo" and "c:\repo" share one lock.
 */
export const cwdLockKey = (cwd: string, platform: NodeJS.Platform = process.platform): string => {
  let resolved: string
  try {
    resolved = realpathSync.native(cwd)
  } catch {
    resolved = resolvePath(cwd)
  }
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved
}

/**
 * Serializes Codex runs per workspace: two concurrent runs writing into the same cwd would
 * race on files and git state, so the second call fails fast with a clear message.
 */
const createCwdGuard = () => {
  const active = new Set<string>()
  return async <T>(cwd: string, run: () => Promise<T>): Promise<T> => {
    const key = cwdLockKey(cwd)
    if (active.has(key)) {
      throw new Error(
        `Another Codex run is already active in ${key}. Wait for it to finish (or cancel it) before starting a new one.`,
      )
    }
    active.add(key)
    try {
      return await run()
    } finally {
      active.delete(key)
    }
  }
}

export const createServer = (deps: ServerDeps = {}): McpServer => {
  const runFn: RunFn = deps.runFn ?? runCodex
  const diffFn: DiffFn = deps.diffFn ?? captureWorkspaceDiff
  const liveViewFactory: LiveViewFactory = deps.liveViewFactory ?? createLiveView
  const openView = (cwd: string, requested?: boolean): LiveView =>
    terminalEnabled(requested) ? liveViewFactory(cwd) : NULL_VIEW
  const withCwdLock = createCwdGuard()
  const server = new McpServer({ name: 'codex-mcp', version: '0.3.0' })

  server.registerTool(
    'codex_execute',
    {
      title: 'Execute a task with Codex',
      description:
        'Start a new Codex session that executes a plan/task in the given workspace. ' +
        'Returns sessionId (keep it to send review feedback later), agent message, file changes and commands run.',
      inputSchema: executeShape,
    },
    async (input, extra) => {
      try {
        const args = buildExecuteArgs(input)
        return await withCwdLock(input.cwd, () => {
          const view = openView(input.cwd, input.terminal)
          return runAndReport({ runFn, view, diffFn, progressSink: progressSinkFor(extra) }, args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            signal: extra.signal,
          })
        })
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
    async (input, extra) => {
      try {
        assertAbsoluteCwd(input.cwd)
        const args = buildContinueArgs(input)
        return await withCwdLock(input.cwd, () => {
          const view = openView(input.cwd, input.terminal)
          return runAndReport({ runFn, view, diffFn, progressSink: progressSinkFor(extra) }, args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            signal: extra.signal,
          })
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'codex_review',
    {
      title: 'Review workspace changes with Codex',
      description:
        'Ask Codex to review the uncommitted changes in a workspace (read-only sandbox, no files modified). ' +
        'Returns findings ordered by severity plus a sessionId usable with codex_continue.',
      inputSchema: reviewShape,
    },
    async (input, extra) => {
      try {
        const args = buildExecuteArgs({
          prompt: buildReviewPrompt(input.focus),
          cwd: input.cwd,
          sandbox: 'read-only',
          model: input.model,
        })
        return await withCwdLock(input.cwd, () => {
          const view = openView(input.cwd, input.terminal)
          return runAndReport({ runFn, view, diffFn, progressSink: progressSinkFor(extra) }, args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            signal: extra.signal,
          })
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'codex_sessions',
    {
      title: 'List prior Codex sessions',
      description:
        'Discover Codex sessions stored locally under ~/.codex/sessions/. Returns sessionId, cwd, ' +
        'and last activity for each, newest first. sessionId can be passed to codex_continue to resume. ' +
        'Filter by cwd to find sessions from a specific workspace.',
      inputSchema: sessionsShape,
    },
    async (input) => {
      try {
        const sessions = await listSessions({ cwd: input.cwd, limit: input.limit })
        return toToolResult({ sessions, total: sessions.length }, false)
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
