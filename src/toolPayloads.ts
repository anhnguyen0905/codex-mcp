import { z } from 'zod'
import type { BatchTaskResult } from './batchRunner.js'
import type { ParsedEvents } from './eventParser.js'
import type { ResumeReason } from './retryPolicy.js'
import type { RunStatus } from './runStatus.js'
import type { DiffFn, RunAttribution } from './workspaceDiff.js'

/**
 * Named payload shapes for every codex-mcp tool result plus the structured-content plumbing
 * (T4.4). Each tool result carries the payload twice, on purpose:
 * - `content[0].text` — pretty-printed JSON, byte-identical to the pre-T4.4 format so existing
 *   text-parsing callers keep working.
 * - `structuredContent` — the same object, validated against the tool's registered outputSchema
 *   by the MCP SDK (server-side on non-error results, client-side whenever present).
 */

/** Result payload for codex_execute / codex_continue / codex_review. */
export type RunPayload = ParsedEvents & {
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
  attempts?: number
  resumeReasons?: readonly ResumeReason[]
}

/** Per-status roll-up over a batch's task results (T4.6). */
export interface BatchSummary {
  total: number
  succeeded: number
  failed: number
  aborted: number
  partial: number
}

/** Result payload for codex_batch. */
export interface BatchToolPayload {
  tasks: BatchTaskResult[]
  total: number
  /** Count of tasks with isError=true (kept for backward compatibility; see summary). */
  failed: number
  summary: BatchSummary
}

export type LoginProbeStatus = 'ok' | 'failed' | 'timeout'

/** Result payload for codex_health. */
export interface HealthPayload {
  version: string
  loggedIn: boolean
  /** Whether the `codex login status` probe itself worked — a failed/timed-out probe must never read as "not logged in". */
  loginProbe: LoginProbeStatus
  loginStatus: string
}

export const summarizeBatch = (results: readonly BatchTaskResult[]): BatchSummary => ({
  total: results.length,
  succeeded: results.filter((r) => r.status === 'success').length,
  failed: results.filter((r) => r.status === 'failed').length,
  aborted: results.filter((r) => r.status === 'aborted').length,
  partial: results.filter((r) => r.status === 'partial').length,
})

/**
 * Standard tool-result envelope: pretty JSON text block (backward compatible) plus
 * `structuredContent` carrying the identical payload object.
 */
export const toToolResult = (payload: object, isError: boolean) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload as { [key: string]: unknown },
  isError,
})

/**
 * Envelope for orchestration/validation errors ({ error } payloads). Deliberately text-only:
 * the SDK's client validates `structuredContent` against the tool's outputSchema whenever it is
 * present — even on isError results — and the bare error shape does not match the run schemas.
 */
export const toErrorResult = (error: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
    },
  ],
  isError: true,
})

// --- outputSchema shapes (registered with the SDK, advertised via tools/list) ---

const runStatusSchema = z.enum(['success', 'partial', 'failed', 'aborted'])
const resumeReasonSchema = z.enum([
  'timeout',
  'transient-turn-failure',
  'no-completion-marker',
])

const usageSchema = z
  .object({
    inputTokens: z.number(),
    cachedInputTokens: z.number(),
    outputTokens: z.number(),
    reasoningOutputTokens: z.number(),
  })
  .nullable()

const fileChangeSchema = z.object({ path: z.string(), kind: z.string() })
const commandSchema = z.object({ command: z.string(), exitCode: z.number().nullable() })

const diffSchema = z
  .object({
    status: z.string(),
    statusTruncated: z.boolean(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .nullable()

const attributionSchema = z
  .object({ files: z.array(z.looseObject({})), untracked: z.array(z.looseObject({})) })
  .nullable()

const codexResultShape = {
  sessionId: z.string().nullable(),
  agentMessage: z.string().nullable(),
  fileChanges: z.array(fileChangeSchema),
  commands: z.array(commandSchema),
  usage: usageSchema,
  errors: z.array(z.string()),
}

const parsedEventsShape = {
  ...codexResultShape,
  parseErrors: z.number(),
  unknownEvents: z.number(),
  sawCompletion: z.boolean(),
  warnings: z.array(z.string()),
  turnCount: z.number(),
}

/** outputSchema for codex_execute / codex_continue / codex_review results. */
export const runOutputShape = {
  ...parsedEventsShape,
  schemaVersion: z.number(),
  status: runStatusSchema,
  runId: z.string(),
  diff: diffSchema,
  attribution: attributionSchema,
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  outputTruncated: z.boolean(),
  stderr: z.string(),
  liveLog: z.string().nullable(),
  notesPath: z.string().nullable(),
  attempts: z.number().optional(),
  resumeReasons: z.array(resumeReasonSchema).optional(),
}

// Skipped/never-started batch tasks carry a bare CodexResult without parser counters.
const batchParsedSchema = z.object({
  ...codexResultShape,
  parseErrors: z.number().optional(),
  unknownEvents: z.number().optional(),
  sawCompletion: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  turnCount: z.number().optional(),
})

const batchTaskResultSchema = z.object({
  taskIndex: z.number(),
  cwd: z.string(),
  schemaVersion: z.number(),
  status: runStatusSchema,
  parsed: batchParsedSchema,
  runId: z.string().optional(),
  attempts: z.number().optional(),
  resumeReasons: z.array(resumeReasonSchema).optional(),
  diff: diffSchema,
  attribution: attributionSchema.optional(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  outputTruncated: z.boolean().optional(),
  stderr: z.string(),
  liveLog: z.string().nullable(),
  isError: z.boolean(),
  error: z.string().optional(),
})

const batchSummarySchema = z.object({
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  aborted: z.number(),
  partial: z.number(),
})

/** outputSchema for codex_batch results. */
export const batchOutputShape = {
  tasks: z.array(batchTaskResultSchema),
  total: z.number(),
  failed: z.number(),
  summary: batchSummarySchema,
}

/** outputSchema for codex_health results. */
export const healthOutputShape = {
  version: z.string(),
  loggedIn: z.boolean(),
  loginProbe: z.enum(['ok', 'failed', 'timeout']),
  loginStatus: z.string(),
}
