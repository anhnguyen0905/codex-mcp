import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTEXT_DISCIPLINE_PATH = path.join(REPO_ROOT, 'skills', 'context-discipline', 'SKILL.md')
const PARALLEL_EXECUTION_PATH = path.join(REPO_ROOT, 'skills', 'parallel-execution', 'SKILL.md')
const PLAN_ARCHITECTURE_PATH = path.join(REPO_ROOT, 'skills', 'plan-architecture', 'SKILL.md')
const PLAN_BACKLOG_PATH = path.join(REPO_ROOT, 'skills', 'plan-backlog', 'SKILL.md')
const REVIEW_DUAL_PATH = path.join(REPO_ROOT, 'skills', 'review-dual', 'SKILL.md')
const PREFLIGHT_PATH = path.join(REPO_ROOT, 'skills', 'preflight', 'SKILL.md')
const SKILL_SELECTION_PATH = path.join(REPO_ROOT, 'skills', 'skill-selection', 'SKILL.md')
const EXEC_SELF_TESTING_PATH = path.join(REPO_ROOT, 'skills', 'exec-self-testing', 'SKILL.md')
const INTERVIEW_ELICITATION_PATH = path.join(
  REPO_ROOT,
  'skills',
  'interview-elicitation',
  'SKILL.md',
)
const FAST_PATH_PATH = path.join(REPO_ROOT, 'skills', 'fast-path', 'SKILL.md')
const EXECUTOR_FALLBACK_PATH = path.join(REPO_ROOT, 'skills', 'executor-fallback', 'SKILL.md')
const SESSION_REPORT_PATH = path.join(REPO_ROOT, 'skills', 'session-report', 'SKILL.md')
const SKILLS_DIR = path.join(REPO_ROOT, 'skills')
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'codex-flow.md')
const README_PATH = path.join(REPO_ROOT, 'README.md')
const CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'codex-flow.md')
const COMMAND_TOKEN_ALLOWLIST = new Set(['codex-flow:codex-flow'])
// R6.2 detector (documented, explicit): phrases that instruct a per-task full-suite run.
const FORBIDDEN_PER_TASK_SUITE_PHRASES = [
  'full suite per task',
  'full test suite per task',
  're-run the full suite',
  're-run the full test suite',
  'run the full suite mid-task',
] as const
// R6.2 detector, layer 2 (paraphrase-tolerant): a sentence that pairs any "full suite"
// wording with a per-task scope is a violation even when it uses none of the five literal
// phrases above. Documented pattern families:
//   FULL_SUITE_WORDING_PATTERN — /(full|complete|entire|whole)\s+(test\s+)?suite/i
//   PER_TASK_SCOPE_PATTERNS    — /(per|each|every)\s+task/i and /mid-task/i
// Both families must hit the same sentence, and the shared allowlist below still applies.
const FULL_SUITE_WORDING_PATTERN = /\b(?:full|complete|entire|whole)\s+(?:test\s+)?suite\b/i
const PER_TASK_SCOPE_PATTERNS = [/\b(?:per|each|every)\s+task\b/i, /\bmid-task\b/i] as const
// Allowlisted contexts for both layers: an explicit prohibition, or the two sanctioned
// full-suite runs (the merged wave-integration review and the whole-feature review).
const ALLOWED_FULL_SUITE_CONTEXT_PATTERNS = [
  /\b(?:do|does|did)\s+not\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /once per merged/i,
  /wave integration/i,
  /whole-feature review/i,
] as const
// R1.2 detector: silent-degradation wording. Any of these in the command or in a SKILL.md means
// the flow is told to keep going without the helper instead of failing closed. The `unavailable |
// unset` alternation is one documented family, not two phrases: both spellings describe the same
// standalone-install escape hatch.
const FORBIDDEN_FALLBACK_PATTERNS = [
  /edit the file directly/i,
  /standalone fallback/i,
  /(?:unavailable|unset) in a standalone install/i,
  /fall back to reading/i,
] as const
// Prohibition-aware allowlist (IMP-24: matched against the CLAUSE that carries the match, never
// the whole sentence, so a trailing "never …" cannot launder an instruction earlier in the line).
const ALLOWED_FALLBACK_CONTEXT_PATTERNS = [
  /\bnever\b/i,
  /\bno\b[^,;—]*\bfallback\b/i,
] as const
// R1.2/C9: the fail-closed sentence, verbatim.
const CANONICAL_FAIL_CLOSED_SENTENCE =
  'If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin '
  + '(its scripts/ directory is required); if it is present but exits non-zero, surface the error '
  + 'to the user and STOP. Never edit control files by hand.'
// R8.2 / C7 (as amended by the plan-drift block after T8) — per-run overhead budgets in bytes.
// Staged target, restated as per-run cost: 0.26.0 command + Phase-0 skills ≈ 58 KB (from ≈ 67 KB);
// 0.27.0 goal is ≤ 15k tokens at the phase peak. Do NOT tighten these inside 0.26.0.
const COMMAND_MAX_BYTES = 44_000
// Measured phase sets at this commit (bytes, sum of the phase's SKILL.md files):
//   Phase 0: 20 510 · Phase 1: 5 947 · Phase 2: 42 129 · Phase 3: 5 711
//   Phase 4: 23 253 (TS as the language skill) · Phase 5: 26 581
// Largest = Phase 2 (42 129) rounded up to the next 4 000 → 44 000, under the 48 000 cap.
const PHASE_SKILLS_MAX_BYTES = 44_000
// Growth guard, not a diet target: measured command + the 20 flow skills = 153 021 bytes here.
const FLOW_TOTAL_MAX_BYTES = 160_000
// C7 phase → skills map. The union of these lists is the "flow skills" set FLOW_TOTAL_MAX_BYTES
// covers; Phase 4 counts exactly one exec-<lang> skill (TypeScript, this project's language).
const PHASE_SKILL_MAP: ReadonlyArray<{ phase: string, skills: readonly string[] }> = [
  { phase: 'Phase 0', skills: ['preflight', 'fast-path', 'executor-fallback'] },
  { phase: 'Phase 1', skills: ['interview-elicitation', 'interview-ask-back'] },
  {
    phase: 'Phase 2',
    skills: [
      'plan-research-first',
      'plan-architecture',
      'skill-selection',
      'context-discipline',
      'session-report',
    ],
  },
  { phase: 'Phase 3', skills: ['plan-backlog'] },
  {
    phase: 'Phase 4',
    skills: [
      'exec-coding-standards',
      'exec-self-testing',
      'exec-typescript',
      'context-discipline',
      'parallel-execution',
    ],
  },
  {
    phase: 'Phase 5',
    skills: [
      'review-conformance',
      'review-quality',
      'review-security',
      'review-feedback',
      'review-dual',
      'context-discipline',
      'session-report',
    ],
  },
]
// R8.3: distinctive sentences T8 moved out of the command. Each must survive verbatim in exactly
// one document, so the move neither lost a rule nor left a duplicate behind.
const MOVED_PARAGRAPH_SENTENCES = [
  // skills/fast-path
  'the deliverable is an answer, report, or data readout; no tracked project\n  file is created or modified.',
  'No Codex session is\nrequired (this lane is exempt from the Codex health gate)',
  'ANY extra changed\nfile — excluding generated lockfiles — triggers the escalation rule automatically; do not review\nthe oversized diff in-lane and do not re-argue eligibility after the fact.',
  'A wrong up-front size estimate is not a failure;\nstretching the lane to avoid the restart is.',
  // skills/executor-fallback
  '**Phase 5 under fallback** — Claude must not grade its own homework alone:',
  'apply\n  the loaded `exec-coding-standards`, `exec-self-testing`, language, deliverable, and distilled\n  domain-skill blocks to your own work — they bind Claude the same way they bind Codex.',
  'Tasks completed under fallback keep their\n`claude-fallback` Session line and are never re-executed.',
] as const
const EXACT_FRONTMATTER_SKILLS = [
  'plan-architecture',
  'preflight',
  'context-discipline',
  'parallel-execution',
  'agent-context-persistence',
] as const

function readText(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Required flow document does not exist: ${filePath}`)
  }

  // Windows checkouts may materialize CRLF via git autocrlf; guards assert LF-relative offsets.
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

function extractFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) {
    throw new Error('Expected markdown to start with YAML frontmatter')
  }

  return match[1]
}

function parseFrontmatterFields(markdown: string): Array<{ key: string, value: string }> {
  return extractFrontmatter(markdown).split(/\r?\n/).map((line) => {
    const match = line.match(/^([^:]+):[ \t]*(.*)$/)
    if (!match) {
      throw new Error(`Expected a single-line frontmatter field, received: ${line}`)
    }

    return { key: match[1], value: match[2] }
  })
}

function extractFencedCodeBlockContaining(
  markdown: string,
  language: string,
  requiredText: string,
): string {
  const fencePattern = new RegExp(
    '^[ \\t]*```' + language + '[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*```[ \\t]*$',
    'gm',
  )
  const block = [...markdown.matchAll(fencePattern)]
    .map((match) => match[1])
    .find((contents) => contents.includes(requiredText))

  if (!block) {
    throw new Error(`Expected a fenced ${language} block containing: ${requiredText}`)
  }

  return block
}

function extractDecisionLogSchemaFields(markdown: string, schemaHeading: string): string[] {
  const schemaBlock = extractFencedCodeBlockContaining(markdown, 'markdown', schemaHeading)
  const lines = schemaBlock.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => line.trim() === schemaHeading)
  if (headingIndex === -1) {
    throw new Error(`Decision-log schema heading is missing: ${schemaHeading}`)
  }

  const fields: string[] = []
  for (const line of lines.slice(headingIndex + 1)) {
    const field = line.match(/^- ([^:]+):/)
    if (field) fields.push(field[1])
  }

  return fields
}

function extractPhaseSection(command: string, phaseNumber: number): string {
  const phaseHeading = new RegExp(`^## Phase ${phaseNumber}(?:[ \\t]+.*)?$`, 'm').exec(command)
  if (!phaseHeading) {
    throw new Error(`Phase ${phaseNumber} section is missing from commands/codex-flow.md`)
  }

  const phaseStart = phaseHeading.index
  const bodyStart = command.indexOf('\n', phaseStart)
  if (bodyStart === -1) {
    return command.slice(phaseStart)
  }

  const remainingCommand = command.slice(bodyStart + 1)
  const nextHeadingOffset = findUnfencedH2Offset(remainingCommand)
  const phaseEnd = nextHeadingOffset === -1 ? command.length : bodyStart + 1 + nextHeadingOffset

  return command.slice(phaseStart, phaseEnd)
}

function findUnfencedH2Offset(markdown: string): number {
  let insideFence = false
  let offset = 0
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) insideFence = !insideFence
    else if (!insideFence && /^## /.test(line)) return offset
    offset += line.length + 1
  }
  return -1
}

function extractLoadSkillsText(phaseSection: string, phaseNumber: number): string {
  const match = phaseSection.match(/^\*\*Load skills? first(?: \(code tasks\))?\*\*:[\s\S]*?(?=\r?\n\r?\n)/m)
  if (!match) {
    throw new Error(`Phase ${phaseNumber} load-skills text is missing from commands/codex-flow.md`)
  }

  return match[0]
}

function extractNumberedStep(phaseSection: string, stepNumber: number): string {
  const stepHeading = new RegExp(`^${stepNumber}\\.[ \\t]`, 'm').exec(phaseSection)
  if (!stepHeading) {
    throw new Error(`Step ${stepNumber} is missing from phase section`)
  }

  const remainingSection = phaseSection.slice(stepHeading.index + stepHeading[0].length)
  const nextStepOffset = remainingSection.search(new RegExp(`^${stepNumber + 1}\\.[ \\t]`, 'm'))
  const stepEnd = nextStepOffset === -1
    ? phaseSection.length
    : stepHeading.index + stepHeading[0].length + nextStepOffset

  return phaseSection.slice(stepHeading.index, stepEnd)
}

