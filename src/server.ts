import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  assertAbsoluteCwd,
  buildContinueInvocation,
  buildExecuteInvocation,
  type CodexInvocation,
} from './argsBuilder.js'
import { runCodex, type RunOptions, type RunOutcomeWithEvents } from './codexRunner.js'
import { parseEvents, type ParsedEvents } from './eventParser.js'
import { deriveRunStatus, isErrorStatus, RESULT_SCHEMA_VERSION, type RunStatus } from './runStatus.js'
import { createLiveView, type LiveView } from './liveView.js'
import { combineSinks, createProgressNotifier, type ProgressSink } from './progressNotifier.js'
import {
  attributeWorkspaceDiff,
  captureWorkspaceDiff,
  captureWorkspaceSnapshot,
  verifyGitRef,
  type AttributeFn,
  type DiffFn,
  type RunAttribution,
  type SnapshotFn,
  type WorkspaceSnapshot,
} from './workspaceDiff.js'
import { acquireWorkspaceLease, type LeaseFn } from './workspaceLease.js'
import { listSessions, MAX_LIMIT as MAX_SESSIONS_LIMIT } from './sessionStore.js'
import { writeNotes, type NotesRequest } from './notesWriter.js'
import { aggregate, appendMetric, parsePricing, readMetrics, type MetricEntry } from './metricsLog.js'
import { SANDBOX_MODES, type RunOutcome } from './types.js'
import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_ALLOWED_CONCURRENCY,
  runBatch,
  type BatchTaskResult,
  type BatchTaskSpec,
} from './batchRunner.js'

const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000
const HEALTH_TIMEOUT_MS = 30 * 1000

/** Global cap on concurrent Codex runs across all workspaces (override via CODEX_MCP_MAX_CONCURRENT). */
const DEFAULT_MAX_CONCURRENT_RUNS = 16
const parseMaxConcurrent = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_RUNS
  const n = Number(raw)
  // Validate explicitly rather than `Number(raw) || 16`, which silently swallows a configured 0/NaN.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT_RUNS
}
const MAX_CONCURRENT_RUNS = parseMaxConcurrent(process.env.CODEX_MCP_MAX_CONCURRENT)

/** Read the package version at runtime so the MCP server-info never drifts from package.json. */
const readVersion = (): string => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const version: unknown = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

type RunFn = (args: string[], options: Omit<RunOptions, 'spawnFn'>) => Promise<RunOutcomeWithEvents>
type LiveViewFactory = (cwd: string) => LiveView

const NULL_VIEW: LiveView = { onStdout: undefined, close: () => {}, logPath: null }

type VerifyRefFn = (cwd: string, ref: string) => Promise<boolean>

