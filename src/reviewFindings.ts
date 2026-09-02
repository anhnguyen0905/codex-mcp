import { z } from 'zod'

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
  line: z.number().int().nullable().default(null),
  summary: z.string().min(1),
  expected: z.string().min(1),
  observed: z.string().min(1),
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
  /** Why `parsed` is false. */
  parseError?: string
}

export const reviewFindingsSchema = z.object({
  parsed: z.boolean(),
  findings: z.array(findingSchema),
  improvements: z.array(improvementSchema),
  dropped: z.number(),
  parseError: z.string().optional(),
})

export const REVIEW_FINDINGS_INSTRUCTIONS = [
  'After the prose, END your message with exactly one fenced ```json block of this shape (no other text after it):',
  '```json',
  '{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"path/relative/to/cwd","line":123,"summary":"one sentence","expected":"...","observed":"..."}],',
  ' "improvements":[{"id":"IMP-1","summary":"non-blocking suggestion","file":"path:line"}]}',
  '```',
  'Both "findings" and "improvements" arrays are required; use an empty array when there are no entries.',
  'Every finding must include non-empty "expected" and "observed" strings. Never invent a severity outside the four listed.',
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
  parseError,
})

const collect = <T>(items: unknown, schema: z.ZodType<T>): { kept: T[]; dropped: number } => {
  if (!Array.isArray(items)) return { kept: [], dropped: 0 }
  return items.reduce<{ kept: T[]; dropped: number }>(
    (acc, item) => {
      const result = schema.safeParse(item)
      return result.success
        ? { kept: [...acc.kept, result.data], dropped: acc.dropped }
        : { kept: acc.kept, dropped: acc.dropped + 1 }
    },
    { kept: [], dropped: 0 },
  )
}

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
  const findings = collect(record.findings, findingSchema)
  const improvements = collect(record.improvements, improvementSchema)
  return {
    parsed: true,
    findings: findings.kept,
    improvements: improvements.kept,
    dropped: findings.dropped + improvements.dropped,
  }
}