function extractParameterBullet(phaseSection: string, parameter: string): string {
  const bulletStart = new RegExp('^[ \\t]*- `' + parameter + '`:[ \\t]*', 'm').exec(phaseSection)
  if (!bulletStart) {
    throw new Error(`Parameter bullet is missing from phase section: ${parameter}`)
  }

  const remainingSection = phaseSection.slice(bulletStart.index + bulletStart[0].length)
  const nextBulletOffset = remainingSection.search(/^[ \t]*- `[^`]+`:/m)
  const bulletEnd = nextBulletOffset === -1
    ? phaseSection.length
    : bulletStart.index + bulletStart[0].length + nextBulletOffset

  return phaseSection.slice(bulletStart.index, bulletEnd)
}

// IMP-14: discover `skills/**/SKILL.md` at any depth so a nested skill cannot dodge the guards.
function collectSkillDocuments(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    throw new Error(`Skills directory does not exist: ${rootDir}`)
  }

  const entries = readdirSync(rootDir, { withFileTypes: true })
  const nested = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => collectSkillDocuments(path.join(rootDir, entry.name)))
  const here = entries
    .filter((entry) => entry.isFile() && entry.name === 'SKILL.md')
    .map((entry) => path.join(rootDir, entry.name))

  return [...here, ...nested].sort()
}

function skillDocumentPaths(): string[] {
  return collectSkillDocuments(SKILLS_DIR)
}

function collectWrittenTaskStages(markdown: string): string[] {
  const stages = [
    ...markdown.matchAll(/flow-state\.mjs"?[ \t]+set[ \t]+taskStage[ \t]+([a-z-]+)/g),
  ].map((match) => match[1])

  return [...new Set(stages)].sort()
}

function extractPreflightResumeRouting(preflight: string): string {
  const start = preflight.indexOf('## Step 2')
  const end = preflight.indexOf('## Step 3', start)
  if (start === -1 || end === -1) {
    throw new Error('Preflight Step 2 resume routing section is missing')
  }

  return preflight.slice(start, end).replace(/\s+/g, ' ')
}

function collectRoutedTaskStages(routingText: string): string[] {
  const routed = [...routingText.matchAll(/`([a-z-]+)`(?: or `([a-z-]+)`)? →/g)]
    .flatMap((match) => [match[1], match[2]])
    .filter((stage): stage is string => Boolean(stage))

  return [...new Set(routed)].sort()
}

function findUnroutedTaskStages(markdown: string, routingText: string): string[] {
  const routed = new Set(collectRoutedTaskStages(routingText))

  return collectWrittenTaskStages(markdown).filter((stage) => !routed.has(stage))
}

// IMP-23: `!` and `?` end a sentence too, so a violation phrased as an exclamation or a question
// can no longer hide inside its neighbour's allowlisted context.
function collectSentences(markdown: string): string[] {
  return markdown
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;:!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

// IMP-24: split a sentence into clauses so an allowlisted context only excuses the clause it sits
// in. "Run the full suite per task, but never on a dirty tree" must still be a violation.
function collectClauses(sentence: string): string[] {
  return sentence
    .split(/[,;—]|\s+(?:but|however|though|although|except)\s+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
}

function findClauseContaining(sentence: string, predicate: (clause: string) => boolean): string {
  return collectClauses(sentence).find(predicate) ?? sentence
}

function isAllowedFullSuiteClause(clause: string): boolean {
  return ALLOWED_FULL_SUITE_CONTEXT_PATTERNS.some((pattern) => pattern.test(clause))
}

function findPerTaskFullSuiteInstructions(label: string, markdown: string): string[] {
  const violations: string[] = []
  for (const sentence of collectSentences(markdown)) {
    const lowered = sentence.toLowerCase()
    const phrase = FORBIDDEN_PER_TASK_SUITE_PHRASES.find((candidate) => lowered.includes(candidate))
    if (phrase) {
      const clause = findClauseContaining(sentence, (candidate) =>
        candidate.toLowerCase().includes(phrase))
      if (isAllowedFullSuiteClause(clause)) continue
      violations.push(`${label}: matched "${phrase}" in "${clause}"`)
      continue
    }

    if (!FULL_SUITE_WORDING_PATTERN.test(sentence)) continue
    const scope = PER_TASK_SCOPE_PATTERNS.find((pattern) => pattern.test(sentence))
    if (!scope) continue
    const clause = findClauseContaining(sentence, (candidate) =>
      FULL_SUITE_WORDING_PATTERN.test(candidate))
    if (isAllowedFullSuiteClause(clause)) continue
    violations.push(
      `${label}: matched /${FULL_SUITE_WORDING_PATTERN.source}/ + /${scope.source}/ in "${clause}"`,
    )
  }

  return violations
}

// R1.2: prohibition-aware silent-degradation guard. The allowlist is clause-scoped (IMP-24).
function findFallbackWordingViolations(label: string, markdown: string): string[] {
  const violations: string[] = []
  for (const sentence of collectSentences(markdown)) {
    for (const pattern of FORBIDDEN_FALLBACK_PATTERNS) {
      if (!pattern.test(sentence)) continue
      const clause = findClauseContaining(sentence, (candidate) => pattern.test(candidate))
      if (ALLOWED_FALLBACK_CONTEXT_PATTERNS.some((allowed) => allowed.test(clause))) continue
      violations.push(`${label}: matched /${pattern.source}/ in "${clause}"`)
    }
  }

  return violations
}

describe('skill frontmatter contracts', () => {
  test.each(EXACT_FRONTMATTER_SKILLS)(
    '%s declares only non-empty unquoted name and description fields in order',
    (skillName) => {
      const skill = readText(path.join(REPO_ROOT, 'skills', skillName, 'SKILL.md'))

      const fields = parseFrontmatterFields(skill)

      expect(fields.map(({ key }) => key)).toEqual(['name', 'description'])
      expect(fields[0].value).toBe(skillName)
      expect(fields.every(({ value }) => value.trim().length > 0)).toBe(true)
      expect(fields.every(({ value }) => !/^["']/.test(value.trim()))).toBe(true)
    },
  )
})

describe('exec-self-testing targeted-testing rules', () => {
  test('keeps every targeted-testing safeguard in execution prompts', () => {
    // Arrange
    const skill = readText(EXEC_SELF_TESTING_PATH)

    // Act
    const requiredRules = [
      'While iterating',
      'Do NOT run the full test suite',
      'single authoritative acceptance run',
      'EMFILE',
      'more than two minutes',
    ]

    // Assert
    for (const rule of requiredRules) expect(skill).toContain(rule)
  })
})

describe('context-discipline skill documentation', () => {
  test('exists at the documented skill path', () => {
    const skillExists = existsSync(CONTEXT_DISCIPLINE_PATH)

    expect(skillExists).toBe(true)
  })

  test('declares name and description fields in YAML frontmatter', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    const frontmatter = extractFrontmatter(skill)

    expect(frontmatter).toMatch(/^name:\s*context-discipline\s*$/m)
    expect(frontmatter).toMatch(/^description:\s*\S.+$/m)
  })

  test('documents the B1 threshold and the B3 no-mid-task rule', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    expect(skill).toMatch(/(?<![0-9])400(?![0-9])/)
    expect(skill).toContain('NEVER compact mid-task')
    expect(skill).toMatch(/Tell the user this is a\s+safe compaction point and suggest running `\/compact`/)
  })

  test('includes the tiered AGENTS.md section and guidance', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)
    const agentsReferences = skill.match(/AGENTS\.md/g) ?? []

    expect(skill).toMatch(/^## .*AGENTS\.md.*$/m)
    expect(agentsReferences.length).toBeGreaterThanOrEqual(3)
  })

  test('defines budgeted generated slices in a Tiered read-back section', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    expect(skill).toMatch(/^## Tiered read-back$/m)
    expect(skill).toMatch(/CONTEXT-T<n>\.md` \(≤ 4000 estimated tokens using the chars\/4 heuristic\)/)
    expect(skill).toMatch(/RESUME\.md` \(≤ 8000 estimated tokens using the chars\/4 heuristic\)/)
    expect(skill).toContain("slice's omitted-pointer line")
    // T9 retarget: the standalone-fallback wording is forbidden by R1.2; the slice helper now
    // fails closed with the canonical C9 sentence instead.
    expect(skill).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(skill).toContain('the\n  generated slice is never optional')
    expect(skill).toContain('generation anchor')
    expect(skill).toContain('`[verify]`-stamped')
  })

  test('requires run-position recitation at phase and execution boundaries', () => {
    const skill = readText(CONTEXT_DISCIPLINE_PATH)

    expect(skill).toMatch(/^## Recitation$/m)
    expect(skill).toContain('At every phase boundary and immediately before each `codex_execute`')
    expect(skill).toContain('the current phase, the current task ID + title, and the next pending gate')
  })
})

describe('plan-architecture Decision log schema', () => {
  test('defines all four handoff fields', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)

    expect(skill).toMatch(/^- Decision:/m)
    expect(skill).toMatch(/^- Why:/m)
    expect(skill).toMatch(/^- Constraint for later tasks:/m)
    expect(skill).toMatch(/^- Contracts touched:/m)
  })

  test('adds the git HEAD Anchor field to task and event blocks', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)
    const anchorFields = skill.match(/^- Anchor: <git HEAD sha at append time>$/gm) ?? []

    expect(anchorFields).toHaveLength(2)
    expect(skill).toContain('`git rev-parse HEAD`')
    expect(skill).toContain('`path:line` plus the enclosing symbol')
    expect(skill).toContain('never paste code')
  })

  test('defines identical ordered six-field task and event schemas', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)
    const expectedFields = [
      'Decision',
      'Why',
      'Constraint for later tasks',
      'Contracts touched',
      'Anchor',
      'Applies to',
    ]

    const taskFields = extractDecisionLogSchemaFields(skill, '### T<n> — <title>')
    const eventFields = extractDecisionLogSchemaFields(skill, '### <event> — <label>')

    expect(taskFields).toEqual(expectedFields)
    expect(eventFields).toEqual(expectedFields)
  })

  test('tells writers to scope decisions and marks run-wide constraints as all', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)

    expect(skill).toContain('Writers SHOULD fill `Applies to`; run-wide constraints use `all`.')
  })
})

describe('preflight resume protocol', () => {
  test('uses the budgeted resume slice with fail-closed and trust-but-verify guidance', () => {
    const skill = readText(PREFLIGHT_PATH)
    const normalizedSkill = skill.replace(/\s+/g, ' ')

    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume')
    expect(skill).toContain('`.codex-flow/RESUME.md`')
    // T9 retarget: the standalone fallback is gone (R1.2). The helper fails closed, and a missing
    // control file only narrows what is read.
    expect(skill).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(normalizedSkill).toContain(
      'When either file does not exist, read only the control files that exist; do not require a missing TASKS.md to resume an earlier phase.',
    )
    expect(skill).toContain('`[verify]` block as a hypothesis')
    expect(skill).toContain('`git diff`')
    expect(skill).toMatch(
      /reuse the report dir recorded under `## Session report` in PLAN\.md; create it only if\s+missing/,
    )
  })

  test('writes the fixed STATE.md run-state contract', () => {
    const skill = readText(PREFLIGHT_PATH)
    const stateBlock = extractFencedCodeBlockContaining(skill, 'markdown', '## Run state')
    const stateKeys = [...stateBlock.matchAll(/^\s*- ([A-Za-z]+):/gm)].map((match) => match[1])

    expect(stateKeys).toEqual([
      'phase',
      'requirementsApproved',
      'planApproved',
      'backlogApproved',
      'runBaselineRef',
      'resumeHead',
      'knownRed',
      'checkpointCommits',
      'executionMode',
      'dirtyBaseline',
      'executor',
      'currentTask',
      'taskStage',
      'wave',
    ])
    expect(skill).toContain('exactly one\n   `## Run state` section')
    expect(skill).toContain('The orchestrator is the only writer.')
  })

  test('keeps immutable resume baselines and requires recorded approvals', () => {
    const skill = readText(PREFLIGHT_PATH)

    expect(skill).toContain('NEVER modified on resume')
    expect(skill.replace(/\s+/g, ' ')).toContain(
      'The existence of PLAN.md/TASKS.md is NOT proof of approval.',
    )
    expect(skill).toContain('If `.codex-flow/STATE.md` exists, treat it as an interrupted run')
    expect(skill).toContain('skip only the phases whose approvals STATE.md records')
  })

  test('routes resume from STATE phase and finishes review when all tasks are done', () => {
    const skill = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain("route from STATE.md's recorded `phase`")
    expect(skill).toContain('For `phase: execution`, enter Phase 4 at the first task not marked done.')
    expect(skill).toContain('For `phase: review`, resume Phase 5 completion work')
    expect(skill).toContain("when all tasks are done but `phase` is not `complete`, also resume Phase 5")
    expect(skill).toContain('final dual review, requirement ID-walk, improvement gate, cost/report delivery gates')
  })

  test('records a dirty run-start manifest and its immutable STATE.md key', () => {
    const skill = readText(PREFLIGHT_PATH)

    expect(skill).toContain('`.codex-flow/baseline-dirty.patch`')
    expect(skill).toContain('`git diff HEAD`')
    expect(skill).toContain('`# Untracked at run start`')
    expect(skill).toContain('each untracked path from `git status --porcelain`')
    expect(skill).toContain('- dirtyBaseline: <none | baseline-dirty.patch>')
  })

  test('reconciles orphaned in-progress tasks before scheduling', () => {
    const skill = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('Before scheduling anything, reconcile every task whose Status is `in-progress`.')
    expect(skill).toContain('`git log --oneline <base sha>..HEAD`')
    expect(skill).toContain('`git status`')
    expect(skill).toContain("changes to the task's declared `Files:` since that base")
    expect(skill).toContain('`- Session: launching (base: <short sha>)`')
    expect(skill).toContain('Extract the base sha from either launching form or the completed-session form')
    expect(skill).toContain('Session content for every in-progress task')
    expect(skill).toContain('embeds the full task text only for the first unfinished task')
    expect(skill).toContain(
      '**continue in the recorded session (when a real session id exists) / review the work as-is / reset to pending**',
    )
    expect(skill).toContain('roll back through the checkpoint commit when `checkpointCommits` is enabled')
    expect(skill).toContain('Never blindly re-execute an in-progress task.')
  })
})

describe('plan-backlog task lineage contract', () => {
  test('places the empty Session field between Acceptance and pending Status', () => {
    const skill = readText(PLAN_BACKLOG_PATH)
    const taskTemplate = extractFencedCodeBlockContaining(skill, 'markdown', '## T1:')

    expect(taskTemplate).toMatch(
      /- Acceptance: <[^\n]+>; satisfies A<n>\[, A<n>\]\r?\n- Session: —\r?\n- Status: pending/,
    )
    expect(skill).toContain(
      '`Session` and the transition log beneath `Status` are execution-time fields that the orchestrator',
    )
    expect(skill).toContain('The backlog always writes `- Session: —` and `- Status: pending`')
  })
})