export interface ServerDeps {
  runFn?: RunFn
  liveViewFactory?: LiveViewFactory
  diffFn?: DiffFn
  /** Before-run workspace snapshot (dirty-file content hashes) used to attribute changes. */
  snapshotFn?: SnapshotFn
  /** Post-run classifier: changedByRun vs preExisting against the snapshot. */
  attributeFn?: AttributeFn
  /** Verifies a codex_review baselineRef resolves to a commit. */
  verifyRefFn?: VerifyRefFn
  /** Cross-process workspace lease (default: lease files under ~/.codex-mcp/locks). */
  leaseFn?: LeaseFn
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
  writeNotes: z
    .boolean()
    .optional()
    .describe('Persist a markdown summary of this run to <cwd>/.codex-flow/notes/<sessionId>.md (default false).'),
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
  writeNotes: z
    .boolean()
    .optional()
    .describe('Persist a markdown summary of this run to <cwd>/.codex-flow/notes/<sessionId>.md (default false).'),
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

const metricsShape = {
  since: z
    .string()
    .optional()
    .describe('ISO 8601 lower bound — only entries at or after this timestamp are aggregated.'),
  until: z.string().optional().describe('ISO 8601 upper bound.'),
  tool: z
    .enum(['codex_execute', 'codex_continue', 'codex_review', 'codex_batch'])
    .optional()
    .describe('Filter by which tool produced the run.'),
  cwd: z.string().optional().describe('Filter by exact cwd.'),
  sessionId: z.string().optional().describe('Filter by session id.'),
}

const batchTaskShape = z.object({
  cwd: z.string(),
  prompt: z.string(),
  sandbox: sandboxSchema.optional(),
  model: z.string().optional(),
  timeoutMs: timeoutSchema,
})

const batchShape = {
  tasks: z
    .array(batchTaskShape)
    .min(1)
    .max(50)
    .describe(
      'Tasks to run in parallel, one per workspace. Each task uses its own cwd (must be unique in the batch).',
    ),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .max(MAX_ALLOWED_CONCURRENCY)
    .optional()
    .describe(`Cap on parallel tasks (default ${DEFAULT_BATCH_CONCURRENCY}, hard cap ${MAX_ALLOWED_CONCURRENCY}).`),
  failFast: z
    .boolean()
    .optional()
    .describe('If true, cancel remaining tasks on the first failure. Default false (continue-on-error).'),
}

/**
 * Plausible git ref/rev expression: must not start with `-` (would be parsed as a git flag)
 * and must not contain whitespace, colons, or backslashes.
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./@{}^~-]*$/
const MAX_REF_LENGTH = 256

const reviewShape = {
  cwd: z.string().describe('Absolute path of the workspace to review'),
  baselineRef: z
    .string()
    .min(1)
    .max(MAX_REF_LENGTH)
    .regex(GIT_REF_PATTERN, 'baselineRef must be a plausible git ref (no leading "-", no whitespace)')
    .optional()
    .describe(
      'Optional git ref to review from: Codex reviews `git diff <baselineRef>..HEAD` plus current ' +
        'uncommitted changes, so checkpoint/merge commits made since the baseline are covered.',
    ),
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
  writeNotes: z
    .boolean()
    .optional()
    .describe('Persist a markdown summary of this run to <cwd>/.codex-flow/notes/<sessionId>.md (default false).'),
}

const buildReviewPrompt = (focus?: string, baselineRef?: string): string =>
  [
    ...(baselineRef
      ? [
          `Review all changes since baseline ${baselineRef}: inspect \`git diff ${baselineRef}..HEAD\``,
          'for committed changes AND `git status` / `git diff HEAD` for current uncommitted changes.',
        ]
      : ['Review the uncommitted changes in this workspace (inspect `git status` and `git diff HEAD`).']),
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
  snapshotFn: SnapshotFn
  attributeFn: AttributeFn
  /** Server-generated UUID identifying this run in the payload, notes, and metric entry. */
  runId: string
  progressSink?: ProgressSink
  /** When provided, writeNotes() runs after payload is built (best-effort; errors are logged, not thrown). */
  notes?: Omit<NotesRequest, 'sessionId' | 'parsed' | 'exitCode' | 'runId'>
  /** Which tool invoked runAndReport, so the metric log can attribute the run. */
  tool: MetricEntry['tool']
}

const safeDiff = async (diffFn: DiffFn, cwd: string) => {
  try {
    return await diffFn(cwd)
  } catch {
    return null
  }
}

const safeSnapshot = async (snapshotFn: SnapshotFn, cwd: string): Promise<WorkspaceSnapshot | null> => {
  try {
    return await snapshotFn(cwd)
  } catch {
    return null
  }
}

const safeAttribute = async (
  attributeFn: AttributeFn,
  cwd: string,
  snapshot: WorkspaceSnapshot | null,
): Promise<RunAttribution | null> => {
  try {
    return await attributeFn(cwd, snapshot)
  } catch {
    return null
  }
}

