import { z } from 'zod'

import { canonicalPath } from './pathCanonical.js'

/**
 * Structured review output for codex_review. The review prompt asks Codex to end its message with
 * one fenced ```json block; the server parses it fail-closed so the orchestrator reads typed
 * findings instead of re-deriving severities from prose (a hallucination surface).
 */

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export type Severity = (typeof SEVERITIES)[number]

const severitySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toUpperCase() : value),
  z.enum(SEVERITIES),
)

export const findingSchema = z.object({
  severity: severitySchema,
  file: z.string().min(1),
  line: z.number().int(),
  summary: z.string().min(1),
  expected: z.string().min(1),
  observed: z.string().min(1),
  /**
   * Whether `file` is inside the task's declared `scope.files`. Absent unless
   * `annotateScope` ran — the reviewer never supplies it, and a review without a
   * scope leaves every finding unannotated rather than guessing.
   */
  inScope: z.boolean().optional(),
})

export const improvementSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  file: z.string().optional(),
})

export type ReviewFinding = z.infer<typeof findingSchema>
export type ReviewImprovement = z.infer<typeof improvementSchema>

export interface ReviewFindings {
  /** True when a fenced json block was found and parsed as an object. */
  parsed: boolean
  findings: ReviewFinding[]
  improvements: ReviewImprovement[]
  /** Entries present in the block but rejected by the schema (never coerced into a severity). */
  dropped: number
  /**
   * One ordered entry per dropped item naming its first failing field, as
   * `findings[<index>].<field>` / `improvements[<index>].<field>` (the index alone when the
   * whole entry is invalid, e.g. a string instead of an object).
   */
  droppedReasons: string[]
  /**
   * How many findings fall outside the task's declared `scope.files`. Absent unless
   * `annotateScope` ran; findings are annotated, never dropped, so this is a counter
   * over `findings`, not a difference in its length.
   */
  outOfScopeCount?: number
  /** Why `parsed` is false. */
  parseError?: string
}

/** IMP-20: `dropped` is defined as the number of drop reasons, so a mismatch is a bug, not data. */
const DROPPED_COUNT_MISMATCH = 'dropped must equal droppedReasons.length'

export const reviewFindingsSchema = z
  .object({
    parsed: z.boolean(),
    findings: z.array(findingSchema),
    improvements: z.array(improvementSchema),
    dropped: z.number(),
    droppedReasons: z.array(z.string()),
    outOfScopeCount: z.number().int().nonnegative().optional(),
    parseError: z.string().optional(),
  })
  .refine((value) => value.dropped === value.droppedReasons.length, {
    message: DROPPED_COUNT_MISMATCH,
    path: ['dropped'],
  })

export const REVIEW_FINDINGS_INSTRUCTIONS = [
  'After the prose, END your message with exactly one fenced ```json block of this shape (no other text after it):',
  '```json',
  '{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"path/relative/to/cwd","line":123,"summary":"one sentence","expected":"...","observed":"..."}],',
  ' "improvements":[{"id":"IMP-1","summary":"non-blocking suggestion","file":"path:line"}]}',
  '```',
  'Both "findings" and "improvements" arrays are required; use an empty array when there are no entries.',
  'Every finding must include non-empty "expected" and "observed" strings. Never invent a severity outside the four listed.',
  'Every finding must include an integer "line" — null or a missing "line" makes the finding invalid and it is dropped.',
].join('\n')

const JSON_FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g

const lastJsonBlock = (text: string): string | undefined => {
  let last: string | undefined
  for (const match of text.matchAll(JSON_FENCE)) last = match[1]
  return last
}

const notParsed = (parseError: string): ReviewFindings => ({
  parsed: false,
  findings: [],
  improvements: [],
  dropped: 0,
  droppedReasons: [],
  parseError,
})

interface CollectResult<T> {
  kept: T[]
  reasons: string[]
}