describe('interview requirements protocol', () => {
  test('writes the confirmed summary to REQUIREMENTS.md with atomic criterion IDs', () => {
    const skill = readText(INTERVIEW_ELICITATION_PATH)

    expect(skill).toContain(
      'write it VERBATIM to\n`.codex-flow/REQUIREMENTS.md`',
    )
    expect(skill).toContain('## R<n>: <title>')
    expect(skill).toContain('- R<n>.<m>: <clause>')
  })

  test('defines the append-only mid-run delta format', () => {
    const skill = readText(INTERVIEW_ELICITATION_PATH)

    expect(skill).toMatch(/^## Changing requirements mid-run$/m)
    expect(skill).toContain('## Deltas')
    expect(skill).toContain('### <ISO date> <ADDED|MODIFIED|REMOVED> R<n>[.<m>]')
  })

  test('invalidates downstream approvals and requires replanning after a confirmed delta', () => {
    const skill = readText(INTERVIEW_ELICITATION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('refreshes `requirementsApproved` in `.codex-flow/STATE.md` to `yes (delta <ISO date>)`')
    expect(skill).toContain('reset `planApproved` and `backlogApproved` to `no (delta <ISO date>)`')
    expect(skill).toContain('re-run Phase 2 impact analysis')
    expect(skill).toContain('obtain backlog re-approval')
    expect(skill).toContain('requirements-coverage.mjs')
  })
})

describe('plan-backlog slice sizing recovery', () => {
  test('splits mandatory-over-budget tasks instead of raising the slice budget', () => {
    const skill = readText(PLAN_BACKLOG_PATH)

    expect(skill).toContain('mandatory slice content exceeds tokenBudget')
    expect(skill).toMatch(/split the oversized task in the backlog; never\s+raise the slice budget/)
  })
})

describe('plan-backlog requirements traceability', () => {
  test('adds the Requirements field immediately after Files in the task template', () => {
    // Arrange
    const skill = readText(PLAN_BACKLOG_PATH)

    // Act
    const taskTemplate = extractFencedCodeBlockContaining(skill, 'markdown', '## T1:')

    // Assert
    expect(taskTemplate).toContain('- Files: <create/modify list>\n- Requirements: <R-IDs covered>')
  })

  test('runs the coverage lint and requires a clean backlog before approval', () => {
    // Arrange
    const skill = readText(PLAN_BACKLOG_PATH)

    // Act
    const normalizedSkill = skill.replace(/\s+/g, ' ')

    // Assert
    expect(skill).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md',
    )
    expect(normalizedSkill).toContain(
      'Every effective R<n>.<m> must be cited by at least one task and no task may cite an unknown ID; fix the backlog before presenting it for approval.',
    )
  })

  test('re-runs sanity checks for amended and improvement backlogs', () => {
    const skill = readText(PLAN_BACKLOG_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain(
      'Re-run every check below after a plan change updates affected tasks or the improvement gate appends tasks',
    )
    expect(skill).toContain('do not schedule the changed backlog until all checks pass')
  })
})

describe('review-dual context discipline', () => {
  test('reviews the task slice first and verifies stamped hypotheses against code', () => {
    const skill = readText(REVIEW_DUAL_PATH)

    expect(skill).toContain(
      "Conformance to the task's .codex-flow/CONTEXT-T<n>.md slice and acceptance criteria.",
    )
    expect(skill).toContain(
      'Treat [verify]-stamped context as hypotheses to re-confirm against the current code before relying on it.',
    )
    expect(skill).toContain(
      'Read full .codex-flow/PLAN.md only as escalation when a finding disputes plan intent.',
    )
  })
})

describe('parallel-execution worktree branch points', () => {
  test('makes the coordinator sole writer for every control file', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain(
      'The coordinator is the SOLE writer for every `.codex-flow/*` file, including TASKS.md, PLAN.md, STATE.md, REQUIREMENTS.md, report directories, IMPROVEMENTS.md, and notes.',
    )
    expect(skill).toContain(
      'Worktree subagents treat those durable control-file copies as read-only inputs.',
    )
    expect(skill).toContain(
      'They may regenerate derived context slices inside their own worktree copies only; every durable update flows through the structured handoff to the coordinator.',
    )
  })

  test('branches Wave 1 from the current integration branch HEAD', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH)

    expect(skill).toMatch(/\*\*Wave 1\*\*: branch from the CURRENT integration branch HEAD/)
  })

  test('generates and copies each task context slice into its worktree', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH)

    expect(skill).toContain('context-slice.mjs" --task T<n>')
    expect(skill).toContain('.codex-flow/CONTEXT-T<n>.md')
    expect(skill).toContain('cp .codex-flow/SKILLS-T<n>.md "<worktree>/.codex-flow/"')
  })

  test('generates the task slice before copying all control files into the worktree', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH)
    const sliceCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>'

    const copyBlock = extractFencedCodeBlockContaining(skill, 'bash', 'cp ')
    const copyCommand = copyBlock.split(/\r?\n/).find((line) => line.trimStart().startsWith('cp '))
    const copiedControlFiles = copyCommand?.match(/\.codex-flow\/(?:PLAN\.md|TASKS\.md|CONTEXT-T<n>\.md)/g) ?? []

    expect(copyBlock.indexOf(sliceCommand)).toBeGreaterThanOrEqual(0)
    expect(copyBlock.indexOf(sliceCommand)).toBeLessThan(copyBlock.indexOf(copyCommand ?? ''))
    expect(copiedControlFiles).toEqual([
      '.codex-flow/PLAN.md',
      '.codex-flow/TASKS.md',
      '.codex-flow/CONTEXT-T<n>.md',
    ])
  })

  test('stops on helper failure and splits mandatory-over-budget tasks before copying', () => {
    // Arrange
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    // Act
    const helperFailureRule = skill.includes(
      'If the helper is present but exits non-zero, surface the error to the user and STOP; never silently copy a stale slice.',
    )
    const oversizedTaskRule = skill.includes(
      'If generation reports `mandatory slice content exceeds tokenBudget`, split the oversized task in the backlog and recompute the waves before continuing; never raise the slice budget.',
    )

    // Assert
    expect(helperFailureRule).toBe(true)
    expect(oversizedTaskRule).toBe(true)
  })

  test('requires a complete structured handoff and serial coordinator updates', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain(
      'task id; sessionId; actual files changed; checks run with results; review findings and resolutions; a proposed Decision-log block; and proposed improvement entries.',
    )
    expect(skill).toContain('IMMEDIATELY when each handoff arrives, before any merge or wave integration review')
    expect(skill).toContain("replaces that task's `launching` Session line with its real sessionId")
    expect(skill).toContain('serially applies the remaining structured handoffs')
    expect(skill).toContain('Serial IMP-id allocation prevents duplicate ids.')
  })

  test('runs Phase 4 and 5 mechanics without subagent control-file writes', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('run the **Phase 4 execution mechanics** for its ONE task')
    expect(skill).toContain('runs the **Phase 5 review mechanics** (conformance → quality → security)')
    expect(skill).toContain('no TASKS.md, STATE.md, report, ledger, or Decision-log writes')
    expect(skill).toContain('all durable updates flow through this handoff to the coordinator')
    expect(skill).not.toContain('run the **normal Phase 4 execution** for its ONE task')
    expect(skill).not.toContain('runs its own **Phase 5 review**')
  })

  test('records every parallel task base and in-progress transition at dispatch time', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain(
      'At dispatch time, before launching the batch, the coordinator marks every wave task `in-progress`',
    )
    expect(skill).toContain('appends its pending-to-in-progress transition')
    expect(skill).toContain(
      '`- Session: launching (base: <short sha>, worktree: <path>, branch: <name>)` using that worktree\'s branch-point base sha, path, and branch',
    )
  })

  test('stops the wave on undeclared files and requires backlog re-approval', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain(
      "Before merging each worktree, the coordinator diffs the worktree's actual changed files against the task's declared `Files:`.",
    )
    expect(skill).toContain(
      'Any expansion — a changed file outside that declaration, excluding generated lockfiles explicitly listed as shared — stops the wave.',
    )
    const invalidationIndex = skill.indexOf('`backlogApproved: no (files expansion <ISO date>)`')
    const filesUpdateIndex = skill.indexOf("update the task's `Files:` in TASKS.md")
    const restorationIndex = skill.indexOf('restore `backlogApproved: yes (<ISO 8601 timestamp>)`')
    const expandedReviewIndex = skill.indexOf("RE-RUN the task's conformance → quality → security review over the EXPANDED `Files:` scope")

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(filesUpdateIndex)
    expect(restorationIndex).toBeGreaterThan(filesUpdateIndex)
    expect(expandedReviewIndex).toBeGreaterThan(restorationIndex)
    expect(skill).toContain('`phase: backlog` in STATE.md')
    expect(skill).toContain('return `phase` to `execution`')
    expect(skill).toContain('using a fresh `codex_review` or a Claude pass, before the branch may merge')
    expect(skill).toContain(
      'The security review is mandatory when the expansion touches auth, input, queries, files, or secrets.',
    )
  })
})

describe('sufficiency check and brief-grounded authoring contract', () => {
  test('requires loaded-skill sufficiency checks and brief-grounded skill authoring', () => {
    const skill = readText(SKILL_SELECTION_PATH)
    const step7dStart = skill.indexOf('**7d — Nothing to adopt? Author the skill NOW, before execution.**')
    const step7eStart = skill.indexOf('**7e — Bound the effort, and be honest about what you produced.**')
    const step8Start = skill.indexOf('## Step 8 — Register back (retro, after final review)')
    const step7d = skill.slice(step7dStart, step7eStart)
    const step7dToStep8 = skill.slice(step7dStart, step8Start).replace(/\s+/g, ' ')
    const normalizedStep7d = step7d.replace(/\s+/g, ' ')

    expect(skill).toMatch(/^### Step 5 sufficiency check — loaded is not the same as covered$/m)
    expect(skill).toContain('INSUFFICIENT → AUTHOR')
    expect(step7dStart).toBeGreaterThanOrEqual(0)
    expect(step7eStart).toBeGreaterThan(step7dStart)
    expect(step8Start).toBeGreaterThan(step7eStart)
    expect(step7d).toContain('scripts/skill-brief.mjs')
    expect(normalizedStep7d).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>',
    )
    expect(step7d).toContain('SKILL-BRIEF-')
    expect(normalizedStep7d).toContain('must cite the R-IDs it serves')
    expect(step7dToStep8).toContain('scripts/skill-lint.mjs')
    expect(step7dToStep8).toContain('one batched AskUserQuestion')
    expect(normalizedStep7d).toContain('brief → author → lint → one batched approval')
    expect(normalizedStep7d).toContain('quarantine/authored')
  })

  test('wires loaded-but-insufficient authoring into Phase 2 step 2', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 2)
    const step = extractNumberedStep(phaseSection, 2).replace(/\s+/g, ' ')

    expect(step).toContain('INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)')
    expect(step).toContain('skill-brief.mjs')
    expect(step).toContain('skill-lint.mjs')
    expect(step).toContain('one batched AskUserQuestion')
    expect(step).toContain('loaded-but-insufficient is never a silent pass')
    expect(step).toContain('quarantine/authored')
    // T9 retarget: the literal CLI invocation and the short-form order live in the skill T8
    // routes Phase 2 to, not in the command.
    const skillSelection = readText(SKILL_SELECTION_PATH)
    expect(skillSelection).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>',
    )
    expect(skillSelection).toContain('brief → author → lint → one batched approval')
  })

  test('requires brief-first authoring before Phase 3 execution', () => {
    const command = readText(COMMAND_PATH)
    const phaseStart = command.indexOf('## Phase 3 — Backlog (Claude)')
    const phaseEnd = command.indexOf('## Phase 4 — Execution (Codex)')
    const phaseSection = extractPhaseSection(command, 3).replace(/\s+/g, ' ')

    expect(phaseStart).toBeGreaterThanOrEqual(0)
    expect(phaseEnd).toBeGreaterThan(phaseStart)
    // T9 retarget: Phase 3 no longer restates the authoring procedure; it routes a backlog-time
    // gap through the same Step 7 order, and the skill owns that order.
    expect(phaseSection).toContain('INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)')
    expect(phaseSection).toContain(
      'its skill is created through the same `codex-flow:skill-selection` Step 7 procedure Phase 2 uses, in that same fixed order, before the task may enter Phase 4',
    )
    const skillSelection = readText(SKILL_SELECTION_PATH).replace(/\s+/g, ' ')
    expect(skillSelection).toContain('skill-brief.mjs')
    expect(skillSelection).toContain('skill-lint.mjs')
    expect(skillSelection).toContain('one batched AskUserQuestion')
    expect(skillSelection).toContain('brief → author → lint → one batched approval')
    expect(skillSelection).toContain('quarantine/authored')
  })
})

function extractFastPathSection(command: string): string {
  const start = command.indexOf('## Fast-path gate')
  const end = command.indexOf('## Phase 1', start)
  if (start === -1 || end === -1) {
    throw new Error('Fast-path gate section is missing from commands/codex-flow.md')
  }

  return command.slice(start, end)
}

// T9 retarget: T8 moved the gate's content into skills/fast-path/SKILL.md; the command keeps only
// the router. Content assertions read the skill, and one test guards the router itself.
describe('fast-path gate contract', () => {
  test('the command routes the gate to the fast-path skill at the right point', () => {
    const section = extractFastPathSection(readText(COMMAND_PATH)).replace(/\s+/g, ' ')

    expect(section).toContain('**Load skill**: `codex-flow:fast-path`')
    expect(section).toContain(
      'after the resume check, before the `codex_health` call and before any control file is written',
    )
  })

  test('defines both lanes with exclusions and a full-flow escalation', () => {
    const section = readText(FAST_PATH_PATH)

    expect(section).toContain('**Analysis lane**')
    expect(section).toContain('**Small-change lane**')
    expect(section).toContain('security-sensitive')
    expect(section).toContain('restart at Phase 1 with the full flow')
    expect(section).toContain('Never stretch a lane')
  })

  test('exempts the analysis lane from the Codex health gate', () => {
    const command = readText(COMMAND_PATH)
    const phaseZero = extractPhaseSection(command, 0).replace(/\s+/g, ' ')
    const section = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')

    expect(phaseZero).toContain(
      'The **analysis lane** of the Fast-path gate never reaches this gate: it needs no Codex session and no fallback decision, so a failed health check or missing login does NOT block it.',
    )
    expect(section).toContain('this lane is exempt from the Codex health gate')
    expect(phaseZero).toContain(
      'the small-change lane and the full flow require either `loggedIn: true` or an explicit Executor-fallback choice',
    )
  })

  test('enforces a mechanical scope trip-wire on the small-change lane', () => {
    const section = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')

    expect(section).toContain('**Scope trip-wire (mechanical, not judgment)**')
    expect(section).toContain('ANY extra changed file — excluding generated lockfiles — triggers the escalation rule automatically')
    expect(section).toContain('do not review the oversized diff in-lane')
  })

  test('gives the small-change lane its own known-red baseline', () => {
    const section = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')

    expect(section).toContain(
      "first run the project's test command once and note any pre-existing failures as the lane's known-red list",
    )
    expect(section).toContain('only failures NOT on that list count against the change')
  })

  test('logs every fast-path run to the durable fastpath log', () => {
    const section = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')

    expect(section).toContain('`.codex-flow/notes/fastpath.log`')
    expect(section).toContain('session=<sessionId or ->')
    expect(section).toContain('outcome=<delivered|done|escalated|failed>')
    expect(section).toContain('so write it even on escalation or failure')
  })

  test('skips control files and baseline steps 2-5 in Phase 0 for fast-path runs', () => {
    const phaseZero = extractPhaseSection(readText(COMMAND_PATH), 0).replace(/\s+/g, ' ')

    expect(phaseZero).toContain('evaluate the **Fast-path gate** (section below)')
    expect(phaseZero).toContain('skip steps 2–5')
    expect(phaseZero).toContain('a fast-path run writes no `.codex-flow/` control files')
  })
})