/** Keep the last `n` chars without leaving a dangling low surrogate that would corrupt on encode. */
const tailString = (value: string, n: number): string => {
  if (value.length <= n) return value
  const sliced = value.slice(-n)
  const first = sliced.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced
}

/**
 * Classify a run's primary failure kind for the metric log, by precedence:
 * abort > timeout > non-zero exit > Codex-emitted errors (turn.failed). Undefined on success.
 */
const deriveErrorKind = (
  outcome: { exitCode: number | null; timedOut: boolean },
  aborted: boolean,
  errorCount: number,
): MetricEntry['errorKind'] => {
  if (aborted) return 'abort'
  if (outcome.timedOut) return 'timeout'
  if (outcome.exitCode !== 0) return 'exit'
  if (errorCount > 0) return 'turn-failed'
  return undefined
}

/** Run one Codex invocation and return the raw payload; shared by codex_execute/continue/review/batch. */
const runOnce = async (
  { runFn, view, diffFn, snapshotFn, attributeFn, runId, progressSink, notes, tool }: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
): Promise<{ payload: RunPayload; isError: boolean }> => {
  const startedAt = Date.now()
  try {
    // Before-run snapshot of already-dirty files so post-run changes can be attributed
    // (pre-existing dirt vs changes this run actually made). Best-effort — never fails the run.
    const snapshot = await safeSnapshot(snapshotFn, options.cwd)
    const onStdout = combineSinks(view.onStdout, progressSink)
    const outcome = await runFn(args, { ...options, onStdout })
    // Prefer the runner's lossless streamed parse (it saw bytes the raw stdout tail may have
    // rotated out). Fallback re-parse only covers injected fakes that return a bare RunOutcome.
    const parsed: ParsedEvents = outcome.parsed ?? parseEvents(outcome.stdout)
    const aborted = outcome.aborted ?? false
    const status = deriveRunStatus(
      { exitCode: outcome.exitCode, timedOut: outcome.timedOut, aborted },
      parsed,
    )
    const isError = isErrorStatus(status)
    let notesPath: string | null = null
    if (notes && parsed.sessionId) {
      try {
        notesPath = writeNotes({
          ...notes,
          sessionId: parsed.sessionId,
          parsed,
          exitCode: outcome.exitCode,
          runId,
        })
      } catch (err) {
        // best-effort: a broken notes write must never fail the actual run.
        console.error(`codex-mcp: writeNotes failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Capture the diff even on timeout/abort: the workspace may be half-mutated and the caller
    // needs to see (and attribute) what changed before deciding to retry or roll back.
    const payload: RunPayload = {
      ...parsed,
      schemaVersion: RESULT_SCHEMA_VERSION,
      status,
      runId,
      diff: await safeDiff(diffFn, options.cwd),
      attribution: await safeAttribute(attributeFn, options.cwd, snapshot),
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      aborted,
      // Raw-tail rotation only (informational): the streamed parse saw the full stream, so a
      // rotated raw tail never downgrades `status` by itself.
      outputTruncated: outcome.truncated ?? false,
      stderr: tailString(outcome.stderr, 2000),
      liveLog: view.logPath,
      notesPath,
    }
    // Passive metrics — one JSONL line per completed run, best-effort (never fails the run).
    appendMetric({
      ts: new Date().toISOString(),
      tool,
      cwd: options.cwd,
      sessionId: parsed.sessionId,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
      usage: parsed.usage,
      timedOut: outcome.timedOut,
      aborted,
      truncated: outcome.truncated ?? false,
      errorCount: parsed.errors.length,
      errorKind: deriveErrorKind(outcome, aborted, parsed.errors.length),
      runId,
    })
    return { payload, isError }
  } finally {
    view.close()
  }
}

type RunPayload = ParsedEvents & {
  schemaVersion: number
  status: RunStatus
  runId: string
  diff: Awaited<ReturnType<DiffFn>> | null
  attribution: RunAttribution | null
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  outputTruncated: boolean
  stderr: string
  liveLog: string | null
  notesPath: string | null
}

const runAndReport = async (
  deps: RunAndReportDeps,
  args: string[],
  options: Omit<RunOptions, 'spawnFn' | 'onStdout'>,
) => {
  const { payload, isError } = await runOnce(deps, args, options)
  return toToolResult(payload, isError)
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
const realpathStable = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    // Leaf may not exist yet (e.g. a task that scaffolds a new dir). Realpath the deepest
    // existing ancestor and re-attach the missing tail so the key is identical before and
    // after the dir is created — otherwise a run that creates cwd mid-flight would let a
    // second run compute a divergent (now-resolvable) key and bypass the lock.
    const parent = dirname(path)
    if (parent === path) return resolvePath(path) // filesystem root: nothing left to resolve
    return join(realpathStable(parent), basename(path))
  }
}

export const cwdLockKey = (cwd: string, platform: NodeJS.Platform = process.platform): string => {
  const resolved = realpathStable(resolvePath(cwd))
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? resolved.toLowerCase() : resolved
}

/**
 * Serializes Codex runs per workspace: two concurrent runs writing into the same cwd would
 * race on files and git state, so the second call fails fast with a clear message.
 * Layered: the in-memory slot (fast path, this process) is taken first, then the
 * cross-process lease file; both are released in reverse order in the same finally.
 */
const createCwdGuard = (leaseFn: LeaseFn) => {
  const active = new Set<string>()
  return async <T>(cwd: string, runId: string, run: () => Promise<T>): Promise<T> => {
    const key = cwdLockKey(cwd)
    if (active.has(key)) {
      throw new Error(
        `Another Codex run is already active in ${key}. Wait for it to finish (or cancel it) before starting a new one.`,
      )
    }
    active.add(key)
    try {
      const lease = await leaseFn(cwd, runId)
      try {
        return await run()
      } finally {
        lease.release()
      }
    } finally {
      active.delete(key)
    }
  }
}

/**
 * Global backstop on how many Codex runs can be in flight at once across ALL workspaces. The
 * per-cwd guard doesn't bound this (distinct cwds each get their own lock), so a burst of
 * many-cwd calls could otherwise exhaust memory/file descriptors. Fails fast past the cap.
 */
const createConcurrencyGate = (max: number) => {
  let active = 0
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      throw new Error(`Too many concurrent Codex runs (max ${max}). Wait for one to finish and retry.`)
    }
    active += 1
    try {
      return await run()
    } finally {
      active -= 1
    }
  }
}

export const createServer = (deps: ServerDeps = {}): McpServer => {
  const runFn: RunFn = deps.runFn ?? runCodex
  const diffFn: DiffFn = deps.diffFn ?? captureWorkspaceDiff
  const snapshotFn: SnapshotFn = deps.snapshotFn ?? captureWorkspaceSnapshot
  const attributeFn: AttributeFn = deps.attributeFn ?? attributeWorkspaceDiff
  const verifyRefFn: VerifyRefFn = deps.verifyRefFn ?? verifyGitRef
  const leaseFn: LeaseFn = deps.leaseFn ?? acquireWorkspaceLease
  const liveViewFactory: LiveViewFactory = deps.liveViewFactory ?? createLiveView
  const openView = (cwd: string, requested?: boolean): LiveView =>
    terminalEnabled(requested) ? liveViewFactory(cwd) : NULL_VIEW
  const withCwdLock = createCwdGuard(leaseFn)
  const withConcurrencyLimit = createConcurrencyGate(MAX_CONCURRENT_RUNS)
  const server = new McpServer({ name: 'codex-mcp', version: readVersion() })

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
        // Prompt travels over stdin (`-- -`); an over-limit prompt throws here and surfaces as a
        // clean tool validation error via the catch below.
        const { args, stdinInput }: CodexInvocation = buildExecuteInvocation(input)
        const startedAt = new Date().toISOString()
        const runId = randomUUID()
        return await withConcurrencyLimit(() =>
          withCwdLock(input.cwd, runId, () => {
            const view = openView(input.cwd, input.terminal)
            return runAndReport(
              {
                runFn,
                view,
                diffFn,
                snapshotFn,
                attributeFn,
                runId,
                progressSink: progressSinkFor(extra),
                notes: input.writeNotes ? { cwd: input.cwd, prompt: input.prompt, mode: 'execute', startedAt } : undefined,
                tool: 'codex_execute',
              },
              args,
              { cwd: input.cwd, timeoutMs: input.timeoutMs, signal: extra.signal, stdinInput },
            )
          }),
        )
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
        const { args, stdinInput }: CodexInvocation = buildContinueInvocation(input)
        const startedAt = new Date().toISOString()
        const runId = randomUUID()
        return await withConcurrencyLimit(() =>
          withCwdLock(input.cwd, runId, () => {
            const view = openView(input.cwd, input.terminal)
            return runAndReport(
              {
                runFn,
                view,
                diffFn,
                snapshotFn,
                attributeFn,
                runId,
                progressSink: progressSinkFor(extra),
                notes: input.writeNotes ? { cwd: input.cwd, prompt: input.prompt, mode: 'continue', startedAt } : undefined,
                tool: 'codex_continue',
              },
              args,
              { cwd: input.cwd, timeoutMs: input.timeoutMs, signal: extra.signal, stdinInput },
            )
          }),
        )
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
        const { args, stdinInput }: CodexInvocation = buildExecuteInvocation({
          prompt: buildReviewPrompt(input.focus, input.baselineRef),
          cwd: input.cwd,
          sandbox: 'read-only',
          model: input.model,
        })
        if (input.baselineRef !== undefined) {
          const refExists = await verifyRefFn(input.cwd, input.baselineRef)
          if (!refExists) {
            return errorResult(
              new Error(
                `baselineRef "${input.baselineRef}" does not resolve to a commit in ${input.cwd}. ` +
                  'Pass a valid ref (e.g. the Phase-0 baseline SHA) or omit baselineRef.',
              ),
            )
          }
        }
        const startedAt = new Date().toISOString()
        const notePrompt = input.focus ?? 'review workspace changes'
        const runId = randomUUID()
        return await withConcurrencyLimit(() =>
          withCwdLock(input.cwd, runId, () => {
            const view = openView(input.cwd, input.terminal)
            return runAndReport(
              {
                runFn,
                view,
                diffFn,
                snapshotFn,
                attributeFn,
                runId,
                progressSink: progressSinkFor(extra),
                notes: input.writeNotes ? { cwd: input.cwd, prompt: notePrompt, mode: 'review', startedAt } : undefined,
                tool: 'codex_review',
              },
              args,
              { cwd: input.cwd, timeoutMs: input.timeoutMs, signal: extra.signal, stdinInput },
            )
          }),
        )
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
    'codex_metrics',
    {
      title: 'Aggregated Codex run metrics',
      description:
        'Roll up token/duration/failure counts from the local metrics log (~/.codex-mcp/metrics.jsonl). ' +
        'Set CODEX_MCP_PRICING (JSON: {inputPer1M, cachedInputPer1M, outputPer1M, reasoningOutputPer1M}) ' +
        'to include estCostUsd.',
      inputSchema: metricsShape,
    },
    async (input) => {
      try {
        const entries = readMetrics()
        const pricing = parsePricing(process.env.CODEX_MCP_PRICING)
        const agg = aggregate(entries, input, pricing)
        return toToolResult(agg, false)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'codex_batch',
    {
      title: 'Run multiple Codex tasks in parallel across workspaces',
      description:
        'Fan out N tasks across N cwds (typically git worktrees) with a bounded concurrency limit. ' +
        'Each task uses its own per-cwd lock, so callers must supply distinct cwds. ' +
        'Returns one result entry per input task in input order.',
      inputSchema: batchShape,
    },
    async (input, extra) => {
      try {
        const runOneTask = async (
          spec: BatchTaskSpec,
          taskIndex: number,
          signal: AbortSignal,
        ): Promise<BatchTaskResult> => {
          const { args, stdinInput }: CodexInvocation = buildExecuteInvocation({
            prompt: spec.prompt,
            cwd: spec.cwd,
            sandbox: spec.sandbox ?? 'workspace-write',
            model: spec.model,
          })
          const runId = randomUUID()
          // Each batch task also passes through the global concurrency gate so a batch
          // cannot exceed the server-wide CODEX_MCP_MAX_CONCURRENT cap.
          return withConcurrencyLimit(() =>
            withCwdLock(spec.cwd, runId, async () => {
              // Batch mode: no per-task terminal window (would spam N desktop windows) and no
              // progress sink — N tasks sharing one progressToken would interleave counters
              // into a non-monotonic stream the client can't attribute to a task.
              const { payload, isError } = await runOnce(
                { runFn, view: NULL_VIEW, diffFn, snapshotFn, attributeFn, runId, tool: 'codex_batch' },
                args,
                { cwd: spec.cwd, timeoutMs: spec.timeoutMs, signal, stdinInput },
              )
              const {
                schemaVersion,
                status,
                diff,
                attribution,
                runId: taskRunId,
                exitCode,
                timedOut,
                aborted,
                outputTruncated,
                stderr,
                liveLog,
                notesPath,
                ...parsed
              } = payload
              return {
                taskIndex,
                cwd: spec.cwd,
                schemaVersion,
                status,
                parsed,
                runId: taskRunId,
                diff,
                attribution,
                exitCode,
                timedOut,
                aborted,
                outputTruncated,
                stderr,
                liveLog,
                isError,
              }
            }),
          )
        }
        const tasks = input.tasks as readonly BatchTaskSpec[]
        // Clamp to the server-wide cap: the global gate is fail-fast, so letting the batch
        // pool exceed it would make the excess workers error out instead of queue.
        const maxConcurrency = Math.min(input.maxConcurrency ?? DEFAULT_BATCH_CONCURRENCY, MAX_CONCURRENT_RUNS)
        const results = await runBatch(
          tasks,
          runOneTask,
          { maxConcurrency, failFast: input.failFast },
          extra.signal,
        )
        const anyError = results.some((r) => r.isError)
        return toToolResult(
          { tasks: results, total: results.length, failed: results.filter((r) => r.isError).length },
          anyError,
        )
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
    async (_input, extra) => {
      try {
        const cwd = process.cwd()
        const { signal } = extra
        // Gate health too: each call spawns 2 codex processes; without this a burst of health
        // calls bypasses the global cap and can exhaust process/fd limits. (No cwd lock — health
        // is read-only and doesn't touch a workspace.)
        return await withConcurrencyLimit(async () => {
          const [version, login] = await Promise.all([
            runFn(['--version'], { cwd, timeoutMs: HEALTH_TIMEOUT_MS, signal }),
            runFn(['login', 'status'], { cwd, timeoutMs: HEALTH_TIMEOUT_MS, signal }),
          ])
          const ok = (r: RunOutcome): boolean => r.exitCode === 0 && !r.timedOut && !(r.aborted ?? false)
          const loginText = `${login.stdout}\n${login.stderr}`
          const payload = {
            version: version.stdout.trim(),
            // Only claim logged-in when the login probe itself succeeded — a hung/killed
            // `codex login status` must not be reported as authenticated.
            loggedIn: ok(login) && /logged in/i.test(loginText) && !/not logged in/i.test(loginText),
            loginStatus: loginText.trim(),
          }
          return toToolResult(payload, !ok(version))
        })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  return server
}