/** `findings[2].line` for a field issue, `findings[2]` when the whole entry is invalid. */
const dropReason = (arrayName: string, index: number, error: z.ZodError): string => {
  const field = error.issues[0]?.path.join('.') ?? ''
  const location = `${arrayName}[${index}]`
  return field === '' ? location : `${location}.${field}`
}

/**
 * IMP-32: `inScope` is produced by `annotateScope` alone. A reviewer that supplies the key (of any
 * type) must not be able to forge the annotation, nor to get an otherwise-valid finding dropped by
 * a type error on it — so the key is removed before validation and the finding stays unannotated.
 */
const withoutReviewerScope = (item: unknown): unknown => {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
  if (!('inScope' in item)) return item
  const { inScope: _reviewerSupplied, ...rest } = item as Record<string, unknown>
  return rest
}

const collect = <T>(items: readonly unknown[], schema: z.ZodType<T>, arrayName: string): CollectResult<T> =>
  items.reduce<CollectResult<T>>(
    (acc, item, index) => {
      const result = schema.safeParse(item)
      return result.success
        ? { kept: [...acc.kept, result.data], reasons: acc.reasons }
        : { kept: acc.kept, reasons: [...acc.reasons, dropReason(arrayName, index, result.error)] }
    },
    { kept: [], reasons: [] },
  )

/** Parse the reviewer's agentMessage; never throws. */
export const parseReviewFindings = (agentMessage: string | null): ReviewFindings => {
  if (agentMessage === null) return notParsed('no agent message')
  const block = lastJsonBlock(agentMessage)
  if (block === undefined) return notParsed('no fenced json block in agent message')
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch (error) {
    return notParsed(`invalid json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return notParsed('json block is not an object')
  }
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.findings)) return notParsed('missing findings array')
  if (!Array.isArray(record.improvements)) return notParsed('missing improvements array')
  const findings = collect(record.findings.map(withoutReviewerScope), findingSchema, 'findings')
  const improvements = collect(record.improvements, improvementSchema, 'improvements')
  const droppedReasons = [...findings.reasons, ...improvements.reasons]
  return {
    parsed: true,
    findings: findings.kept,
    improvements: improvements.kept,
    dropped: droppedReasons.length,
    droppedReasons,
  }
}

export interface ScopeAnnotation {
  /** Every input finding, in order, with `inScope` set. Nothing is ever dropped. */
  findings: ReviewFinding[]
  outOfScopeCount: number
}

/** A finding's file counts as in scope when it is a declared path or sits under a declared directory. */
const isWithinScope = (canonicalFile: string, canonicalScope: readonly string[]): boolean =>
  canonicalScope.some((declared) => canonicalFile === declared || canonicalFile.startsWith(`${declared}/`))

/**
 * Annotate each finding with whether its `file` is inside the task's declared scope, using the
 * same path folding as `scripts/scope-check.mjs`. Findings are annotated, never dropped, so the
 * orchestrator can still see (and act on) a real defect the reviewer found outside the task.
 *
 * `scopeFiles` must be a non-empty list of non-empty strings: an empty scope is a caller bug
 * (the input schema rejects it), not a signal to mark everything out of scope.
 */
export const annotateScope = (
  findings: readonly ReviewFinding[],
  scopeFiles: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ScopeAnnotation => {
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array')
  if (!Array.isArray(scopeFiles) || scopeFiles.length === 0) {
    throw new TypeError('scopeFiles must be a non-empty array')
  }
  if (scopeFiles.some((file) => typeof file !== 'string' || file === '')) {
    throw new TypeError('every scopeFiles entry must be a non-empty string')
  }

  const canonicalScope = scopeFiles.map((file) => canonicalPath(file, platform))
  const annotated = findings.map((finding) => ({
    ...finding,
    inScope: isWithinScope(canonicalPath(finding.file, platform), canonicalScope),
  }))
  return {
    findings: annotated,
    outOfScopeCount: annotated.filter((finding) => !finding.inScope).length,
  }
}