describe('data processing tooling rules', () => {
  test('Phase 4 routes large-data work to the Data tooling block regardless of repo language', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4).replace(/\s+/g, ' ')

    expect(phaseSection).toContain('**Data processing tooling**')
    expect(phaseSection).toContain('measure with `du -h` first, never guess sizes')
    expect(phaseSection).toContain('Data tooling block from `codex-flow:exec-deliverable`')
    expect(phaseSection).toContain('never let Codex write row-by-row scan scripts over large raw files')
  })

  test('exec-deliverable carries the embeddable data tooling rules', () => {
    const skill = readText(path.join(REPO_ROOT, 'skills', 'exec-deliverable', 'SKILL.md'))
      .replace(/\s+/g, ' ')

    expect(skill).toContain('## Data tooling block')
    expect(skill).toContain('Measure before choosing: run `du -h` on the inputs')
    expect(skill).toContain('Ingest once, query many')
    expect(skill).toContain('Never write row-by-row scan scripts')
    expect(skill).toContain('Sample-first iteration')
    expect(skill).toContain('One pass, many outputs')
    expect(skill).toContain('Keep heavy I/O local')
  })
})

describe('codex-flow command structure', () => {
  test.each([2, 4, 5])('names context-discipline in the Phase %i load list', (phaseNumber) => {
    const command = readText(COMMAND_PATH)
    const phaseSection = extractPhaseSection(command, phaseNumber)

    const loadSkillsText = extractLoadSkillsText(phaseSection, phaseNumber)

    expect(loadSkillsText).toMatch(/codex-flow:context-discipline(?![a-z0-9-])/)
  })

  test('keeps the Claude command mirror byte-identical', () => {
    const command = readFileSync(COMMAND_PATH)
    const claudeCommand = readFileSync(CLAUDE_COMMAND_PATH)

    const commandsAreIdentical = command.equals(claudeCommand)

    expect(commandsAreIdentical).toBe(true)
  })

  test('resolves every referenced skill token to an existing SKILL.md', () => {
    const command = readText(COMMAND_PATH)
    const referencedTokens = [...new Set(command.match(/codex-flow:[a-z0-9-]+/g) ?? [])]
    const referencedTokenCandidates = [
      ...new Set(command.match(/codex-flow:[A-Za-z0-9-]+/g) ?? []),
    ]

    const malformedTokens = referencedTokenCandidates.filter(
      (token) => !/^codex-flow:[a-z0-9-]+$/.test(token),
    )
    const missingSkills = referencedTokens
      .filter((token) => !COMMAND_TOKEN_ALLOWLIST.has(token))
      .map((token) => token.slice('codex-flow:'.length))
      .filter((skillName) => !existsSync(path.join(REPO_ROOT, 'skills', skillName, 'SKILL.md')))

    expect(malformedTokens).toEqual([])
    expect(missingSkills).toEqual([])
  })

  test('generates and reads the resume slice in Phase 0 and fails closed on the helper', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 0)
    const normalizedPhase = phaseSection.replace(/\s+/g, ' ')

    expect(phaseSection).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume',
    )
    expect(phaseSection).toContain('`.codex-flow/RESUME.md`')
    // T9 retarget: R1.2 forbids the raw-file fallback; a missing control file only narrows the read
    // and the helper itself fails closed.
    expect(normalizedPhase).toContain(
      'when either file is missing, read only the control files that exist',
    )
    expect(phaseSection).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(phaseSection).toContain('if `.codex-flow/STATE.md` exists')
    expect(normalizedPhase).toContain('even when PLAN.md or TASKS.md has not been created yet')
    expect(phaseSection).toContain('skip only phases whose approvals STATE.md records')
    expect(normalizedPhase).not.toContain('skip Phases 1–3')
    expect(normalizedPhase).toContain(
      'on resume, reuse the report dir recorded under `## Session report` in the existing PLAN.md',
    )
    // T9 retarget: the per-`phase` resume routing is stated once, in preflight Step 2.
    const preflight = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')
    expect(preflight).toContain(
      'For `phase: review`, resume Phase 5 completion work; when all tasks are done but `phase` is not `complete`, also resume Phase 5',
    )
    expect(preflight).toContain(
      'final dual review, requirement ID-walk, improvement gate, cost/report delivery gates, and completion write',
    )
  })

  test('writes REQUIREMENTS.md in Phase 1 before Phase 2 starts', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 1)

    expect(phaseSection).toContain(
      'write the confirmed Requirements Summary VERBATIM to\n`.codex-flow/REQUIREMENTS.md`',
    )
    expect(phaseSection).toContain('Do not start\nPhase 2 until the write completes.')
  })

  test.each([
    [1, 'requirementsApproved', 'plan'],
    [2, 'planApproved', 'backlog'],
    [3, 'backlogApproved', 'execution'],
  ])('records Phase %i approval and advances run state', (phaseNumber, approvalKey, nextPhase) => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), phaseNumber)

    expect(phaseSection).toContain('`.codex-flow/STATE.md`')
    expect(phaseSection).toContain(`\`${approvalKey}\``)
    expect(phaseSection).toContain('`yes (<ISO 8601 timestamp>)`')
    expect(phaseSection).toContain(`\`phase\` to \`${nextPhase}\``)
  })

  test('requires Phase 2 acceptance criteria to cite covered requirement IDs', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 2)

    expect(phaseSection).toContain('Every entry must cite the R-IDs it covers')
    expect(phaseSection).toContain('- A3 (covers R2.1, R2.2): ...')
  })

  test('records Phase 2 approval only after post-approval artifacts are durable', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 2)
    const agentsIndex = phaseSection.indexOf('5. After approval, generate/update tiered AGENTS.md')
    const reportIndex = phaseSection.indexOf('6. After approval, write `planning.md`')
    const stateIndex = phaseSection.indexOf('7. Only after steps 5 and 6 complete')

    expect(agentsIndex).toBeGreaterThanOrEqual(0)
    expect(reportIndex).toBeGreaterThan(agentsIndex)
    expect(stateIndex).toBeGreaterThan(reportIndex)
    expect(phaseSection).toContain('do not update STATE.md yet')
    expect(phaseSection).toContain('Never persist Phase 2 approval before its post-approval artifacts are durable.')
  })

  test('resets downstream approvals when a requirement delta is confirmed', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 1).replace(/\s+/g, ' ')

    expect(phaseSection).toContain('refresh `requirementsApproved` to `yes (delta <ISO date>)`')
    expect(phaseSection).toContain('reset `planApproved` and `backlogApproved` to `no (delta <ISO date>)`')
    expect(phaseSection).toContain('re-run Phase 2 impact analysis and plan approval')
    expect(phaseSection).toContain('obtain backlog re-approval')
    expect(phaseSection).toContain('requirements-coverage.mjs')
  })

  test('runs the Phase 3 coverage lint before requesting backlog approval', () => {
    // Arrange
    const command = readText(COMMAND_PATH)
    const lintCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md'

    // Act
    const phaseStart = command.indexOf('## Phase 3 — Backlog (Claude)')
    const phaseEnd = command.indexOf('## Phase 4 — Execution (Codex)')
    const lintIndex = command.indexOf(lintCommand, phaseStart)
    const approvalIndex = command.indexOf('Show the backlog to the user and get approval', phaseStart)

    // Assert
    expect(phaseStart).toBeGreaterThanOrEqual(0)
    expect(lintIndex).toBeGreaterThanOrEqual(0)
    expect(lintIndex).toBeLessThan(approvalIndex)
    expect(lintIndex).toBeLessThan(phaseEnd)
    // T9 retarget: the bespoke Phase 3 helper-failure sentence is now the canonical C9 sentence.
    expect(command.slice(phaseStart, phaseEnd)).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
  })

  test('generates a task slice before each Phase 4 execution and uses it in the prompt', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4)
    const sliceCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>'
    const promptBullet = '- `prompt`:'

    expect(phaseSection).toContain(sliceCommand)
    expect(phaseSection).toContain(promptBullet)
    expect(phaseSection.indexOf(sliceCommand)).toBeLessThan(phaseSection.indexOf(promptBullet))
    expect(phaseSection).toContain('Read .codex-flow/CONTEXT-T<n>.md for context')
    expect(phaseSection).toContain('its header records the generation anchor')
    expect(phaseSection).toContain('blocks marked [verify] must be re-checked')
    // T9 dropped: the alternate "Read .codex-flow/PLAN.md for context." opener existed only for the
    // now-forbidden standalone fallback (R1.2); the slice is mandatory and the helper fails closed.
    expect(phaseSection).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(phaseSection).toContain(
      '`Run position: phase execution — task T<n> <title> — next gate: <gate>`',
    )
  })

  test('deduplicates Phase 4 and Phase 5 skill loading within a session', () => {
    const command = readText(COMMAND_PATH)

    expect(extractLoadSkillsText(extractPhaseSection(command, 4), 4))
      .toContain('(if not already loaded this session)')
    expect(extractLoadSkillsText(extractPhaseSection(command, 5), 5))
      .toContain('(if not already loaded this session)')
  })

  test('omits duplicate task text from the generated-slice prompt', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4)

    const promptInstruction = extractParameterBullet(phaseSection, 'prompt').replace(/\s+/g, ' ')

    expect(promptInstruction).toContain(
      'do not append the full task text because the slice already embeds it as mandatory content.',
    )
    expect(promptInstruction).toMatch(
      /Then append .* \+ the standards, testing, and language blocks .* \+ a distilled ≤ 30-line rules block/,
    )
    // T9 dropped: the standalone-fallback prompt variant is forbidden by R1.2 — there is now one
    // prompt shape, built on the mandatory slice.
  })

  test('defaults to fresh task sessions and caps eligible cross-task reuse', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4).replace(/\s+/g, ' ')

    expect(phaseSection).toContain('The DEFAULT is a fresh `codex_execute` per task')
    expect(phaseSection).toContain('use `codex_continue` for review/fix rounds within the same task')
    expect(phaseSection).toContain(
      'only when the next task directly depends on the previous task AND stays in the same domain',
    )
    expect(phaseSection).toContain(
      'capped at that one adjacent task — after that, start fresh',
    )
    expect(phaseSection).toContain(
      "A fresh session gets the new task's distilled skill blocks instead of inheriting stale context from the previous domain.",
    )
  })

  test('runs the ordered plan-change transaction before execution resumes', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5)
    const invalidationIndex = phaseSection.indexOf('`backlogApproved: no (plan drift <ISO date>)`')
    const impactIndex = phaseSection.indexOf('impact analysis listing which done and pending tasks')
    const tasksIndex = phaseSection.indexOf('update the affected\n   TASKS.md')
    const lintIndex = phaseSection.indexOf('requirements-coverage.mjs', tasksIndex)
    const approvalIndex = phaseSection.indexOf('get backlog re-approval', lintIndex)
    const restorationIndex = phaseSection.indexOf('`backlogApproved: yes (<ISO 8601 timestamp>)`', approvalIndex)

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(impactIndex)
    expect(impactIndex).toBeGreaterThanOrEqual(0)
    expect(tasksIndex).toBeGreaterThan(impactIndex)
    expect(lintIndex).toBeGreaterThan(tasksIndex)
    expect(approvalIndex).toBeGreaterThan(lintIndex)
    expect(restorationIndex).toBeGreaterThan(approvalIndex)
    expect(phaseSection).toContain('`phase: backlog` in STATE.md')
    expect(phaseSection).toContain('return `phase` to `execution`')
    expect(phaseSection).toContain('`Steps` / `Files` / `Requirements` / `Acceptance` fields')
    expect(phaseSection).toContain('plus the `plan-backlog` backlog sanity checks')
    expect(phaseSection).toContain('regenerate affected slices → recompute waves')
    expect(phaseSection.replace(/\s+/g, ' ')).toContain(
      'Improvement tasks appended at the improvement decision gate go through the same mini-transaction',
    )
  })

  test('records Phase 4 session lineage and append-only status transitions', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4).replace(/\s+/g, ' ')

    expect(phaseSection).toContain(
      'Immediately before the call, record `git rev-parse --short HEAD` as the task\'s base sha.',
    )
    expect(phaseSection).toContain(
      'In the same durable update, set the task\'s `- Status:` line to `in-progress`, append ` - <ISO 8601 ts> pending -> in-progress` beneath it, and write `- Session: launching (base: <short sha>)`.',
    )
    expect(phaseSection).toContain(
      'when `codex_execute` returns, replace the task\'s launching Session line with `- Session: <sessionId> (cwd: <path>, base: <short sha>)`, preserving the base recorded before the call.',
    )
    expect(phaseSection).toContain('Do not mark it done here; Phase 5 step 7 makes that the last durable task write.')
    expect(phaseSection).toContain('Transition lines are append-only — never rewrite or delete earlier ones.')
  })

  test('invalidates approval before improvement tasks mutate the backlog', () => {
    const stepNine = extractNumberedStep(extractPhaseSection(readText(COMMAND_PATH), 5), 9)
    const invalidationIndex = stepNine.indexOf('`backlogApproved: no (improvement tasks <ISO date>)`')
    const appendIndex = stepNine.indexOf('approved items into new tasks appended to `.codex-flow/TASKS.md`')
    const approvalIndex = stepNine.indexOf('get backlog re-approval')
    const restorationIndex = stepNine.indexOf('restore `backlogApproved: yes (<ISO 8601 timestamp>)`')

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(appendIndex)
    expect(approvalIndex).toBeGreaterThan(appendIndex)
    expect(restorationIndex).toBeGreaterThan(approvalIndex)
    expect(stepNine).toContain('`phase: backlog` in STATE.md')
    expect(stepNine).toContain('return `phase` to\n   `execution` before scheduling the new tasks')
  })

  test('marks a sequential task done only after its durable completion handoff', () => {
    const stepSeven = extractNumberedStep(extractPhaseSection(readText(COMMAND_PATH), 5), 7)
    const decisionIndex = stepSeven.indexOf('append the Decision-log schema block')
    const taskReportIndex = stepSeven.indexOf("append this\n   task's section to the report dir's `tasks.md`")
    const reviewReportIndex = stepSeven.indexOf("append its dual-review record to `reviews.md`")
    const checkpointIndex = stepSeven.indexOf('make the checkpoint commit when enabled')
    const taskUpdateIndex = stepSeven.indexOf('update\n   TaskUpdate')
    const statusIndex = stepSeven.indexOf('set `- Status:` to `done`')

    expect(decisionIndex).toBeGreaterThanOrEqual(0)
    expect(taskReportIndex).toBeGreaterThan(decisionIndex)
    expect(reviewReportIndex).toBeGreaterThan(taskReportIndex)
    expect(checkpointIndex).toBeGreaterThan(reviewReportIndex)
    expect(taskUpdateIndex).toBeGreaterThan(checkpointIndex)
    expect(statusIndex).toBeGreaterThan(taskUpdateIndex)
    expect(stepSeven.replace(/\s+/g, ' ')).toContain('make the LAST durable task write')
    expect(stepSeven).toContain('`  - <ISO 8601 ts> in-progress -> done`')
    expect(stepSeven).not.toContain('in-progress -> done (session:')
  })

  test('falls back to a fresh fix session when the recorded implementation session is gone', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5).replace(/\s+/g, ' ')

    expect(phaseSection).toContain("route verified CRITICAL/HIGH findings from EITHER review to the task's recorded Session line via `mcp__codex__codex_continue`")
    expect(phaseSection).toContain(
      'If `codex_continue` fails because the recorded session is gone (expired or compacted), fall back to a fresh `codex_execute` fix task that embeds the finding text plus the task\'s `.codex-flow/CONTEXT-T<n>.md` slice; never hand-edit Codex\'s code.',
    )
  })

  test('re-reads the task slice in Phase 5 step 0 and restores omitted plan sections on demand', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5)
    const stepZero = extractNumberedStep(phaseSection, 0)
    const sliceCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>'

    expect(stepZero).toContain(sliceCommand)
    expect(stepZero.indexOf(sliceCommand)).toBeLessThan(stepZero.indexOf('then re-read it'))
    // T9 retarget: step 0 now names the slice through the regenerate instruction, and the
    // standalone fallback it used to describe is forbidden by R1.2.
    expect(stepZero).toContain("regenerate this task's slice")
    expect(stepZero).toContain("this task's entry in `.codex-flow/TASKS.md`")
    expect(stepZero).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(stepZero).toContain('finding disputes plan intent')
    expect(stepZero).toContain("slice's omitted-pointer line")
    expect(stepZero).toContain(
      "reuse the existing `.codex-flow/CONTEXT-T<n>.md` only when its generated header's anchor equals the current `git rev-parse HEAD` and the tree is clean; otherwise",
    )
  })

  test('uses the run-start STATE.md baseline for final review', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5).replace(/\s+/g, ' ')

    expect(phaseSection).toContain(
      'Review the baseline-to-working-tree diff with `git diff runBaselineRef` (the one-argument form), taking `runBaselineRef` from `.codex-flow/STATE.md`; never use a resume-point ref for final review.',
    )
    expect(phaseSection).toContain('Also inspect untracked files from `git status --porcelain`.')
    expect(phaseSection).toContain('When `dirtyBaseline` names `baseline-dirty.patch`, subtract the run-start hunks and untracked paths recorded in that manifest')
    expect(phaseSection).toContain('original `knownRed` list from STATE.md')
  })

  test('walks every effective requirement ID with evidence and reruns coverage in final review', () => {
    // Arrange
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5)

    // Act
    const finalReview = extractNumberedStep(phaseSection, 8).replace(/\s+/g, ' ')

    // Assert
    expect(finalReview).toContain(
      'Walk the effective REQUIREMENTS.md set ID-by-ID, reporting met/not-met with evidence (test name, file, or demonstrated behavior); any not-met ID blocks completion.',
    )
    expect(finalReview).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md',
    )
  })

  test('stops on present helper failures and splits mandatory-over-budget tasks', () => {
    const command = readText(COMMAND_PATH)
    // T9 retarget: one canonical C9 sentence replaces the old per-site helper-failure wording.
    for (const phaseNumber of [0, 4, 5]) {
      const phase = extractPhaseSection(command, phaseNumber)
      expect(phase).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    }
    expect(extractPhaseSection(command, 4).replace(/\s+/g, ' ')).toContain(
      '`mandatory slice content exceeds tokenBudget`, split the oversized task in the backlog before continuing; never raise the slice budget.',
    )
  })
})

describe('server-side acceptance verification contract', () => {
  const command = readText(COMMAND_PATH)
  const reviewConformance = readText(path.join(REPO_ROOT, 'skills', 'review-conformance', 'SKILL.md'))
  const execSelfTesting = readText(EXEC_SELF_TESTING_PATH)

  test('Phase 4 passes the task acceptance check as verifyCommand on execute and every fix round', () => {
    const phase4 = extractPhaseSection(command, 4).replace(/\s+/g, ' ')
    expect(phase4).toContain('`verifyCommand`: the task\'s exact acceptance check from its `Acceptance:` field')
    expect(phase4).toContain('Pass the same `verifyCommand` on every `codex_continue` fix round.')
  })

  test('Phase 5 reads the verification field before trusting agentMessage', () => {
    const phase5 = extractPhaseSection(command, 5).replace(/\s+/g, ' ')
    expect(phase5).toContain('Read the tool result\'s `accepted` verdict first')
    expect(phase5).toContain('Do NOT re-run the full test suite per task — `verifyCommand` is the single authoritative acceptance run')
    expect(phase5).toContain('the full suite runs once per merged parallel wave (integration review) and once in the whole-feature review (step 8)')
    expect(phase5).not.toContain('Then run the project\'s full tests/build yourself')
    expect(readText(EXEC_SELF_TESTING_PATH).replace(/\s+/g, ' ')).toContain('Claude does NOT re-run the full suite per task')
    expect(readText(path.join(REPO_ROOT, 'skills', 'review-conformance', 'SKILL.md'))).toContain('Do not re-run the suite per task')
    expect(readText(path.join(REPO_ROOT, 'skills', 'review-feedback', 'SKILL.md'))).toContain('re-run the targeted tests for the touched files')
    expect(readText(path.join(REPO_ROOT, 'skills', 'review-feedback', 'SKILL.md'))).not.toContain('re-run the full test suite')
    expect(phase5).toContain('`accepted` verdict first (`true` only when the run succeeded AND its `verification` passed')
    expect(phase5).toContain('(passing the same `verifyCommand`, see Phase 4 step 1, so acceptance re-runs mechanically)')
    expect(readText(EXEC_SELF_TESTING_PATH)).not.toContain('run the FULL test suite at most ONCE')
    expect(phase5).toContain('`passed: false` (or `skipped`) means the task is not done regardless of what `agentMessage` says')
  })

  test('review-conformance and exec-self-testing treat verification as evidence, not Codex claims', () => {
    expect(reviewConformance).toContain('`passed: false` or\n  `skipped` is an automatic unmet criterion')
    expect(execSelfTesting).toContain('pass the task\'s acceptance command as `verifyCommand`')
  })
})

describe('executor fallback contract', () => {
  const command = readText(COMMAND_PATH)
  const preflight = readText(PREFLIGHT_PATH)
  const sessionReport = readText(path.join(REPO_ROOT, 'skills', 'session-report', 'SKILL.md'))
  const sectionStart = command.indexOf('## Executor fallback')
  const sectionEnd = command.indexOf('## Phase 1 — Interview (Claude)')
  const routerSection = command.slice(sectionStart, sectionEnd).replace(/\s+/g, ' ')
  // T9 retarget: T8 moved this contract into skills/executor-fallback/SKILL.md; the command section
  // is now only the router, so the content assertions below read the skill.
  const section = readText(EXECUTOR_FALLBACK_PATH).replace(/\s+/g, ' ')

  test('Phase 0 offers the fallback instead of a hard STOP when Codex is missing or logged out', () => {
    const phase0 = command.slice(command.indexOf('## Phase 0'), command.indexOf('## Fast-path gate')).replace(/\s+/g, ' ')
    expect(sectionStart).toBeGreaterThan(0)
    expect(sectionEnd).toBeGreaterThan(sectionStart)
    expect(phase0).toContain('offer the **Executor fallback** (section below): fix Codex and re-check, or continue with Claude as executor. Never continue silently.')
    expect(phase0).toContain('either a re-check shows `loggedIn: true` or the user has explicitly chosen the fallback')
  })

  test('the switch is explicit, task-boundary only, and durably recorded', () => {
    expect(section).toContain('use AskUserQuestion exactly once per outage')
    expect(section).toContain('never switch mid-task')
    expect(section).toContain('`executor: claude (fallback: <not-logged-in | server-missing | codex-unavailable> <ISO 8601>)`')
    expect(section).toContain('`executor: codex (restored <ISO 8601>)`')
  })

  test('fallback execution keeps the slice, standards blocks, and self-run acceptance evidence', () => {
    expect(section).toContain('they bind Claude the same way they bind Codex')
    expect(section).toContain('`- Session: claude-fallback (base: <short sha>)`')
    expect(section).toContain('`- Verification: <command> → exit <code>`')
    expect(section).toContain('Parallel worktree mode is not available under fallback')
  })

  test('fallback review replaces codex_review with an independent subagent and keeps the round cap', () => {
    expect(section).toContain('Claude must not grade its own homework alone')
    expect(section).toContain('independent review by a fresh subagent')
    expect(section).toContain('keep the 3-round cap')
    expect(command).toContain('Never switch executors silently or mid-task')
  })

  test('the command section routes the fallback to its skill', () => {
    expect(routerSection).toContain('**Load skill**: `codex-flow:executor-fallback`')
    expect(routerSection).toContain('Offer the fallback from that skill whenever a trigger fires.')
  })

  test('preflight and session-report carry the executor key and fallback PIC', () => {
    expect(preflight).toContain('- executor: codex')
    expect(preflight).toContain('It changes only at a task boundary and never silently.')
    expect(sessionReport).toContain('`claude (fallback: <reason>)` as PIC values')
  })
})

describe('structured, concurrent dual review contract', () => {
  const command = readText(COMMAND_PATH)
  const reviewDual = readText(REVIEW_DUAL_PATH)
  const phase5 = extractPhaseSection(command, 5).replace(/\s+/g, ' ')

  test('Phase 5 launches codex_review in a background subagent before Claude\'s own pass', () => {
    expect(phase5).toContain('**Start the Codex-side review in the background FIRST**')
    expect(phase5).toContain('launch a background subagent (Agent tool, general-purpose)')
    expect(phase5).toContain('If the Agent tool is unavailable, call `mcp__codex__codex_review` directly at step 5 instead (sequential fallback).')
  })

  test('Phase 5 reads reviewFindings instead of re-deriving severities from prose', () => {
    expect(phase5).toContain('Read Codex\'s findings from the result\'s `reviewFindings` field')
    expect(phase5).toContain('do not re-derive severities from the prose')
    expect(phase5).toContain('when `parsed: false`, tell the user, fall back to the prose `agentMessage`')
  })

  test('review-dual carries the concurrency rule and the reviewFindings reading rule', () => {
    expect(reviewDual).toContain('## Run the two reviews concurrently')
    expect(reviewDual).toContain('never run the two\nin series')
    expect(reviewDual).toContain('## Read Codex\'s findings from `reviewFindings`, not prose')
    expect(reviewDual).toContain('Never re-grade a\n  finding\'s severity from the surrounding prose')
  })
})

describe('durable task-loop state contract (R1.2, R1.6)', () => {
  const command = readText(COMMAND_PATH)
  const preflight = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')
  const phase0 = command.slice(command.indexOf('## Phase 0'), command.indexOf('## Fast-path gate')).replace(/\s+/g, ' ')
  const phase4 = extractPhaseSection(command, 4).replace(/\s+/g, ' ')
  const phase5 = extractPhaseSection(command, 5).replace(/\s+/g, ' ')
  const helper = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs"'

  test('preflight documents the three new keys and their allowed values', () => {
    expect(preflight).toContain('`taskStage` is one of `idle | launching | executing | reviewing | handoff | merge-conflict`')
    expect(preflight).toContain('`phase` stays `execution` for the whole task loop')
    expect(preflight).toContain(`${helper} task <T-id> <status>`)
  })

  test('phase stays execution through the task loop and review is set only after the last task', () => {
    expect(phase5).toContain('`phase` stays `execution`. Sequential mode: set `taskStage` to `reviewing`')
    expect(phase5).toContain(`${helper} set taskStage reviewing`)
    expect(phase5).toContain(`${helper} set taskStage handoff`)
    expect(phase5).toContain(`${helper} task T<n> done`)
    expect(phase5).toContain('then set `taskStage idle` and `currentTask -`')
    expect(phase5).toContain(`set \`phase\` to \`review\` with \`${helper} set phase review\` (the only place \`phase: review\` is written)`)
    expect(command).not.toContain('At the Phase 4 → Phase 5 boundary, set `phase` in `.codex-flow/STATE.md` to `review`.')
  })

  test('task status writes route through the helper and fail closed', () => {
    expect(phase4).toContain(`${helper} task T<n> in-progress`)
    expect(phase4).toContain('set `currentTask T<n>` and `taskStage launching`')
    expect(phase4).toContain('once the call is dispatched, set `taskStage executing`')
    expect(phase4).toContain(`${helper} task T<n> failed`)
    expect(phase4).toContain(`${helper} set wave <n>`)
    // T9 retarget: the command now names the key count and defers the literal key list to
    // preflight Step 3.4; the "edit the file directly" escape hatch is forbidden by R1.2.
    expect(phase0).toContain('write all 14 `.codex-flow/STATE.md` keys per `codex-flow:preflight`')
    expect(phase0).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
    expect(preflight).toContain('- currentTask: - - taskStage: idle - wave: -')
  })

  test('resume routing uses currentTask and taskStage under phase execution', () => {
    expect(phase0).toContain(`Run \`${helper} check\` first — when it reports ONLY missing keys on a legacy file`)
    expect(phase0).toContain('any other violation is surfaced to the user before routing')
    expect(phase4).toContain('then set `taskStage idle` and `currentTask -`, and update TaskUpdate')
    expect(readText(PARALLEL_EXECUTION_PATH)).toContain(`${helper} set taskStage merge-conflict`)
    expect(readText(PARALLEL_EXECUTION_PATH)).toContain(`${helper} task T<n> in-progress`)
    expect(readText(PARALLEL_EXECUTION_PATH)).toContain(`${helper} task T<n> done`)
    expect(readText(PARALLEL_EXECUTION_PATH)).toContain(`${helper} set taskStage handoff`)
    // T9 retarget: `taskStage` routing is stated once, in preflight Step 2, which the command's
    // resume check routes to by name.
    expect(phase0).toContain('`codex-flow:preflight` Step 2 (resume authority, in-progress task reconciliation, `taskStage` routing, report-dir reuse)')
    expect(preflight).toContain('first route by `taskStage` regardless of `currentTask`')
    expect(phase5).toContain('Sequential mode: set `taskStage` to `reviewing`')
    expect(phase5).toContain('Parallel mode: `taskStage` stays `executing` for the whole wave')
    expect(preflight).toContain('`merge-conflict` → surface the conflict to the user and STOP')
  })
})

describe('fail-closed review acceptance routing (R1.3)', () => {
  const reviewDual = readText(REVIEW_DUAL_PATH)
  const phase5Step4 = extractNumberedStep(extractPhaseSection(readText(COMMAND_PATH), 5), 4)
    .replace(/\s+/g, ' ')

  test('command Phase 5 step 4 blocks acceptance on dropped findings and requires droppedReasons', () => {
    expect(phase5Step4).toContain('`reviewFindings.dropped > 0` blocks acceptance of this task')
    expect(phase5Step4).toContain(
      'MUST read `reviewFindings.droppedReasons` (one ordered reason per dropped entry) and report them before treating the review as complete',
    )
    expect(phase5Step4).toContain('never mark the task done on a review with `dropped > 0`')
  })

  test('review-dual documents droppedReasons in the payload and blocks acceptance', () => {
    const normalized = reviewDual.replace(/\s+/g, ' ')

    expect(normalized).toContain(
      '`reviewFindings: { parsed, findings[], improvements[], dropped, droppedReasons[], parseError? }`',
    )
    expect(normalized).toContain('`dropped > 0` means Codex emitted malformed entries and **blocks acceptance**')
    expect(normalized).toContain(
      'must read `droppedReasons` (one ordered reason per dropped entry, e.g. `findings[0].line`) and report them before treating the review as complete',
    )
    expect(normalized).toContain('the task stays not-accepted until the dropped entries are re-obtained')
  })
})

describe('sequential scope trip-wire routing (R2.3)', () => {
  const phase5Step1 = extractNumberedStep(extractPhaseSection(readText(COMMAND_PATH), 5), 1)
    .replace(/\s+/g, ' ')

  test('Phase 5 step 1 runs the scope-check helper before the Claude review pass', () => {
    expect(phase5Step1).toContain('**Scope trip-wire (mechanical, not judgment)**')
    expect(phase5Step1).toContain('in sequential mode, before the Claude review pass')
    expect(phase5Step1).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs" --task T<n> --base <base sha> --tasks .codex-flow/TASKS.md',
    )
    expect(phase5Step1).toContain("with the base sha recorded on this task's `- Session:` line")
  })

  test('any extra path becomes a blocking finding or a plan-drift transaction', () => {
    expect(phase5Step1).toContain('ANY extra path it prints')
    expect(phase5Step1).toContain('is a blocking finding routed through step 5')
    expect(phase5Step1).toContain('the step 6 plan-drift transaction')
    expect(phase5Step1).toContain('do not review the out-of-scope diff as if it were in scope')
    expect(phase5Step1).toContain("do not re-argue the task's `Files:` after the fact")
  })
})

describe('deep health probe and outage routing (R3.3)', () => {
  const command = readText(COMMAND_PATH)
  const preflight = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')
  const phase0 = extractPhaseSection(command, 0).replace(/\s+/g, ' ')
  // T9 retarget: both contracts moved into their skills (T8); read them there.
  const fastPath = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')
  const fallbackSection = readText(EXECUTOR_FALLBACK_PATH).replace(/\s+/g, ' ')

  test('Phase 0 calls the deep probe once and reads execProbe', () => {
    expect(phase0).toContain('call `mcp__codex__codex_health` with `{ deep: true }` ONCE — after the gate decision and the resume check, before anything else')
    expect(phase0).toContain('returning `execProbe` (`ok | quota | model | error | skipped`) plus `execProbeMessage`')
    expect(phase0).toContain('Read `execProbe` from that single call; never re-probe per phase or per task')
    expect(phase0).toContain('**`execProbe: quota` or `execProbe: model`**')
    expect(phase0).toContain('**`execProbe: error`**')
  })

  test('a quota or model probe alone triggers the Executor fallback with no health re-check', () => {
    expect(phase0).toContain(
      'a `quota` or `model` probe result is sufficient on its own and needs NO unhealthy health re-check to justify the fallback',
    )
    expect(fallbackSection).toContain(
      "the deep call's `execProbe` is `quota`, `model`, or `error`",
    )
    expect(fallbackSection).toContain(
      'No health re-check is required: an `execProbe` of `quota` or `model`, or a run error carrying those signatures, is sufficient on its own to open the fallback decision.',
    )
    expect(fallbackSection).not.toContain('AND an immediate `mcp__codex__codex_health` re-check is not healthy')
  })

  test('the analysis lane delivers a failed Codex second opinion Claude-only and names the failure', () => {
    expect(fastPath).toContain(
      'the analysis is delivered Claude-only and the failure is named in the "what I verified" note',
    )
    expect(fastPath).toContain('never present a single-reviewer readout as dual-verified')
  })

  test('the preflight health gate carries the same deep probe routing', () => {
    expect(preflight).toContain('call `mcp__codex__codex_health` with `{ deep: true }` ONCE — after the gate decision and the resume check, before anything else')
    expect(preflight).toContain('**`execProbe: quota` or `execProbe: model`**')
    expect(preflight).toContain(
      'a `quota` or `model` probe result is sufficient on its own and requires NO unhealthy health re-check',
    )
    expect(preflight).toContain(
      'the analysis is delivered Claude-only with the failure named in the "what I verified" note',
    )
  })
})

describe('terminal phase routing and relational state check (R4.3)', () => {
  const command = readText(COMMAND_PATH)
  const preflight = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')
  const phase0 = extractPhaseSection(command, 0).replace(/\s+/g, ' ')
  const helper = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs"'

  test('Phase 0 archives a complete run instead of offering resume', () => {
    expect(phase0).toContain(
      '`phase: complete` is terminal: the previous run is finished, so do NOT offer resume for it.',
    )
    expect(phase0).toContain(
      "Archive the run's control files to `.codex-flow/archive/<timestamp>/` and begin fresh, exactly as a restart would.",
    )
    expect(phase0).toContain('Resume is offered only for a non-complete `phase`.')
  })

  test('preflight routes phase complete to archive-and-restart', () => {
    expect(preflight).toContain('**`phase: complete`** → terminal, not resumable.')
    expect(preflight).toContain(
      "archive the run's control files to `.codex-flow/archive/<timestamp>/` and begin fresh, exactly as **Restart** does",
    )
    expect(preflight).toContain('Resume is offered only for a non-complete `phase`.')
    expect(preflight).toContain(
      'Ask **resume vs restart** in every case except `phase: complete`',
    )
  })

  test('the resume check validates terminal task statuses with --tasks', () => {
    expect(phase0).toContain(`${helper} check --tasks .codex-flow/TASKS.md`)
    expect(phase0).toContain('When `.codex-flow/TASKS.md` exists, make that same call')
    expect(preflight).toContain(`${helper} check --tasks .codex-flow/TASKS.md`)
    expect(preflight).toContain('whenever that file exists so the terminal-status validation runs')
  })
})

describe('mechanical doc lints (R6.1, R6.2)', () => {
  const command = readText(COMMAND_PATH)
  const preflight = readText(PREFLIGHT_PATH)
  const routingText = extractPreflightResumeRouting(preflight)

  test('every written taskStage value is routed by name in preflight resume routing', () => {
    // Arrange
    const documents = [
      { label: 'commands/codex-flow.md', markdown: command },
      ...skillDocumentPaths().map((skillPath) => ({
        label: path.relative(REPO_ROOT, skillPath),
        markdown: readText(skillPath),
      })),
    ]

    // Act
    const unrouted = documents.flatMap(({ label, markdown }) =>
      findUnroutedTaskStages(markdown, routingText).map((stage) => `${label}: ${stage}`),
    )

    // Assert
    expect(collectWrittenTaskStages(command).length).toBeGreaterThan(0)
    expect(collectWrittenTaskStages(readText(PARALLEL_EXECUTION_PATH)).length).toBeGreaterThan(0)
    expect(unrouted).toEqual([])
  })

  test('the taskStage routing guard reports a stage the resume routing never names', () => {
    const synthetic = 'Set it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set taskStage bogus-stage`.'

    expect(findUnroutedTaskStages(synthetic, routingText)).toEqual(['bogus-stage'])
  })

  test('preflight routes every allowed taskStage value by name', () => {
    const allowedValues = /`taskStage` is one of\s+`([^`]+)`/.exec(preflight.replace(/\r\n/g, '\n'))
    if (!allowedValues) throw new Error('preflight does not enumerate the allowed taskStage values')
    const declared = allowedValues[1].split('|').map((value) => value.trim()).sort()

    expect(collectRoutedTaskStages(routingText)).toEqual(declared)
  })

  test('no flow doc instructs a full-suite run per task', () => {
    // Arrange
    const documents = [
      { label: 'commands/codex-flow.md', markdown: command },
      ...skillDocumentPaths().map((skillPath) => ({
        label: path.relative(REPO_ROOT, skillPath),
        markdown: readText(skillPath),
      })),
    ]

    // Act
    const violations = documents.flatMap(({ label, markdown }) =>
      findPerTaskFullSuiteInstructions(label, markdown),
    )

    // Assert
    expect(violations).toEqual([])
  })

  test('the full-suite guard flags an unqualified per-task instruction', () => {
    const synthetic = 'Then re-run the full suite per task before marking it done.'

    expect(findPerTaskFullSuiteInstructions('synthetic', synthetic)).toEqual([
      'synthetic: matched "full suite per task" in "Then re-run the full suite per task before marking it done."',
    ])
  })

  test('the full-suite guard allows the wave-integration and whole-feature contexts', () => {
    const waveSentence = 'The full suite runs once per merged parallel wave and once in the whole-feature review.'
    const prohibition = 'Do NOT re-run the full suite per task.'

    expect(findPerTaskFullSuiteInstructions('synthetic', waveSentence)).toEqual([])
    expect(findPerTaskFullSuiteInstructions('synthetic', prohibition)).toEqual([])
  })

  test.each([
    ['Execute the entire suite for each task before handing off.', '\\b(?:per|each|every)\\s+task\\b'],
    ['Run the complete test suite mid-task to be safe.', '\\bmid-task\\b'],
    ['The whole suite should be executed every task.', '\\b(?:per|each|every)\\s+task\\b'],
  ])('the paraphrase-tolerant detector flags %j', (sentence, scopeSource) => {
    // Arrange / Act
    const violations = findPerTaskFullSuiteInstructions('synthetic', sentence)

    // Assert
    expect(violations).toEqual([
      `synthetic: matched /${FULL_SUITE_WORDING_PATTERN.source}/ + /${scopeSource}/ in "${sentence}"`,
    ])
  })

  test.each([
    'Never run the entire suite for each task.',
    'The complete test suite runs once per merged wave, not per task.',
    'Wave integration is the only place the whole suite runs for every task in the wave.',
    'Run the targeted tests for each task instead.',
    'The full suite runs in the whole-feature review.',
  ])('the paraphrase-tolerant detector leaves %j green', (sentence) => {
    expect(findPerTaskFullSuiteInstructions('synthetic', sentence)).toEqual([])
  })

  test('a sentence matching both detector layers is reported exactly once', () => {
    const sentence = 'Then re-run the full test suite per task before marking it done.'

    expect(findPerTaskFullSuiteInstructions('synthetic', sentence)).toEqual([
      `synthetic: matched "full test suite per task" in "${sentence}"`,
    ])
  })
})

describe('recursive skill discovery (R6.1, R6.2)', () => {
  test('discovers every skills/**/SKILL.md that exists in the repository', () => {
    // Arrange
    const discovered = skillDocumentPaths()

    // Assert
    expect(discovered.length).toBeGreaterThan(0)
    expect(discovered).toContain(PREFLIGHT_PATH)
    expect(discovered).toContain(PARALLEL_EXECUTION_PATH)
    expect(discovered.every((skillPath) => path.basename(skillPath) === 'SKILL.md')).toBe(true)
    expect(new Set(discovered).size).toBe(discovered.length)
  })

  test('finds a SKILL.md nested more than one level below the skills root', () => {
    // Arrange
    const root = mkdtempSync(path.join(tmpdir(), 'flow-docs-skills-'))
    try {
      const nested = path.join(root, 'group', 'deep', 'nested-skill')
      mkdirSync(nested, { recursive: true })
      writeFileSync(path.join(nested, 'SKILL.md'), '# nested\n', 'utf8')
      const shallow = path.join(root, 'flat-skill')
      mkdirSync(shallow, { recursive: true })
      writeFileSync(path.join(shallow, 'SKILL.md'), '# flat\n', 'utf8')
      writeFileSync(path.join(root, 'README.md'), '# not a skill\n', 'utf8')

      // Act
      const discovered = collectSkillDocuments(root)

      // Assert
      expect(discovered).toEqual([
        path.join(shallow, 'SKILL.md'),
        path.join(nested, 'SKILL.md'),
      ].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a missing skills root instead of silently discovering nothing', () => {
    const missing = path.join(REPO_ROOT, 'skills', '__does_not_exist__')

    expect(() => collectSkillDocuments(missing)).toThrow(/Skills directory does not exist/)
  })
})

describe('plan acceptance citation authoring (R6.3)', () => {
  const PLAN_LINT_COMMAND =
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md'
  const CITATION_FORM = '`; satisfies A<n>[, A<n>]`'
  const ORPHAN_SENTENCE =
    "Every PLAN `A<n>` acceptance entry must be cited by at least one task's `Acceptance:` field; treat a non-zero exit (orphan `A<n>`, unknown citation) as fix the backlog before presenting it."
  const BARE_ID_SENTENCE =
    'every PLAN `A<n>` must be cited by at least one task, and the tokens after `satisfies` must be bare `A<n>` IDs (no suffixes)'

  test('plan-backlog sanity checks run the lint with --plan and fail closed on orphans', () => {
    // Arrange
    const skill = readText(PLAN_BACKLOG_PATH)

    // Act
    const normalizedSkill = skill.replace(/\s+/g, ' ')

    // Assert
    expect(skill).toContain(PLAN_LINT_COMMAND)
    expect(normalizedSkill).toContain(ORPHAN_SENTENCE)
  })

  test('plan-backlog shows the bare citation form and the bare-ID slicing rule', () => {
    // Arrange
    const skill = readText(PLAN_BACKLOG_PATH)

    // Act
    const taskTemplate = extractFencedCodeBlockContaining(skill, 'markdown', '## T1:')

    // Assert
    expect(taskTemplate).toContain(
      '- Acceptance: <verifiable criteria for THIS task alone>; satisfies A<n>[, A<n>]',
    )
    expect(skill.replace(/\s+/g, ' ')).toContain(BARE_ID_SENTENCE)
    expect(skill).toContain(CITATION_FORM)
  })

  test('command Phase 3 lints with a single --plan flag before backlog approval', () => {
    // Arrange
    const command = readText(COMMAND_PATH)
    const phaseSection = extractPhaseSection(command, 3)

    // Act
    const lintIndex = phaseSection.indexOf(PLAN_LINT_COMMAND)
    const approvalIndex = phaseSection.indexOf('Show the backlog to the user and get approval')

    // Assert
    expect(lintIndex).toBeGreaterThanOrEqual(0)
    expect(lintIndex).toBeLessThan(approvalIndex)
    expect(phaseSection.replace(/\s+/g, ' ')).toContain(ORPHAN_SENTENCE)
  })

  test('command Phase 3 task template and slicing rules require bare A-ID citations', () => {
    // Arrange
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 3)

    // Act
    const taskTemplate = extractFencedCodeBlockContaining(phaseSection, 'markdown', '## T1:')

    // Assert
    expect(taskTemplate).toMatch(
      /- Acceptance: <[^\n]+>; satisfies A<n>\[, A<n>\]\r?\n- Session: —\r?\n- Status: pending/,
    )
    expect(phaseSection).toContain(CITATION_FORM)
    expect(phaseSection.replace(/\s+/g, ' ')).toContain(BARE_ID_SENTENCE)
  })

  test('every command coverage-lint invocation carries --plan exactly once', () => {
    // Arrange
    const command = readText(COMMAND_PATH)

    // Act
    const invocations = [...command.matchAll(/requirements-coverage\.mjs([^`]*)`/g)].map(
      (match) => match[1],
    )

    // Assert
    expect(invocations.length).toBeGreaterThanOrEqual(4)
    for (const args of invocations) {
      expect(args.match(/--plan \.codex-flow\/PLAN\.md/g)).toHaveLength(1)
    }
  })

  test('the plan-drift and improvement-gate re-lints name the --plan flag', () => {
    // Arrange
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 5)

    // Act
    const planDrift = extractNumberedStep(phaseSection, 6).replace(/\s+/g, ' ')
    const improvementGate = extractNumberedStep(phaseSection, 9).replace(/\s+/g, ' ')

    // Assert
    expect(planDrift).toContain(PLAN_LINT_COMMAND)
    expect(improvementGate).toContain(
      'Run the impact analysis, the coverage lint with `--plan .codex-flow/PLAN.md`, and backlog sanity checks, then get backlog re-approval;',
    )
  })
})

describe('fail-closed helper wording guard (R1.2)', () => {
  // T14 removed the last exclusion (skills/session-report/SKILL.md's standalone-install escape
  // hatch), so this guard now covers the command and EVERY skill with no carve-outs.
  test('no silent-degradation wording survives in the command or any skill', () => {
    // Arrange
    const documents = [COMMAND_PATH, ...skillDocumentPaths()]

    // Act
    const violations = documents.flatMap((documentPath) =>
      findFallbackWordingViolations(path.relative(REPO_ROOT, documentPath), readText(documentPath)))

    // Assert
    expect(violations).toEqual([])
  })

  test('the session-report skill is inside the guarded set, not excluded from it', () => {
    // Arrange — regression pin for the deleted exclusion: the skill must be discovered by
    // skillDocumentPaths() and must itself be clean.
    const documents = [COMMAND_PATH, ...skillDocumentPaths()]

    // Act
    const violations = findFallbackWordingViolations(
      'skills/session-report/SKILL.md',
      readText(SESSION_REPORT_PATH),
    )

    // Assert
    expect(documents).toContain(SESSION_REPORT_PATH)
    expect(violations).toEqual([])
  })

  test('the guard still flags a silent fallback and still allows an explicit prohibition', () => {
    // Arrange
    const offending = 'If the helper is missing, edit the file directly and continue.'
    const prohibition = 'Never edit the file directly; there is no standalone fallback.'

    // Act
    const flagged = findFallbackWordingViolations('probe', offending)
    const allowed = findFallbackWordingViolations('probe', prohibition)

    // Assert
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toContain('edit the file directly')
    expect(allowed).toEqual([])
  })

  test('an allowlisted clause does not launder a silent fallback in the same sentence', () => {
    // Arrange (IMP-24: clause-scoped allowlist)
    const laundered = 'If the helper is unavailable in a standalone install, keep going, '
      + 'but never fabricate results.'

    // Act
    const violations = findFallbackWordingViolations('probe', laundered)

    // Assert
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('unavailable|unset) in a standalone install')
  })

  test('the canonical fail-closed sentence appears in the command and in preflight', () => {
    // Arrange
    const command = readText(COMMAND_PATH)
    const preflight = readText(PREFLIGHT_PATH)

    // Act
    const commandOccurrences = command.split(CANONICAL_FAIL_CLOSED_SENTENCE).length - 1
    const preflightOccurrences = preflight.split(CANONICAL_FAIL_CLOSED_SENTENCE).length - 1

    // Assert
    expect(commandOccurrences).toBeGreaterThanOrEqual(1)
    expect(preflightOccurrences).toBeGreaterThanOrEqual(1)
  })
})

describe('fast-path gate ordering in Phase 0 (R2.3)', () => {
  test('the fast-path gate is named before the first codex_health call', () => {
    // Arrange
    const phaseZero = extractPhaseSection(readText(COMMAND_PATH), 0)

    // Act — the gate must precede the first instruction to CALL the tool, which the command always
    // spells `mcp__codex__codex_health`; bare `codex_health` prose only describes the gate itself.
    const gateIndex = phaseZero.indexOf('Fast-path gate')
    const healthCallIndex = phaseZero.indexOf('mcp__codex__codex_health')

    // Assert
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(healthCallIndex).toBeGreaterThan(gateIndex)
  })

  test('Phase 0 states the analysis lane makes no health call unless Codex is requested', () => {
    const phaseZero = extractPhaseSection(readText(COMMAND_PATH), 0).replace(/\s+/g, ' ')

    expect(phaseZero).toContain(
      'The analysis lane stops at that gate: no `codex_health` call at all unless the user requests a Codex second opinion.',
    )
  })
})

describe('per-run overhead byte budgets (R8.2, C7 as amended)', () => {
  function byteLength(filePath: string): number {
    return Buffer.byteLength(readFileSync(filePath))
  }

  function overageMessage(filePath: string, bytes: number, limit: number, limitName: string): string {
    return `${path.relative(REPO_ROOT, filePath)} is ${bytes} bytes, ${bytes - limit} over ${limitName}`
  }

  test('the command stays under COMMAND_MAX_BYTES', () => {
    // Arrange
    const bytes = byteLength(COMMAND_PATH)

    // Assert
    expect(
      bytes <= COMMAND_MAX_BYTES
        ? []
        : [overageMessage(COMMAND_PATH, bytes, COMMAND_MAX_BYTES, 'COMMAND_MAX_BYTES')],
    ).toEqual([])
  })

  function skillBytes(skillName: string): number {
    return byteLength(path.join(SKILLS_DIR, skillName, 'SKILL.md'))
  }

  function perFileBreakdown(skills: readonly string[]): string {
    return skills.map((skillName) => `skills/${skillName}/SKILL.md=${skillBytes(skillName)}`).join(', ')
  }

  function phaseSetBytes(skills: readonly string[]): number {
    return skills.reduce((total, skillName) => total + skillBytes(skillName), 0)
  }

  test('every declared phase skill set stays under PHASE_SKILLS_MAX_BYTES', () => {
    // Arrange + Act
    const overages = PHASE_SKILL_MAP.flatMap(({ phase, skills }) => {
      const bytes = phaseSetBytes(skills)

      return bytes <= PHASE_SKILLS_MAX_BYTES
        ? []
        : [
          `${phase} skills are ${bytes} bytes, ${bytes - PHASE_SKILLS_MAX_BYTES} over `
          + `PHASE_SKILLS_MAX_BYTES (${perFileBreakdown(skills)})`,
        ]
    })

    // Assert
    expect(overages).toEqual([])
  })

  test('PHASE_SKILLS_MAX_BYTES still matches its C7 derivation from the measured phase sets', () => {
    // Arrange — largest measured phase set, rounded up to the next 4 000, capped at 48 000.
    const ROUNDING_STEP_BYTES = 4_000
    const PHASE_SKILLS_CAP_BYTES = 48_000
    const largestPhaseBytes = Math.max(
      ...PHASE_SKILL_MAP.map(({ skills }) => phaseSetBytes(skills)),
    )

    // Act
    const derived = Math.min(
      Math.ceil(largestPhaseBytes / ROUNDING_STEP_BYTES) * ROUNDING_STEP_BYTES,
      PHASE_SKILLS_CAP_BYTES,
    )

    // Assert — a doc edit that invalidates the recorded derivation fails here, not silently.
    expect(derived).toBe(PHASE_SKILLS_MAX_BYTES)
  })

  test('the command plus every flow skill stays under FLOW_TOTAL_MAX_BYTES', () => {
    // Arrange
    const flowSkills = [...new Set(PHASE_SKILL_MAP.flatMap(({ skills }) => skills))]

    // Act
    const bytes = phaseSetBytes(flowSkills) + byteLength(COMMAND_PATH)

    // Assert
    expect(flowSkills).toHaveLength(20)
    expect(
      bytes <= FLOW_TOTAL_MAX_BYTES
        ? []
        : [
          `command + ${flowSkills.length} flow skills are ${bytes} bytes, `
          + `${bytes - FLOW_TOTAL_MAX_BYTES} over FLOW_TOTAL_MAX_BYTES `
          + `(commands/codex-flow.md=${byteLength(COMMAND_PATH)}, ${perFileBreakdown(flowSkills)})`,
        ],
    ).toEqual([])
  })

  test('every skill named in the phase map exists on disk', () => {
    const missing = [...new Set(PHASE_SKILL_MAP.flatMap(({ skills }) => skills))]
      .filter((skillName) => !existsSync(path.join(SKILLS_DIR, skillName, 'SKILL.md')))

    expect(missing).toEqual([])
  })
})

describe('moved paragraph uniqueness (R8.3)', () => {
  test('each paragraph T8 moved out of the command lives in exactly one document', () => {
    // Arrange
    const documents = [COMMAND_PATH, ...skillDocumentPaths()]
      .map((documentPath) => ({ documentPath, text: readText(documentPath) }))

    // Act
    const misplaced = MOVED_PARAGRAPH_SENTENCES.map((sentence) => {
      const holders = documents
        .filter(({ text }) => text.includes(sentence))
        .map(({ documentPath }) => path.relative(REPO_ROOT, documentPath))

      return { sentence, holders }
    }).filter(({ holders }) => holders.length !== 1)

    // Assert
    expect(misplaced).toEqual([])
  })
})

// T15 wording guards (R3.4, R4.3, R7.3, R7.4). Every required-wording assertion below goes through
// this one predicate, so a single synthetic negative control proves the guard really fails when the
// wording disappears instead of passing vacuously. Whitespace is normalized on both sides so a
// re-wrapped doc line does not break a guard that the wording still satisfies.
function findMissingPhrases(label: string, text: string, phrases: readonly string[]): string[] {
  const normalized = text.replace(/\s+/g, ' ')

  return phrases
    .filter((phrase) => !normalized.includes(phrase.replace(/\s+/g, ' ')))
    .map((phrase) => `${label}: required wording is missing — "${phrase}"`)
}

// Inverse predicate for wording T14 deleted: it must not come back.
function findForbiddenPhrases(label: string, text: string, phrases: readonly string[]): string[] {
  const normalized = text.replace(/\s+/g, ' ')

  return phrases
    .filter((phrase) => normalized.includes(phrase.replace(/\s+/g, ' ')))
    .map((phrase) => `${label}: forbidden wording is back — "${phrase}"`)
}

// IMP-51 per-guard negative controls. `withPhraseRemoved` mutates an in-memory copy of the real
// document (never the file on disk); the copy is then run through the guard's own section
// extractor, so each guard is proven to fail both when the wording disappears and when the
// extractor stops pointing at the section that carries it.
const PHRASE_REMOVED_MARKER = '<<required wording removed by negative control>>'

function withPhraseRemoved(text: string, phrase: string): string {
  const pattern = new RegExp(
    phrase
      .trim()
      .split(/\s+/)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
    'g',
  )

  if (text.match(pattern) === null) {
    throw new Error(`Cannot build a negative control: the document lacks the phrase "${phrase}"`)
  }

  return text.replace(pattern, PHRASE_REMOVED_MARKER)
}

function expectGuardReportsEachMissingPhrase(
  label: string,
  document: string,
  phrases: readonly string[],
  extract: (text: string) => string = (text) => text,
): void {
  for (const phrase of phrases) {
    const mutated = extract(withPhraseRemoved(document, phrase))

    expect(findMissingPhrases(label, mutated, phrases)).toContain(
      `${label}: required wording is missing — "${phrase}"`,
    )
  }
}

describe('required/forbidden wording predicates (T15 guard controls)', () => {
  test('findMissingPhrases reports only the phrases a document lacks', () => {
    // Arrange
    const document = 'pass `model` only when `authMode` is `apikey`.'

    // Act
    const missing = findMissingPhrases('probe', document, [
      'only when `authMode` is `apikey`',
      'steer with `reasoningEffort`',
    ])

    // Assert
    expect(missing).toEqual([
      'probe: required wording is missing — "steer with `reasoningEffort`"',
    ])
  })

  test('findMissingPhrases tolerates re-wrapped whitespace', () => {
    // Arrange
    const rewrapped = 'pass `model` only\n  when `authMode` is\t`apikey`.'

    // Act + Assert
    expect(findMissingPhrases('probe', rewrapped, ['only when `authMode` is `apikey`'])).toEqual([])
  })

  test('findForbiddenPhrases reports only the phrases a document still carries', () => {
    // Arrange
    const document = 'the payload is returned unredacted when no pattern matches.'

    // Act
    const found = findForbiddenPhrases('probe', document, [
      'returned unredacted',
      'fall back to reading PLAN.md',
    ])

    // Assert
    expect(found).toEqual(['probe: forbidden wording is back — "returned unredacted"'])
  })
})

describe('auth-aware model bullet wording (R3.4)', () => {
  // The bullet heading is `- \`model\` and \`reasoningEffort\`:`, so the parameter label passed to
  // extractParameterBullet carries the interior backticks of that compound label verbatim.
  const MODEL_BULLET_LABEL = 'model` and `reasoningEffort'
  const MODEL_BULLET_PHRASES = [
    'pass `model` only when Phase 0\'s `codex_health.authMode` is `apikey`',
    'otherwise omit `model` and steer with `reasoningEffort`',
  ] as const
  const README_AUTH_MODE_PHRASES = [
    '`authMode: "chatgpt" | "apikey" | "unknown"`',
    'pass `model` only when `authMode` is `apikey`; otherwise omit it and steer with '
    + '`reasoningEffort`',
    'a flowDocs guard checks that wording',
  ] as const

  test('Phase 4 tells the executor to pass model only under apikey auth', () => {
    // Arrange
    const phaseFour = extractPhaseSection(readText(COMMAND_PATH), 4)

    // Act
    const bullet = extractParameterBullet(phaseFour, MODEL_BULLET_LABEL)

    // Assert
    expect(findMissingPhrases('commands/codex-flow.md Phase 4', bullet, MODEL_BULLET_PHRASES))
      .toEqual([])
  })

  test('README documents authMode and the guard that pins the wording', () => {
    // Arrange + Act
    const missing = findMissingPhrases('README.md', readText(README_PATH), README_AUTH_MODE_PHRASES)

    // Assert
    expect(missing).toEqual([])
  })

  test('the Phase 4 guard reports each required phrase removed from the bullet (IMP-51)', () => {
    expectGuardReportsEachMissingPhrase(
      'commands/codex-flow.md Phase 4',
      readText(COMMAND_PATH),
      MODEL_BULLET_PHRASES,
      (text) => extractParameterBullet(extractPhaseSection(text, 4), MODEL_BULLET_LABEL),
    )
  })

  test('the README guard reports each required phrase removed from the doc (IMP-51)', () => {
    expectGuardReportsEachMissingPhrase(
      'README.md',
      readText(README_PATH),
      README_AUTH_MODE_PHRASES,
    )
  })
})

describe('Codex review scope passing and out-of-scope routing (R4.3)', () => {
  const SCOPE_ARGUMENT = 'scope: { files: <the task\'s `Files:` list>, contract: <the PLAN '
    + 'Contracts the task lists> }'
  const STEP_FOUR_PHRASES = [
    'A finding stamped `inScope: false`',
    'counted in `reviewFindings.outOfScopeCount`',
    'is routed to the improvements ledger by default and does not block',
    'it blocks only when you verify it affects THIS task\'s acceptance',
  ] as const
  const REVIEW_DUAL_PHRASES = [
    SCOPE_ARGUMENT,
    'counting the rest in `reviewFindings.outOfScopeCount`',
    'A finding with `inScope: false` goes to the improvements ledger by default and never blocks '
    + 'the task',
    'Report `outOfScopeCount` with the comparison result',
  ] as const

  test('Phase 5 step 1 passes the task Files and Contracts as the review scope', () => {
    // Arrange
    const phaseFive = extractPhaseSection(readText(COMMAND_PATH), 5)

    // Act
    const stepOne = extractNumberedStep(phaseFive, 1)

    // Assert
    expect(findMissingPhrases('commands/codex-flow.md Phase 5 step 1', stepOne, [SCOPE_ARGUMENT]))
      .toEqual([])
  })

  test('Phase 5 step 4 routes out-of-scope findings to the ledger by default', () => {
    // Arrange
    const phaseFive = extractPhaseSection(readText(COMMAND_PATH), 5)

    // Act
    const stepFour = extractNumberedStep(phaseFive, 4)

    // Assert
    expect(findMissingPhrases('commands/codex-flow.md Phase 5 step 4', stepFour, STEP_FOUR_PHRASES))
      .toEqual([])
  })

  test('review-dual documents outOfScopeCount and the default-to-ledger rule', () => {
    // Arrange + Act
    const missing = findMissingPhrases(
      'skills/review-dual/SKILL.md',
      readText(REVIEW_DUAL_PATH),
      REVIEW_DUAL_PHRASES,
    )

    // Assert
    expect(missing).toEqual([])
  })

  test('the Phase 5 step 1 and step 4 guards report each removed phrase (IMP-51)', () => {
    const command = readText(COMMAND_PATH)

    expectGuardReportsEachMissingPhrase(
      'commands/codex-flow.md Phase 5 step 1',
      command,
      [SCOPE_ARGUMENT],
      (text) => extractNumberedStep(extractPhaseSection(text, 5), 1),
    )
    expectGuardReportsEachMissingPhrase(
      'commands/codex-flow.md Phase 5 step 4',
      command,
      STEP_FOUR_PHRASES,
      (text) => extractNumberedStep(extractPhaseSection(text, 5), 4),
    )
  })

  test('the review-dual guard reports each removed phrase (IMP-51)', () => {
    expectGuardReportsEachMissingPhrase(
      'skills/review-dual/SKILL.md',
      readText(REVIEW_DUAL_PATH),
      REVIEW_DUAL_PHRASES,
    )
  })
})

describe('PROJECT.md generation, reading, and refresh triggers (R7.3, R7.4)', () => {
  const PHASE_ZERO_PHRASES = [
    'when `.codex-flow/PROJECT.md` is absent generate it with',
    'scripts/project-context.mjs" --generate',
    'ask the user to confirm or edit it in the Phase 1 interview',
    'list it as pre-existing in the `baseline-dirty.patch` manifest',
  ] as const
  const STEP_EIGHT_PHRASES = [
    'When any Decision-log block of this run records a contract deviation under `Contracts '
    + 'touched` or a Decision naming an architecture change, run',
    'scripts/project-context.mjs" --refresh',
    'show the user the resulting `.codex-flow/PROJECT.md` diff for confirmation',
  ] as const

  test('Phase 0 generates PROJECT.md when absent and confirms it in the interview', () => {
    // Arrange + Act
    const phaseZero = extractPhaseSection(readText(COMMAND_PATH), 0)

    // Assert
    expect(findMissingPhrases('commands/codex-flow.md Phase 0', phaseZero, PHASE_ZERO_PHRASES))
      .toEqual([])
  })

  test('Phase 2 planning reads PROJECT.md before exploring the codebase', () => {
    // Arrange
    const phaseTwo = extractPhaseSection(readText(COMMAND_PATH), 2)

    // Act
    const stepOne = extractNumberedStep(phaseTwo, 1).replace(/\s+/g, ' ')

    // Assert — "first" is load-bearing: the brief must precede the Explore subagents.
    expect(stepOne).toContain('Read `.codex-flow/PROJECT.md` first')
    expect(stepOne.indexOf('.codex-flow/PROJECT.md'))
      .toBeLessThan(stepOne.indexOf('explore the codebase'))
  })

  test('Phase 5 step 8 instructs --refresh on a recorded deviation or architecture change', () => {
    // Arrange
    const phaseFive = extractPhaseSection(readText(COMMAND_PATH), 5)

    // Act
    const stepEight = extractNumberedStep(phaseFive, 8)

    // Assert
    expect(findMissingPhrases('commands/codex-flow.md Phase 5 step 8', stepEight, STEP_EIGHT_PHRASES))
      .toEqual([])
  })

  test('the Phase 0 and Phase 5 step 8 guards report each removed phrase (IMP-51)', () => {
    const command = readText(COMMAND_PATH)

    expectGuardReportsEachMissingPhrase(
      'commands/codex-flow.md Phase 0',
      command,
      PHASE_ZERO_PHRASES,
      (text) => extractPhaseSection(text, 0),
    )
    expectGuardReportsEachMissingPhrase(
      'commands/codex-flow.md Phase 5 step 8',
      command,
      STEP_EIGHT_PHRASES,
      (text) => extractNumberedStep(extractPhaseSection(text, 5), 8),
    )
  })
})

describe('session-report cost table wording after T14 (R1.2, C5, C9)', () => {
  const PER_MODEL_COLUMNS = [
    'Model',
    'Runs',
    'Failed',
    'Duration (ms)',
    'Input',
    'Cached input',
    'Output',
    'Reasoning output',
    'Sources',
  ] as const
  const COMPLETENESS_FIELDS = [
    'Complete',
    'Unpriced runs',
    'Missing usage',
    'Read errors',
    'History excluded',
  ] as const

  const TABLE_SHAPE_PHRASES = [
    `nine-column \`## Per model\` table (${PER_MODEL_COLUMNS.join(', ')})`,
    `\`## Completeness\` (${COMPLETENESS_FIELDS.join(', ')})`,
  ] as const
  const COMPLETENESS_RULE_PHRASES = [
    '`Complete` is `no` whenever anything went unaccounted for',
    're-run with `--history` to include the archives',
  ] as const

  test('the session-cost helper call site carries the canonical fail-closed sentence', () => {
    // Arrange + Act
    const sessionReport = readText(SESSION_REPORT_PATH)

    // Assert
    expect(sessionReport).toContain(CANONICAL_FAIL_CLOSED_SENTENCE)
  })

  test('the skill names the nine-column Per model table and the Completeness section', () => {
    // Arrange
    const sessionReport = readText(SESSION_REPORT_PATH)

    // Act
    const missing = findMissingPhrases(
      'skills/session-report/SKILL.md',
      sessionReport,
      TABLE_SHAPE_PHRASES,
    )

    // Assert — the recited column list must stay nine wide, matching the C5 helper output.
    expect(PER_MODEL_COLUMNS).toHaveLength(9)
    expect(missing).toEqual([])
  })

  test('the skill says which condition makes Completeness report no', () => {
    // Arrange + Act
    const missing = findMissingPhrases(
      'skills/session-report/SKILL.md',
      readText(SESSION_REPORT_PATH),
      COMPLETENESS_RULE_PHRASES,
    )

    // Assert
    expect(missing).toEqual([])
  })

  test('the session-report guards report each removed phrase (IMP-51)', () => {
    const sessionReport = readText(SESSION_REPORT_PATH)

    expectGuardReportsEachMissingPhrase(
      'skills/session-report/SKILL.md',
      sessionReport,
      TABLE_SHAPE_PHRASES,
    )
    expectGuardReportsEachMissingPhrase(
      'skills/session-report/SKILL.md',
      sessionReport,
      COMPLETENESS_RULE_PHRASES,
    )
  })
})

describe('README wording T14 removed stays removed', () => {
  const REMOVED_README_PHRASES = [
    'returned unredacted',
    'fall back to reading PLAN.md',
  ] as const

  test('README no longer claims unredacted output or a PLAN.md read fallback', () => {
    // Arrange + Act
    const violations = findForbiddenPhrases(
      'README.md',
      readText(README_PATH),
      REMOVED_README_PHRASES,
    )

    // Assert
    expect(violations).toEqual([])
  })

  test('the guard reports each phrase reintroduced into a copy of the README (IMP-51)', () => {
    const readme = readText(README_PATH)

    for (const phrase of REMOVED_README_PHRASES) {
      const mutated = `${readme}\n\nSynthetic regression: ${phrase}.\n`

      expect(findForbiddenPhrases('README.md', mutated, REMOVED_README_PHRASES)).toContain(
        `README.md: forbidden wording is back — "${phrase}"`,
      )
    }
  })
})
