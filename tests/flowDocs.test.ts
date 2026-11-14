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
// @ts-expect-error — plain .mjs script
import { parseCliArgs } from '../scripts/flow-state-cli.mjs'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { DATA_PROFILE_GATES } from '../scripts/profile-router.mjs'

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
const RUN_LEDGER_PATH = path.join(REPO_ROOT, 'skills', 'run-ledger', 'SKILL.md')
const JEV_ASSIST_PATH = path.join(REPO_ROOT, 'skills', 'jev-assist', 'SKILL.md')
const PROFILE_PILOT_PATH = path.join(REPO_ROOT, 'skills', 'profile-pilot', 'SKILL.md')
const EXECUTOR_FALLBACK_PATH = path.join(REPO_ROOT, 'skills', 'executor-fallback', 'SKILL.md')
const SESSION_REPORT_PATH = path.join(REPO_ROOT, 'skills', 'session-report', 'SKILL.md')
const SKILLS_DIR = path.join(REPO_ROOT, 'skills')
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'codex-flow.md')
const README_PATH = path.join(REPO_ROOT, 'README.md')
const CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'codex-flow.md')
const COMMAND_TOKEN_ALLOWLIST = new Set(['codex-flow:codex-flow'])
const BRAINSTORM_COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'brainstorm.md')
const BRAINSTORM_CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'brainstorm.md')
const BRAINSTORM_SKILL_PATH = path.join(SKILLS_DIR, 'brainstorm-debate', 'SKILL.md')
// Brainstorm lane budgets: a thinking workflow must stay far cheaper than the full flow.
const BRAINSTORM_COMMAND_MAX_BYTES = 12_000
const BRAINSTORM_SKILL_MAX_BYTES = 10_000
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
// Growth guard: measured command + the 21 flow skills = 162 806 bytes after the T6 review trims.
// (run-ledger added in Phase 0 of the multiscope roadmap).
const FLOW_TOTAL_MAX_BYTES = 162_943
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
      'run-ledger',
    ],
  },
]
const FLOW_STATE_SUBCOMMANDS = [
  'init', 'approve', 'advance', 'requirement-delta', 'plan-drift', 'improvement-gate',
  'resume', 'set', 'check', 'archive-paths', 'task',
] as const
function flowStateCliSubcommands(): string[] {
  try {
    parseCliArgs(['__unknown__'])
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw new Error('Expected the CLI usage error to be an Error')
    const match = error.message.match(/usage: flow-state <([^>]+)>/)
    if (!match) throw new Error(`Expected a flow-state usage message, received: ${error.message}`)
    return match[1].split('|')
  }
  throw new Error('Expected the CLI to reject an unknown subcommand')
}

const FLOW_STATE_CLI_SUBCOMMANDS = flowStateCliSubcommands()
const FLOW_STATE_CLI_SUBCOMMAND_PATTERN = FLOW_STATE_CLI_SUBCOMMANDS.join('|')
const FLOW_STATE_PLACEHOLDERS: ReadonlyArray<[RegExp, string]> = [
  [/^T\d+$|^<T-id>$/i, 'T1'],
  [/^<status>$/i, 'done'],
  [/^<n>$/i, '1'],
  [/^<(?:sha|ref|head)[^>]*>$/i, 'abc1234'],
  [/^<(?:ISO[^>]*|timestamp)[^>]*>$/i, '2026-11-11T00:00:00Z'],
]
// R8.3: distinctive sentences T8 moved out of the command. Each must survive verbatim in exactly
// one document, so the move neither lost a rule nor left a duplicate behind.
const MOVED_PARAGRAPH_SENTENCES = [
  // skills/fast-path
  'the deliverable is an answer, report, or data readout; no tracked project\n  file is created or modified.',
  'No Codex session is\nrequired (this lane is exempt from the Codex health gate)',
  'ANY extra changed\nfile — excluding generated lockfiles — triggers the escalation rule automatically; '
  + 'do not review\nthe oversized diff in-lane and do not re-argue eligibility after the fact.',
  'A wrong up-front size estimate is not a failure;\nstretching the lane to avoid the restart is.',
  // skills/executor-fallback
  '**Phase 5 under fallback** — Claude must not grade its own homework alone:',
  'apply\n  the loaded `exec-coding-standards`, `exec-self-testing`, language, deliverable, and '
  + 'distilled\n  domain-skill blocks to your own work — they bind Claude the same way they bind Codex.',
  'Tasks completed under fallback keep their\n`claude-fallback` Session line and are never re-executed.',
] as const
const EXACT_FRONTMATTER_SKILLS = [
  'plan-architecture',
  'preflight',
  'context-discipline',
  'parallel-execution',
  'agent-context-persistence',
  'jev-assist',
  'profile-pilot',
  'profile-design',
  'profile-plan',
  'profile-content',
] as const

function readText(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Required flow document does not exist: ${filePath}`)
  }

  // Windows checkouts may materialize CRLF via git autocrlf; guards assert LF-relative offsets.
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

function tokenizeFlowState(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|"([^"]*)"|(<[^>]+>)|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4])
}

function substituteFlowStateToken(token: string): string {
  const placeholder = FLOW_STATE_PLACEHOLDERS.find(([pattern]) => pattern.test(token))
  return placeholder?.[1] ?? (token.startsWith('<') && token.endsWith('>') ? 'sample' : token)
}

function expandFlowStateText(text: string): string[][] {
  const optional = text.match(/^\[([^\]]+)\]$/)
  if (optional) return [[], ...expandFlowStateText(optional[1])]
  const alternatives = text.match(/^<?([^<>|]+(?:\|[^<>|]+)+)>?$/)
  if (alternatives) return alternatives[1].split('|').map((value) => [substituteFlowStateToken(value)])
  return [[substituteFlowStateToken(text)]]
}

const ALLOWED_FLOW_STATE_PROSE = new Set(['flow-state <subcommand>'])

function flowStateDocuments(): string[] {
  const skillNames = [...new Set(PHASE_SKILL_MAP.flatMap(({ skills }) => skills))]
  return [COMMAND_PATH, ...skillNames.map((name) => path.join(SKILLS_DIR, name, 'SKILL.md'))]
}

function extractFlowStateInvocations(markdown: string): {
  invocations: Array<{ text: string, tokens: string[] }>
  sourceCount: number
  offenders: string[]
} {
  const invocations: Array<{ text: string, tokens: string[] }> = []
  const offenders: string[] = []
  let sourceCount = 0
  const helperPattern = /node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/flow-state\.mjs"|(?<![\w-])flow-state(?!\.mjs)/g
  const starts = [...markdown.matchAll(helperPattern)]
  for (const start of starts) {
    const lineEnd = markdown.indexOf('\n', start.index)
    const tickEnd = markdown.indexOf('`', start.index)
    const end = [lineEnd, tickEnd].filter((offset) => offset >= 0).sort((a, b) => a - b)[0] ?? markdown.length
    const tail = markdown.slice(start.index + start[0].length, end)
    if (!/^\s+\S/.test(tail)) continue
    const candidate = `${start[0]}${tail}`.trim()
    const tokens = tokenizeFlowState(tail).map((token, index) =>
      index === 0 ? token.replace(/[`,.;:)]+$/, '') : token)
      .filter((token) => !/^(?:…|\.\.\.)$/.test(token))
    if (tokens[0] === '<subcommand>') continue
    if (!FLOW_STATE_SUBCOMMANDS.includes(tokens[0] as typeof FLOW_STATE_SUBCOMMANDS[number])) {
      if (!ALLOWED_FLOW_STATE_PROSE.has(candidate)) offenders.push(candidate)
      continue
    }
    sourceCount += 1
    const variants = tokens.reduce<string[][]>((all, token) =>
      all.flatMap((prefix) => expandFlowStateText(token).map((suffix) => [...prefix, ...suffix])), [[]])
    for (const variant of variants) invocations.push({ text: candidate, tokens: variant })
  }
  return { invocations, sourceCount, offenders }
}

describe('documented flow-state invocations parse with the real CLI', () => {
  test('all documented invocations are accepted by parseCliArgs', () => {
    // Arrange
    const documents = flowStateDocuments()
    const failures: string[] = []
    const offenders: string[] = []
    const counts = new Map<string, number>()
    const extractedCounts: Record<string, number> = {}
    const independentCounts: Record<string, number> = {}
    // Act
    expect([...FLOW_STATE_CLI_SUBCOMMANDS].sort()).toEqual([...FLOW_STATE_SUBCOMMANDS].sort())
    for (const filePath of documents) {
      const text = readText(filePath)
      const extracted = extractFlowStateInvocations(text)
      const invocations = extracted.invocations
      const relativePath = path.relative(REPO_ROOT, filePath)
      extractedCounts[relativePath] = extracted.sourceCount
      offenders.push(...extracted.offenders.map((item) => `${relativePath}: ${item}`))
      const knownInvocationPattern = new RegExp(
        `(?:flow-state(?:\\.mjs")?)\\s+(?:${FLOW_STATE_CLI_SUBCOMMAND_PATTERN})\\b`,
        'g',
      )
      independentCounts[relativePath] = [...text.matchAll(knownInvocationPattern)].length
      for (const invocation of invocations) {
        const command = invocation.tokens[0]
        counts.set(command, (counts.get(command) ?? 0) + 1)
        try {
          parseCliArgs(invocation.tokens)
        } catch (error) {
          failures.push(`${path.relative(REPO_ROOT, filePath)}: ${invocation.text}: ${String(error)}`)
        }
      }
    }

    // Assert
    const missingSubcommands = FLOW_STATE_SUBCOMMANDS.filter((command) => !counts.has(command))
    const mismatches = Object.keys(extractedCounts)
      .filter((relativePath) => extractedCounts[relativePath] !== independentCounts[relativePath])
      .map((relativePath) => (
        `${relativePath}: extracted ${extractedCounts[relativePath]}, `
        + `independent ${independentCounts[relativePath]}`
      ))
    expect(missingSubcommands).toEqual([])
    expect(mismatches).toEqual([])
    expect(offenders).toEqual([])
    expect(failures).toEqual([])
  })

  test('the extractor and parser report invalid inline invocations', () => {
    const fixture = '`flow-state set phase` `flow-state frobnicate`'
    const extracted = extractFlowStateInvocations(fixture)
    const failures = extracted.invocations.flatMap(({ text, tokens }) => {
      try {
        parseCliArgs(tokens)
        return []
      } catch (error) {
        return [`${text}: ${String(error)}`]
      }
    })

    expect([...failures, ...extracted.offenders]).toHaveLength(2)
    expect(extractFlowStateInvocations('`flow-state approve plan` → `flow-state advance`').sourceCount).toBe(2)
    expect(tokenizeFlowState('--known-red "<compact list>" <run-start HEAD>')).toEqual([
      '--known-red', '<compact list>', '<run-start HEAD>',
    ])

    const fullForm = extractFlowStateInvocations(
      '`node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set executionMode '
      + '"sequential (worktrees unavailable: <error>)"`',
    )
    expect(fullForm.invocations).toHaveLength(1)
    expect(fullForm.invocations[0]?.tokens).toEqual([
      'set', 'executionMode', 'sequential (worktrees unavailable: <error>)',
    ])

    const initForm = extractFlowStateInvocations(
      '`node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" init --baseline '
      + '<run-start HEAD> --known-red "<compact list>"`',
    )
    expect(initForm.invocations).toHaveLength(1)
    expect(() => parseCliArgs(initForm.invocations[0]?.tokens ?? [])).not.toThrow()

    const unknownForm = extractFlowStateInvocations(
      '`node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" frobnicate`',
    )
    expect(unknownForm.offenders).toHaveLength(1)
  })
})

describe('retired documented flow-state forms stay absent', () => {
  const RETIRED_FLOW_STATE_PATTERNS = [
    /flow-state(?:[^`\n]*)\s+set\s+(?:phase|\w+Approved)/i,
    /hand-?write[^.\n]*STATE\.md/i,
    /write[^.\n]*STATE\.md[^.\n]*by hand/i,
  ] as const

  test('AGENTS.md and README.md contain no retired forms', () => {
    const documents = [readText(path.join(REPO_ROOT, 'AGENTS.md')), readText(README_PATH)]
    expect(documents.flatMap((text) => RETIRED_FLOW_STATE_PATTERNS.filter((pattern) => pattern.test(text)))).toEqual([])
    expect(RETIRED_FLOW_STATE_PATTERNS.some((pattern) => pattern.test('flow-state set phase'))).toBe(true)
    expect(RETIRED_FLOW_STATE_PATTERNS.some((pattern) => pattern.test('flow-state set qualityApproved yes'))).toBe(true)
    expect(RETIRED_FLOW_STATE_PATTERNS.some((pattern) => pattern.test('write STATE.md by hand'))).toBe(true)
  })
})

describe('final-review session line contract', () => {
  test('reviews.md final-review section carries its own Codex review session line', () => {
    const report = readText(SESSION_REPORT_PATH)
    const gate = report.split('\n').find((line) => line.startsWith('- Append to `reviews.md`'))
    expect(gate).toMatch(/final-review section[^.\n]*own `Codex review session:` line/i)
  })
})

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

describe('run-ledger wiring', () => {
  test('pins the ledger skill format and best-effort rule', () => {
    // Arrange
    const skill = readText(RUN_LEDGER_PATH)

    // Act
    const fields = parseFrontmatterFields(skill)

    // Assert
    expect(fields.map(({ key }) => key)).toEqual(['name', 'description'])
    expect(fields[0].value).toBe('run-ledger')
    expect(skill).toContain(
      'The ledger is best-effort: report a non-zero exit to the user and continue; never stop a run for it.',
    )
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(6_000)
  })

  test('pins the helper-rule exception and review-phase ledger skill', () => {
    // Arrange
    const command = readText(COMMAND_PATH)

    // Act
    const phaseFour = extractPhaseSection(command, 4)
    const phaseFive = extractPhaseSection(command, 5)

    // Assert
    expect(command).toContain(
      'except `run-ledger.mjs`, which is best-effort per `codex-flow:run-ledger`',
    )
    expect(extractLoadSkillsText(phaseFour, 4)).not.toContain('`codex-flow:run-ledger`')
    expect(extractLoadSkillsText(phaseFive, 5)).toContain('`codex-flow:run-ledger`')
    expect(command).toContain(
      'Before the final completion `flow-state advance`, append one ledger line per `codex-flow:run-ledger`.',
    )
  })

  test('pins fast-path ledger calls for both lanes', () => {
    // Arrange
    const skill = readText(FAST_PATH_PATH).replace(/\s+/g, ' ')

    // Act
    const laneRule =
      'Append the matching `fast-path-analysis` or `fast-path-small` run-ledger line at the terminal outcome.'

    // Assert
    expect(skill).toContain(laneRule)
  })

  test('pins the brainstorm ledger call and expanded artifact rule', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    // Act
    const rules = command.slice(command.indexOf('Rules:'))

    // Assert
    expect(command).toContain('one run-ledger line outside the workspace')
    expect(rules).toContain('artifacts, the log line, and the run-ledger line outside the workspace')
  })

  test('pins the brainstorm ledger skill and Decide-step append instruction', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    // Act
    const decide = command.slice(command.indexOf('## Decide —'))

    // Assert
    expect(command).toContain('`codex-flow:brainstorm-argumentation`, and `codex-flow:run-ledger`.')
    expect(decide).toContain(
      'Then append one `brainstorm` run-ledger line per `codex-flow:run-ledger`.',
    )
  })
})

describe('T7 helper call-site inventory', () => {
  const flowSkillNames = [...new Set(PHASE_SKILL_MAP.flatMap(({ skills }) => skills))]
  const OPT_IN_SKILLS = ['jev-assist', 'profile-pilot', 'profile-design', 'profile-plan', 'profile-content'] as const
  const scope = [
    COMMAND_PATH,
    ...flowSkillNames.map((name) => path.join(SKILLS_DIR, name, 'SKILL.md')),
    ...OPT_IN_SKILLS.map((name) => path.join(SKILLS_DIR, name, 'SKILL.md')),
  ]

  test('classifies every helper occurrence with one strict Helpers line', () => {
    for (const filePath of scope) {
      const text = readText(filePath)
      if (filePath === COMMAND_PATH) {
        expect(text).toContain('**Helper rule**')
        continue
      }
      const bestEffortHelpers = filePath === RUN_LEDGER_PATH
        ? new Set(['run-ledger.mjs'])
        : new Set<string>()
      const occurrences = new Set(
        [...text.matchAll(/scripts\/([a-z0-9-]+\.mjs)/g)]
          .map((match) => match[1])
          .filter((name) => !bestEffortHelpers.has(name)),
      )
      if (occurrences.size === 0) continue
      const helperLines = text.split('\n').filter((line) => line.startsWith('**Helpers**:'))
      const helpersLine = helperLines[0]
      expect(helperLines).toHaveLength(1)
      expect(helpersLine).toBeDefined()
      const listed = new Set(
        [...helpersLine.matchAll(/(?:required|optional) — ([^;(]+)/g)]
          .flatMap((match) => match[1].split(',').map((name) => name.trim()))
          .filter((name) => name.endsWith('.mjs')),
      )
      expect([...occurrences].filter((name) => !listed.has(name))).toEqual([])
      expect([...listed].filter((name) => !occurrences.has(name))).toEqual([])
      if (helpersLine.includes('required —') && !helpersLine.includes('required — none')) {
        expect(helpersLine).toContain('helper rule')
      }
    }
  })

  test('skill-selection Step 4 names the shortlist CLI with the plugin root', () => {
    const skill = readText(SKILL_SELECTION_PATH)
    expect(skill).toContain(
      'deterministic retrieval as a **shortlist producer, never the final selection**',
    )
    expect(skill).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/skill-shortlist.mjs')
    expect(skill).toContain('derive the\n  facet terms yourself (Step 2)')
  })

  test('skill-selection documents generic-only pruning and shortlist warning recovery', () => {
    const skill = readText(SKILL_SELECTION_PATH)
    expect(skill).toMatch(/`generic-only` tag means remove the candidate as wrong-domain unless its stated purpose matches/)
    expect(skill).toMatch(/only weak matches.*does not look like English.*derive English terms/s)
    expect(skill).toContain('--facet name=term,term')
  })

  test('skill-selection Step 1 checks index staleness with the plugin-root helper', () => {
    const skill = readText(SKILL_SELECTION_PATH)
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/build-skills-index.mjs" --check')
    expect(skill).not.toContain('Sanity-check the count')
  })

  test('guards T7 kernel migrations and prohibited shell/state writes', () => {
    const preflight = readText(PREFLIGHT_PATH)
    const parallel = readText(PARALLEL_EXECUTION_PATH)
    const interview = readText(INTERVIEW_ELICITATION_PATH)
    const report = readText(SESSION_REPORT_PATH)
    expect(preflight).toContain('flow-state.mjs" init --baseline')
    expect(preflight).toContain('resume --head')
    expect(preflight).toContain('doctor.mjs --probe-launcher')
    expect(parallel).toContain('worktree-setup.mjs" --worktree')
    expect(parallel).toMatch(/do NOT dispatch/i)
    expect(parallel).not.toContain('mkdir -p')
    expect(parallel).not.toContain('cp .codex-flow')
    expect(parallel).not.toContain('[ -f')
    expect(interview).toContain('flow-state.mjs" requirement-delta')
    expect(report).toContain('Codex review session:')
    expect(report).toContain('review session ids from reviews.md')
    for (const filePath of scope.slice(1)) {
      const text = readText(filePath).replace(/```[\s\S]*?```/g, '')
      expect(text).not.toContain('set phase')
      expect(text).not.toContain('set `phase`')
      expect(text).not.toContain('restore `backlogApproved`')
    }
  })
})

describe('opt-in Jev procedure move (C3)', () => {
  test('source skills keep only the opt-in pointer and the new skill owns all procedures', () => {
    const sources = [FAST_PATH_PATH, REVIEW_DUAL_PATH, SKILL_SELECTION_PATH]
    for (const filePath of sources) {
      const lines = readText(filePath).split('\n').filter((line) => /jev/i.test(line))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('codex-flow:jev-assist')
    }

    const jev = readText(JEV_ASSIST_PATH)
    expect(jev).toContain('Jev-assisted lane routing')
    expect(jev).toContain('Jev-assisted relevance scoring')
    expect(jev).toContain('Jev-assisted finding triage')
    expect(jev).toContain('Jev-assisted root-cause classification')
    expect(jev).toContain('Jev-assisted improvement prioritization')
    for (const point of ['fast-path-lane', 'skill-relevance', 'review-triage', 'improvement-priority']) {
      expect(jev).toContain(`--point ${point}`)
    }
    expect(jev).toContain('Choice question `root_cause`')
    for (const category of [
      'auth/session',
      'database queries',
      'file paths',
      'external API calls',
      'crypto',
      'payments',
      'secrets/env',
    ]) {
      expect(jev).toContain(category)
    }
    for (const threshold of ['0.6', '0.85', '0.8']) expect(jev).toContain(threshold)
    expect(jev).toContain('never call-then-filter')
    expect(jev).toContain('one batched')
    expect(jev).toContain('codex_continue')
    expect(PHASE_SKILL_MAP.flatMap(({ skills }) => skills)).not.toContain('jev-assist')
  })
})

describe('profile-pilot skill', () => {
  test('pins the conditional data profile skill', () => {
    // Arrange
    const skill = readText(PROFILE_PILOT_PATH)
    // Act
    const routerTable = skill.slice(skill.indexOf('## Router'), skill.indexOf('## Evidence'))
    const fields = parseFrontmatterFields(skill)
    const evidence = skill.slice(skill.indexOf('```\nEvidence block\n'), skill.indexOf('```', skill.indexOf('```\nEvidence block\n') + 3))

    // Assert
    expect(fields.map(({ key }) => key)).toEqual(['name', 'description'])
    expect(fields[0].value).toBe('profile-pilot')
    expect(fields.every(({ value }) => value.trim().length > 0)).toBe(true)
    expect(fields.every(({ value }) => !/^['"]/.test(value.trim()))).toBe(true)
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(6000)
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(5850)
    expect(skill.match(/^\*\*Helpers\*\*:/gm)).toHaveLength(1)
    for (const gate of DATA_PROFILE_GATES) expect(routerTable).toContain(gate)
    expect(skill).toMatch(/```\nEvidence block\n/)
    expect(evidence).not.toContain('CLAUDE_PLUGIN_ROOT')
    expect(evidence).not.toContain('reviews.md')
    expect(evidence).not.toContain('verifyCommand')
    for (const item of [
      'reproducible',
      'sourced',
      'answers the question',
      'decision-useful',
      'language-consistent',
    ]) expect(skill).toContain(`\`${item}\``)
    expect(skill).toContain('--sample 3')
    expect(skill).toContain('Deliverable language: <vi|en>')
    expect(skill).toContain('first interview question confirms profile')
    expect(skill).toContain('immediately after the `Run position:` line')
    expect(skill).toContain('optional `tables[]` and `ignoreNumbers`')
    expect(skill).toContain('flow-state set knownRed')
    expect(skill).toContain('Embed the Evidence block and use the checker only when `evidenceMode` is not `off`')
    expect(skill).toContain('with evidence `off`, non-code tasks use the `exec-deliverable` Verification block alone')
    expect(skill).toContain('Router applies to confirmed `data`, `design`, `plan` or `content` profiles')
    expect(skill).toContain('If confirmed profile is `code` or `mixed` while enforcing')
    expect(skill).toContain('If corrected to a non-code profile while enforcing')
    expect(skill).toContain('flow-state set profile <p>')
    expect(skill).toContain('data`, `design`, `plan` or `content`')
    expect(skill).toContain('these replacements take precedence over generic command steps')
    expect(skill).toContain('Missing optional keys in older STATE.md mean `off` for modes and `-` for `profile` and `runLanguage`')
    expect(PHASE_SKILL_MAP.flatMap(({ skills }) => skills)).not.toContain('profile-pilot')
  })
})

describe('profile skills', () => {
  const profiles = [
    {
      name: 'profile-design',
      minRubric: 6,
      ids: ['goal-and-fantasy', 'core-loop', 'systems-and-dependencies', 'economy-balance', 'risks', 'kpis', 'numbers-consistent'],
      defaults: ['game-designer-systems', 'game-designer-balance', 'game-director'],
    },
    {
      name: 'profile-plan',
      minRubric: 4,
      ids: ['objective', 'milestones-and-dependencies', 'owners-and-capacity', 'risks'],
      defaults: ['project-manager'],
    },
    {
      name: 'profile-content',
      minRubric: 4,
      ids: ['audience', 'message', 'voice', 'cta'],
      defaults: ['creative-brief'],
    },
  ] as const
  const EXTERNAL_DEFAULT_SKILLS = new Set([
    'game-designer-systems', 'game-designer-balance', 'game-director', 'project-manager',
  ])
  const c2Headings = ['## Definition of done', '## Rubric', '## Default skills', '## Evidence', '## Sampling']
  const lintHeadings = ['## Core method', '## Failure modes', '## Reviewer checklist', '## Provenance']

  test.each(profiles)('$name satisfies C2 and lint contracts', ({ name, minRubric, ids, defaults }) => {
    const skill = readText(path.join(SKILLS_DIR, name, 'SKILL.md'))
    const rubric = skill.slice(skill.indexOf('## Rubric'), skill.indexOf('## Default skills'))
    const rubricIds = [...rubric.matchAll(/^- `([^`]+)` —/gm)].map((match) => match[1])

    for (const heading of [...c2Headings, ...lintHeadings]) expect(skill).toContain(heading)
    expect(rubricIds.length).toBeGreaterThanOrEqual(minRubric)
    for (const id of ids) expect(rubricIds).toContain(id)
    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(6_000)
    expect(skill).toContain('A command that echoes its own constant is forbidden')
    expect(skill).toContain('params.csv')
    expect(PHASE_SKILL_MAP.flatMap(({ skills }) => skills)).not.toContain(name)
    for (const defaultSkill of defaults) {
      expect(
        existsSync(path.join(SKILLS_DIR, defaultSkill, 'SKILL.md'))
          || EXTERNAL_DEFAULT_SKILLS.has(defaultSkill),
      ).toBe(true)
    }
  })
})

describe('T5 environment guidance and contradiction guards', () => {
  test('preflight distinguishes connect failures and mode-only noise', () => {
    const skill = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('a connect timeout or closed connection is not "server missing"')
    expect(skill).toContain('run `node scripts/doctor.mjs --probe-launcher`')
    expect(skill).toContain('reconnect with `/mcp`, re-check health, and only then offer the Executor fallback')
    expect(skill).toContain('git -c core.fileMode=false status --porcelain` is empty')
    expect(skill).toContain('mode-only noise')
    expect(skill).toContain('offer `git config core.fileMode false` instead of commit/stash')
    expect(skill).not.toContain('equal blob ids')
  })

  test('parallel execution performs the worktree canary before wave 1', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('Before wave 1, run `git worktree add --detach <tmp> HEAD`, then `git worktree remove --force <tmp>`')
    expect(skill).toContain('set `executionMode` to `sequential (worktrees unavailable: <error>)`')
    expect(skill).toContain('flow-state.mjs" set executionMode')
    expect(skill).toContain('never discover this mid-wave')
    expect(skill).toContain('worktree canary fails')
  })

  test('fallback reruns task checks each round and the suite only in whole-feature review', () => {
    const skill = readText(EXECUTOR_FALLBACK_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain("re-run the task's acceptance checks after every round")
    expect(skill).toContain('the full suite runs once in the whole-feature review')
    expect(skill).not.toContain('re-run the acceptance checks and the suite after every round')
  })

  test('review feedback defines severity routing and durable clean handoff', () => {
    const skill = readText(path.join(REPO_ROOT, 'skills', 'review-feedback', 'SKILL.md')).replace(/\s+/g, ' ')

    expect(skill).toContain('MEDIUM/LOW piggyback only on a round already being sent for CRITICAL/HIGH')
    expect(skill).toContain('otherwise record them in `.codex-flow/IMPROVEMENTS.md`')
    expect(skill).toContain('proceed to the Phase 5 step 7 durable handoff, where `done` is the last write')
    expect(skill).not.toContain('MEDIUM/LOW piggyback only.')
    expect(skill).not.toContain('Clean review → mark the task done')
  })

  test('dual review repeats the MEDIUM/LOW piggyback clarification', () => {
    const skill = readText(REVIEW_DUAL_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('MEDIUM/LOW piggyback only on a round already being sent for CRITICAL/HIGH')
    expect(skill).toContain('otherwise record them in `.codex-flow/IMPROVEMENTS.md`')
    expect(skill).not.toContain('CRITICAL/HIGH always; MEDIUM/LOW piggyback only).')
  })

  test('command-side T1 step references remain corrected', () => {
    const command = readText(COMMAND_PATH)
    const phase0 = extractPhaseSection(command, 0).replace(/\s+/g, ' ')
    const phase5 = extractPhaseSection(command, 5).replace(/\s+/g, ' ')

    expect(phase0).toContain('create STATE.md with')
    expect(phase0).not.toContain('`codex-flow:preflight` Step 4')
    expect(phase5).not.toContain('collect its result in step 5')
    expect(phase5).not.toContain('directly at step 5')
    expect(phase5).toContain('collect its result in step 4')
  })
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

  test('documents which fields a non-task event block must carry', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)
    const normalized = skill.replace(/\s+/g, ' ')
    expect(normalized).toContain(
      'A non-task event block must carry the first four fields; `Anchor` and `Applies to` are required only in task blocks.',
    )
  })

  test('tells writers to scope decisions and marks run-wide constraints as all', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)

    expect(skill).toContain('Writers SHOULD fill `Applies to`; run-wide constraints use `all`.')
  })

  test('tells the Decision-log writer to check each appended block', () => {
    const skill = readText(PLAN_ARCHITECTURE_PATH)
    const writer = skill.slice(skill.indexOf('The ONLY per-task writer'), skill.indexOf('## Design principles'))
    expect(writer).toContain('--check-plan')
  })
})

describe('preflight resume protocol', () => {
  test('documents the single-operator no-lock journal limit', () => {
    const skill = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')
    expect(skill).toContain(
      'The helper takes no file lock and assumes one orchestrator writes STATE.md and the journal; parallel workers never do.',
    )
  })

  test('documents that resume resets task selectors outside execution', () => {
    // Arrange
    const normalizedSkill = readText(PREFLIGHT_PATH).replace(/\s+/g, ' ')

    // Act / Assert
    expect(normalizedSkill).toContain(
      'A resume writes `resumeHead` and `phase`; outside `execution`, it resets `currentTask`, `taskStage`, and `wave',
    )
    expect(normalizedSkill).not.toContain('updates `phase` as its resume operation')
  })

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
      'profile',
      'profileMode',
      'evidenceMode',
      'languageMode',
      'runLanguage',
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

    expect(skill).toContain('requirement-delta`, which sets `requirementsApproved` to `yes (delta <date>)`')
    expect(skill).toContain('resets `planApproved` and `backlogApproved` to `no (delta <date>)`')
    expect(skill).toContain('returns `phase` to `plan`')
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
    expect(skill).toContain('worktree-setup.mjs" --worktree <worktree> --task T<n>')
  })

  test('generates the task slice before copying all control files into the worktree', () => {
    const skill = readText(PARALLEL_EXECUTION_PATH)
    const sliceCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>'

    const copyBlock = extractFencedCodeBlockContaining(skill, 'bash', 'worktree-setup.mjs')
    const setupCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.mjs" --worktree <worktree> --task T<n>'

    expect(copyBlock.indexOf(sliceCommand)).toBeGreaterThanOrEqual(0)
    expect(copyBlock.indexOf(sliceCommand)).toBeLessThan(copyBlock.indexOf(setupCommand))
    expect(skill).toContain('PLAN.md and TASKS.md')
    expect(skill).toContain('CONTEXT-T<n>.md')
  })

  test('stops on helper failure and splits mandatory-over-budget tasks before copying', () => {
    // Arrange
    const skill = readText(PARALLEL_EXECUTION_PATH).replace(/\s+/g, ' ')

    // Act
    const oversizedTaskRule = skill.includes(
      'If generation reports `mandatory slice content exceeds tokenBudget`, split the oversized task in the backlog and recompute the waves before continuing; never raise the slice budget.',
    )

    // Assert
    expect(skill).toContain('If either command exits non-zero, surface the error and do NOT dispatch the subagent.')
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
    const invalidationIndex = skill.indexOf('flow-state.mjs" plan-drift')
    const filesUpdateIndex = skill.indexOf("update the task's `Files:` in TASKS.md")
    const restorationIndex = skill.indexOf('approve backlog')
    const expandedReviewIndex = skill.indexOf("RE-RUN the task's conformance → quality → security review over the EXPANDED `Files:` scope")

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(filesUpdateIndex)
    expect(restorationIndex).toBeGreaterThan(filesUpdateIndex)
    expect(expandedReviewIndex).toBeGreaterThan(restorationIndex)
    expect(skill).toContain('advance` to restore execution')
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
    expect(normalizedStep7d).toContain('brief → author → lint → independent review → one batched approval')
    expect(normalizedStep7d).toContain('mcp__codex__codex_review')
    expect(normalizedStep7d).toContain('lint result')
    expect(normalizedStep7d).toContain('unverified: n/total')
    expect(normalizedStep7d).toContain('reviewer verdict')
    expect(normalizedStep7d).toContain('quarantine/authored')
    expect(normalizedStep7d.indexOf('independent review')).toBeLessThan(
      normalizedStep7d.indexOf('one batched AskUserQuestion'),
    )
    expect(normalizedStep7d.indexOf('PASS')).toBeLessThan(
      normalizedStep7d.indexOf('one batched AskUserQuestion'),
    )
    expect(normalizedStep7d).not.toMatch(/(?:^|[.!?]\s)Present(?:[.!?]|$)/)
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
    expect(skillSelection).toContain('brief → author → lint → independent review → one batched approval')
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
    expect(skillSelection).toContain('brief → author → lint → independent review → one batched approval')
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
  test('pins the profile router hook and resume routing rule', () => {
    const routerSection = extractFastPathSection(readText(COMMAND_PATH)).replace(/\s+/g, ' ')

    expect(routerSection).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/profile-router.mjs" resolve --profile <p> '
        + '--request-file <path> --run-id <report dir name>',
    )
    expect(routerSection).toContain('Full flow only (not fast-path lanes): after the Fast-path gate selects full flow')
    expect(routerSection).toContain(
      '`<path>` is a temp file outside the workspace holding the user\'s task (e.g. via `mktemp`); '
        + '`<report dir name>` is the session-start `<YYYYMMDD-HHMMSS>` used for step 4\'s report dir.',
    )
    expect(routerSection).toContain(
      'Load `codex-flow:profile-pilot` when `profileMode` is `enforce`, `evidenceMode` is not `off`, '
        + 'or `languageMode` is `on`',
    )
    expect(routerSection).toContain(
      'On resume, do not re-run the router: read `profile`, `profileMode`, `evidenceMode`, '
        + '`languageMode`, `runLanguage` from STATE.md (missing legacy keys mean `off` modes and '
        + '`-` profile/runLanguage) and apply the same load rule.',
    )
  })

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
    [1, 'approve requirements', 'advance'],
    [2, 'approve plan --at <grant time>', 'advance'],
    [3, 'approve backlog', 'advance'],
  ])('records Phase %i approval and advances run state', (phaseNumber, approvalCommand, advanceCommand) => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), phaseNumber)

    expect(phaseSection).toContain(approvalCommand)
    expect(phaseSection).toContain(advanceCommand)
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

    expect(phaseSection).toContain('run `flow-state requirement-delta`')
    expect(phaseSection).toContain('resets plan/backlog approval and sets phase plan')
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
    const invalidationIndex = phaseSection.indexOf('flow-state plan-drift')
    const impactIndex = phaseSection.indexOf('impact analysis listing which done and pending tasks')
    const tasksIndex = phaseSection.indexOf('update the affected\n   TASKS.md')
    const lintIndex = phaseSection.indexOf('requirements-coverage.mjs', tasksIndex)
    const approvalIndex = phaseSection.indexOf('get backlog re-approval', lintIndex)
    const restorationIndex = phaseSection.indexOf('flow-state approve backlog', approvalIndex)

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(impactIndex)
    expect(impactIndex).toBeGreaterThanOrEqual(0)
    expect(tasksIndex).toBeGreaterThan(impactIndex)
    expect(lintIndex).toBeGreaterThan(tasksIndex)
    expect(approvalIndex).toBeGreaterThan(lintIndex)
    expect(restorationIndex).toBeGreaterThan(approvalIndex)
    expect(phaseSection).toContain('flow-state plan-drift')
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
    const invalidationIndex = stepNine.indexOf('flow-state improvement-gate')
    const appendIndex = stepNine.indexOf('approved items into new tasks appended to `.codex-flow/TASKS.md`')
    const approvalIndex = stepNine.indexOf('get backlog re-approval')
    const restorationIndex = stepNine.indexOf('flow-state approve backlog', approvalIndex)

    expect(invalidationIndex).toBeGreaterThanOrEqual(0)
    expect(invalidationIndex).toBeLessThan(appendIndex)
    expect(approvalIndex).toBeGreaterThan(appendIndex)
    expect(restorationIndex).toBeGreaterThan(approvalIndex)
    expect(stepNine).toContain('flow-state approve backlog')
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
      'If `codex_continue` fails because the recorded session is gone (expired or compacted), fall back to a fresh `codex_execute` fix task that embeds the finding text plus the task\'s `.codex-flow/CONTEXT-T<n>.md` slice; never hand-edit Codex\'s code (the only exception is the after-3-rounds hand-fix in Rules).',
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
    expect(phase0).toContain('connect timeout or closed connection is not "server missing"')
    expect(phase0).toContain('reconnect with `/mcp`')
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
    expect(section).toContain('Keep the 3-round cap')
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
    expect(phase5).toContain('If the Agent tool is unavailable, call `mcp__codex__codex_review` directly at step 4 instead (sequential fallback).')
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
    expect(phase5).toContain('`flow-state advance` moves `execution → review`; repeat after improvement tasks')
    expect(command).not.toContain('At the Phase 4 → Phase 5 boundary, set `phase` in `.codex-flow/STATE.md` to `review`.')
  })

  test('task status writes route through the helper and fail closed', () => {
    expect(phase4).toContain(`${helper} task T<n> in-progress`)
    expect(phase4).toContain('`flow-state set currentTask T<n>` and `flow-state set taskStage launching`')
    expect(phase4).toContain('once the call is dispatched, run `flow-state set taskStage executing`')
    expect(phase4).toContain(`${helper} task T<n> failed`)
    expect(phase4).toContain(`${helper} set wave <n>`)
    // T9 retarget: the command now names the key count and defers the literal key list to
    // preflight Step 3.4; the "edit the file directly" escape hatch is forbidden by R1.2.
    expect(phase0).toContain('create STATE.md with')
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

describe('T6 command uses kernel commands', () => {
  const command = readText(COMMAND_PATH)
  const normalized = command.replace(/\s+/g, ' ')

  test('uses typed flow-state transitions and rejects legacy setters', () => {
    expect(normalized).toContain('flow-state init --baseline')
    expect(normalized).toContain('approve requirements')
    expect(normalized).toContain('approve plan')
    expect(normalized).toContain('approve backlog')
    expect(normalized).toContain('requirement-delta')
    expect(normalized).toContain('plan-drift')
    expect(normalized).toContain('improvement-gate')
    expect(normalized).toContain('resume --head')
    expect((normalized.match(/flow-state advance/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(normalized).not.toContain('set phase')
    expect(normalized).not.toContain('set requirementsApproved')
    expect(normalized).not.toContain('set planApproved')
    expect(normalized).not.toContain('set backlogApproved')
    expect(normalized).not.toContain('"$PWD"')
  })

  test('keeps typed transitions runnable and Phase 0 routing consistent', () => {
    const transitionText = normalized.replace(/`phase` and the three approvals change only through `approve`, `advance`, `requirement-delta`, `plan-drift`, `improvement-gate`, and `resume`\./, '')
    expect(transitionText).not.toMatch(/`(advance|requirement-delta|plan-drift|improvement-gate|approve (requirements|plan|backlog)[^`]*)`/)
    expect((command.match(/The orchestrator is the only writer\./g) ?? []).length).toBe(1)
    expect(normalized).toContain('doctor.mjs --probe-launcher')
    expect(command).toContain('flow-state approve backlog --checkpoint-commits <yes|no> --execution-mode "<mode>"')
    expect(command).not.toMatch(/flow-state\.mjs"[^`]*\n[^`]*`/)
  })

  test('routes outages and reports session cost with session identities', () => {
    expect(normalized).toContain('connect timeout or closed connection')
    expect(normalized).toContain('reconnect with `/mcp`')
    expect(normalized).toContain('Never continue silently')
    expect(normalized).toContain('--session')
    expect(normalized).toContain('every `Codex review session:` id recorded in `reviews.md`')
    expect(normalized).toContain('use `--cwd <project root>` only when no session id exists')
  })

  test('guards whole-feature completion and supporting documentation', () => {
    expect(normalized).toContain('run `flow-state advance` until `phase: complete`')
    expect(normalized).toContain('repeat after improvement tasks')
    expect(readText(path.join(REPO_ROOT, 'AGENTS.md'))).toContain('create STATE.md with `init`')
    const agents = readText(path.join(REPO_ROOT, 'AGENTS.md'))
    for (const command of ['approve', 'advance', 'requirement-delta', 'plan-drift', 'improvement-gate', 'resume']) {
      expect(agents).toContain(command)
    }
    expect(agents).not.toContain('(`set` / `check` / `task`) — the helper is')
    expect(readText(README_PATH)).not.toContain('10-key run state')
    expect(command).not.toContain('then approval, then')
    expect(command).not.toContain('`.\n   adding `--dirty-baseline')
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

  test('the canonical fail-closed sentence appears once before Phase 0 in the command', () => {
    // Arrange
    const command = readText(COMMAND_PATH)

    // Act
    const commandOccurrences = command.split(CANONICAL_FAIL_CLOSED_SENTENCE).length - 1
    const phaseZeroIndex = command.indexOf('## Phase 0')
    const sentenceIndex = command.indexOf(CANONICAL_FAIL_CLOSED_SENTENCE)

    // Assert
    expect(commandOccurrences).toBe(1)
    expect(sentenceIndex).toBeGreaterThanOrEqual(0)
    expect(sentenceIndex).toBeLessThan(phaseZeroIndex)
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
  /**
   * LF-normalized byte count, matching the repo's readText convention: a Windows
   * checkout with CRLF line endings must measure the same as a POSIX one, so the
   * budgets describe the document, not the checkout's line-ending style.
   */
  function byteLength(filePath: string): number {
    return Buffer.byteLength(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'))
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

  test('the command stays within the T6 byte limit', () => {
    // Arrange
    const bytes = byteLength(COMMAND_PATH)

    // Assert
    expect(bytes).toBeLessThanOrEqual(43_150)
  })

  test('the command stays within the T1 byte limit', () => {
    // Arrange
    const bytes = byteLength(COMMAND_PATH)

    // Assert
    expect(bytes).toBeLessThanOrEqual(43_948)
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
    expect(flowSkills).toHaveLength(21)
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

describe('brainstorm command contract (five thinking phases)', () => {
  const lfBytes = (filePath: string) =>
    Buffer.byteLength(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'))
  const BRAINSTORM_LENSES_SKILL_PATH = path.join(SKILLS_DIR, 'brainstorm-lenses', 'SKILL.md')
  const BRAINSTORM_LENSES_SKILL_MAX_BYTES = 10_000
  const PHASE_HEADINGS = [
    '## Frame — understand the question (Claude)',
    '## Map — model the system independently (Claude, then Codex)',
    '## Reason — build and test the argument (Claude ⇄ Codex, 1–3 rounds)',
    '## Feasibility — can it be done (Codex, one turn)',
    '## Decide — ratify the analysis (Claude)',
  ] as const
  const COMMAND_FORBIDDEN = [
    'PDCA',
    'Plan, Do, Check, Act',
    'DECISION.md',
    '## Handoff',
    'rollout',
    'rollback',
    'sign-off',
    'signoff',
    'K1..K5',
    'flow-state.mjs',
    'workspace-write',
    'danger-full-access',
    '`verifyCommand`: `',
    'fall back',
    'continue without',
  ] as const
  const phaseSlice = (command: string, heading: string): string => {
    const start = command.indexOf(`## ${heading}`)
    const next = command.indexOf('\n## ', start + 1)
    return command.slice(start, next === -1 ? command.length : next)
  }

  test('keeps the Claude command mirror byte-identical', () => {
    // Arrange
    const command = readFileSync(BRAINSTORM_COMMAND_PATH)
    const mirror = readFileSync(BRAINSTORM_CLAUDE_COMMAND_PATH)

    // Assert
    expect(command.equals(mirror)).toBe(true)
  })

  test('resolves every referenced skill token to an existing SKILL.md', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const tokens = [...new Set(command.match(/codex-flow:[A-Za-z0-9-]+/g) ?? [])]

    // Act
    const malformed = tokens.filter((token) => !/^codex-flow:[a-z0-9-]+$/.test(token))
    const missing = tokens
      .map((token) => token.slice('codex-flow:'.length))
      .filter((skillName) => !existsSync(path.join(SKILLS_DIR, skillName, 'SKILL.md')))

    // Assert
    expect(malformed).toEqual([])
    expect(missing).toEqual([])
    expect(tokens).toContain('codex-flow:brainstorm-debate')
    expect(tokens).toContain('codex-flow:brainstorm-lenses')
    expect(tokens).toContain('codex-flow:brainstorm-argumentation')
  })

  test('names all three brainstorm skills inside a Load skills first line', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain(
      '**Load skills first**: `codex-flow:brainstorm-debate`, ' +
        '`codex-flow:brainstorm-lenses`, `codex-flow:brainstorm-argumentation`, and `codex-flow:run-ledger`',
    )
  })

  test('stays under its own byte budgets', () => {
    expect(lfBytes(BRAINSTORM_COMMAND_PATH)).toBeLessThanOrEqual(BRAINSTORM_COMMAND_MAX_BYTES)
    expect(lfBytes(BRAINSTORM_SKILL_PATH)).toBeLessThanOrEqual(BRAINSTORM_SKILL_MAX_BYTES)
    expect(lfBytes(BRAINSTORM_LENSES_SKILL_PATH)).toBeLessThanOrEqual(
      BRAINSTORM_LENSES_SKILL_MAX_BYTES,
    )
  })

  test('carries the five thinking phases in order and exactly five headings', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const headings = command.match(/^## .+$/gm) ?? []

    // Assert
    expect(headings).toEqual(PHASE_HEADINGS)
  })

  test('pins the exact description and title', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH)

    expect(command).toContain(
      'description: "Systems-thinking brainstorm: frame the question, map the system independently with Codex, reason through a two-way debate, check feasibility, deliver a ratified analysis — no code is written"',
    )
    expect(command).toContain('# Codex Brainstorm — Frame, Map, Reason, Feasibility, Decide')
  })

  test('runs every Codex call read-only and omits forbidden execution parameters', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)

    // Assert
    expect(command).toContain('`sandbox`: `read-only`')
    expect(command).not.toMatch(/workspace-write|danger-full-access/)
    expect(command).not.toContain('flow-state.mjs')
    expect(command).not.toMatch(/verifyCommand`: `/)
  })

  test('starts a fresh Codex session per Astra turn and reserves codex_continue for json re-obtain', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('Start a **fresh** session per Astra turn')
    expect(command).toContain('`mcp__codex__codex_continue` is used only for the json re-obtain step')
  })

  test('parses Astra output through the fail-closed helper for map, rounds, and feasibility', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const skill = readText(BRAINSTORM_SKILL_PATH)

    // Assert
    expect(command).toContain('debate-parse.mjs --kind map')
    expect(command).toContain('debate-parse.mjs --kind round --round <n>')
    expect(command).toContain('debate-parse.mjs --kind feasibility')
    expect(skill).toContain('### Map turn')
    expect(skill).toContain('### Reason turn')
    expect(skill).toContain('### Feasibility turn')
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/debate-parse.mjs" --kind round --round <n> --file <path>')
    expect(skill).toContain('Never reconstruct an entry from the prose.')
    expect(skill).toContain('If the helper is not found, STOP and tell the user to reinstall the')
    expect(skill).toContain('Exit 1')
    expect(skill).toContain('Exit 2')
    expect(skill).toContain('UNVERIFIED')
    expect(skill).toContain('UNVERIFIED: <droppedReason or parseError>')
  })

  test('embeds matching Reason and Feasibility lens blocks in Astra prompts', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('followed by the Reason turn block and the Reason lens block')
    expect(command).toContain('followed by the Feasibility turn block and the Feasibility lens block')
    expect(command).toContain("Embed the matching turn block and lens block verbatim in every Astra prompt; Codex cannot read Claude's skills.")
  })

  test('creates brainstorm parent directories before the unique leaf', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('Create the parent directories `.codex-flow/brainstorm/` and `.codex-flow/notes/` when missing; create the leaf without `-p` on the leaf')
    expect(command).toContain('append `-2`, `-3`, … and never reuse a directory')
  })

  test('keeps the removed protocol terms out of the skill', () => {
    const skill = readText(BRAINSTORM_SKILL_PATH)
    const forbidden = [
      'signoff',
      'sign-off',
      'PDCA',
      'K1..K5',
      'integer weights',
      'FRAMING',
      'Alternative:',
      'DECISION.md',
    ] as const

    for (const phrase of forbidden) {
      expect(skill).not.toContain(phrase)
    }
  })

  test('parses each turn example for map, rounds 1 through 3, and feasibility', async () => {
    const skill = readText(BRAINSTORM_SKILL_PATH)
    const extractJsonLine = (heading: string): string => {
      const start = skill.indexOf(`### ${heading}`)
      const next = skill.indexOf('\n### ', start + 1)
      const section = skill.slice(start, next === -1 ? skill.length : next)
      const jsonLine = section.split('\n').find((line) => line.startsWith('{') && line.endsWith('}'))
      if (jsonLine === undefined) throw new Error(`missing JSON example for ${heading}`)
      return jsonLine
    }
    const asJsonFence = (jsonLine: string): string => `\`\`\`json\n${jsonLine}\n\`\`\``

    // @ts-expect-error — plain .mjs script
    const { parseDebateOutput } = await import('../scripts/debate-parse.mjs')

    const map = parseDebateOutput(asJsonFence(extractJsonLine('Map turn')), { kind: 'map' })
    const feasibility = parseDebateOutput(
      asJsonFence(extractJsonLine('Feasibility turn')),
      { kind: 'feasibility' },
    )

    expect(map.parsed).toBe(true)
    expect(map.dropped).toBe(0)
    expect(feasibility.parsed).toBe(true)
    expect(feasibility.dropped).toBe(0)

    for (const round of [1, 2, 3]) {
      const roundJson = extractJsonLine('Reason turn').replace('<n>', String(round))
      const parsed = parseDebateOutput(asJsonFence(roundJson), { kind: 'round', round })

      expect(parsed.parsed).toBe(true)
      expect(parsed.dropped).toBe(0)
    }
  })

  test('pins the Reason turn order and parser fields', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const reasonStart = skill.indexOf('### Reason turn')
    const feasibilityStart = skill.indexOf('### Feasibility turn')
    const reason = skill.slice(reasonStart, feasibilityStart)

    // Assert
    const turnOrder = [
      'steelman → counter-thesis (round 1; later rounds keep or revise) → contributions',
      ' → challenges (each names a Toulmin target, scheme, and cq) → violations (each names PD<k>) → json',
    ].join('')
    expect(reason).toContain(turnOrder)
    expect(reason).toContain('In round 1, answer every Map conflict listed in the prompt.')
    expect(reason).toContain('Use only NEW, HOLD, or CONCEDE for challenge status.')
  })

  test('pins the two-way steelman response protocol', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const responseStart = skill.indexOf("## Fable's response format")
    const mapStart = skill.indexOf('## Map critique', responseStart)
    const response = skill.slice(responseStart, mapStart)

    // Assert
    expect(response).toContain('FAITHFUL | UNFAITHFUL')
    expect(response).toContain('STRAW-MAN')
    expect(response).toContain('Steelman the counter-thesis before answering it element by element')
  })

  test('pins Map and Feasibility critique sections', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const mapStart = skill.indexOf('## Map critique')
    const evidenceStart = skill.indexOf('## Evidence rules')
    const critiques = skill.slice(mapStart, evidenceStart)

    // Assert
    expect(critiques).toContain('## Map critique')
    expect(critiques).toContain('## Feasibility critique')
    expect(critiques).toContain('Write the critique in MAP.md under `## Map critique`')
    expect(critiques).toContain('Write the critique in REASON.md under `## Feasibility critique`')
    expect(critiques).toContain(
      '<field> ACCEPT | REBUT | REFINE — <Toulmin element> — <evidence>',
    )
    expect(critiques).toContain('Put every map conflict into the round-1 Reason prompt')
    expect(critiques).toContain('Copy disagreements still open to ANALYSIS.md `## Open questions` at Decide')
  })

  test('pins both C-LEDGER headers and status rules', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const ledgerStart = skill.indexOf('## Standpoint ledger')
    const stopStart = skill.indexOf('## Stop rule')
    const ledgers = skill.slice(ledgerStart, stopStart)

    // Assert
    expect(ledgers).toContain('| Id | Standpoint | Owner | Status | Crux | Evidence |')
    expect(ledgers).toContain('| Id | Assumption | Held by | Importance | Certainty | Evidence |')
    expect(ledgers).toContain('MAINTAINED | RETRACTED | UNRESOLVED')
    expect(ledgers).toContain('Importance and Certainty only to high | low')
  })

  test('pins challenge disposition to standpoint status mapping', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const ledgerStart = skill.indexOf('## Standpoint ledger')
    const assumptionStart = skill.indexOf('## Assumption register')
    const ledger = skill.slice(ledgerStart, assumptionStart)
    const mapping = [
      'Map dispositions to standpoints: a challenge Fable REBUTs and Astra later CONCEDEs leaves its',
      ' standpoint MAINTAINED; a challenge Fable ACCEPTs retracts or revises the standpoint (RETRACTED,',
      ' or a revised standpoint with a new SP id); a challenge still NEW or HOLD at the stop leaves the',
      ' standpoint UNRESOLVED with a Crux; a STRAW-MAN challenge changes nothing; an ADOPTed contribution',
      ' adds or revises a standpoint.',
    ].join('')

    // Assert
    expect(ledger).toContain(mapping)
  })

  test('pins two-sided violation recording', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const violationsStart = skill.indexOf('## Violations')
    const evidenceStart = skill.indexOf('## Evidence rules')
    const violations = skill.slice(violationsStart, evidenceStart)

    // Assert
    expect(violations).toContain('Astra reports Fable\'s violations in the json `violations` array')
    expect(violations).toContain('Fable records Astra\'s violations as `V<n>` with `PD<k>`')
    expect(violations).toContain('List both in REASON.md under the round')
    expect(violations).toContain('affected standpoint\'s Evidence column cites the `V<n>` id')
    expect(violations).toContain('A sustained PD3 violation is the STRAW-MAN case.')
  })

  test('pins the C-STOP convergence rule', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const stop = skill.slice(skill.indexOf('## Stop rule'))

    // Assert
    expect(stop).toContain('Converged when no standpoint is UNRESOLVED without a Crux.')
    expect(stop).toContain('severity only orders work')
  })

  test('keeps forbidden command wording out of the command', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH)

    for (const phrase of COMMAND_FORBIDDEN) {
      expect(command).not.toContain(phrase)
    }
  })

  test('follows the auth-aware model rule and payload contract', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('`model`: only when `authMode` is `apikey`, otherwise omit it')
    expect(command).toContain('when the field is absent, treat it as `chatgpt`')
    expect(command).toContain('`cwd`: the absolute project root')
    expect(command).toContain('`reasoningEffort`: `high`')
    expect(command).toContain('`timeoutMs`: 20 minutes per attempt')
    expect(command).toContain('`terminal`: `true`')
    expect(command).toContain('Never pass a `model` override under ChatGPT auth')
  })

  test('ratifies the analysis explicitly and never hands off while PROPOSED', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('`Status: PROPOSED`')
    expect(command).toContain('Nothing is handed off while `PROPOSED`.')
    expect(command).toContain('`ACCEPTED`')
    expect(command).toContain('`REJECTED`')
    expect(command).toContain('accept / amend / reject / one more round')
    expect(command).toContain('/codex-flow <topic> — start from <run dir>/ANALYSIS.md')
  })

  test('writes the eight ANALYSIS sections in contract order', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')
    const decidePhase = command.slice(command.indexOf('## Decide —'))
    const sections = [
      '## Reframed question',
      '## System map',
      '## Reasoning',
      '## Agreements and disagreements',
      '## Recommendation',
      '## Feasibility',
      '## Open questions',
      '## Sources',
    ]

    const positions = sections.map((section) => decidePhase.indexOf(section))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('enforces single-model labelling and the health-outage procedure', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('never present a single-model run as a two-model debate')
    expect(command).toContain('Read `status` first')
    expect(command).toContain('one AskUserQuestion per outage')
    expect(command).toContain('retry once (first outage only), continue single-model, or stop and decide from completed turns')
  })

  test('writes the durable brainstorm log line in the documented format', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH)

    expect(command).toContain(
      '`<ISO 8601> <one-line topic> rounds=<n> flips=<n> blockers=<n> feasibility=<verdict> mode=<two-model|single-model> status=<accepted|rejected|parked> dir=<run dir>`',
    )
  })

  test('the skill defines the stop rule and transcript budget', () => {
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('Minimum 1 round, cap 3')
    expect(skill).toContain('Never run a fourth round.')
    expect(skill).toContain('exceeds 6 000 estimated tokens')
    expect(skill).toContain('| Id | Standpoint | Owner | Status | Crux | Evidence |')
  })

  test('keeps the Map independent and makes Divergence the Reason input', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const mapStart = command.indexOf('## Map —')
    const reasonStart = command.indexOf('## Reason —', mapStart)
    const mapPhase = command.slice(mapStart, reasonStart).replace(/\s+/g, ' ')
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Assert
    expect(mapPhase).toContain('Write `MAP.md` with `## Fable map` before the Astra call')
    expect(mapPhase).toContain('The Map prompt names no run-dir file except FRAME.md.')
    expect(mapPhase).not.toContain('REASON.md')
    expect(mapPhase).toContain('This divergence is the input of Reason')
    expect(skill).toContain('Apply the Map lens block from codex-flow:brainstorm-lenses.')
    expect(skill).toContain("Fable's map is never shown to you.")
  })

  test('routes Map critique conflicts into the first Reason prompt', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const mapPhase = phaseSlice(command, 'Map —').replace(/\s+/g, ' ')

    // Assert
    expect(mapPhase).toContain(
      'After `## Divergence`, Fable writes `## Map critique` per the skill and carries every map ' +
        'conflict into the round-1 Reason prompt',
    )
  })

  test('keeps the Map run-file fixture scoped to FRAME.md and MAP.md', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const mapPhase = phaseSlice(command, 'Map —')

    // Act
    const fixture = mapPhase.replace(/\s+/g, ' ')

    // Assert
    expect(fixture).toContain('only the absolute path of the run dir\'s `FRAME.md`')
    expect(fixture).toContain('Append the raw Astra answer verbatim under `## Astra map` in `MAP.md`')
    expect(fixture).toContain('debate-parse.mjs --kind map')
  })

  test('keeps the Reason run-file fixture on all three inputs and round output', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const reasonPhase = phaseSlice(command, 'Reason —')

    // Act
    const fixture = reasonPhase.replace(/\s+/g, ' ')

    // Assert
    expect(fixture).toContain('`FRAME.md`, `MAP.md`, and `REASON.md`')
    expect(fixture).toContain('append the raw answer verbatim under the round in `REASON.md`')
    expect(fixture).toContain('debate-parse.mjs --kind round --round <n>')
  })

  test('embeds the Debate block in every Reason prompt', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const reasonPhase = phaseSlice(command, 'Reason —').replace(/\s+/g, ' ')

    // Assert
    expect(reasonPhase).toContain(
      'followed by the Reason turn block and the Reason lens block; the Debate block is also embedded ' +
        'verbatim',
    )
  })

  test('pins Map conflicts and all blocks in the round-1 Reason prompt', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const mapPhase = phaseSlice(command, 'Map —').replace(/\s+/g, ' ')
    const reasonPhase = phaseSlice(command, 'Reason —').replace(/\s+/g, ' ')

    // Act
    const conflictRule = 'carries every map conflict into the round-1 Reason prompt'

    // Assert
    expect(mapPhase).toContain(conflictRule)
    expect(reasonPhase).toContain('In round 1, include every Map critique conflict in the prompt')
    expect(reasonPhase).toContain('followed by the Reason turn block and the Reason lens block')
    expect(reasonPhase).toContain('the Debate block is also embedded verbatim')
  })

  test('updates the ledger and register for each Reason round', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const reasonPhase = phaseSlice(command, 'Reason —').replace(/\s+/g, ' ')

    // Assert
    expect(reasonPhase).toContain(
      "For Fable's answer, update the standpoint ledger and assumption register each round, and " +
        "stop per the skill's stop rule",
    )
  })

  test('keeps the Feasibility run-file fixture on all three inputs and both outputs', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const feasibilityPhase = phaseSlice(command, 'Feasibility —')

    // Act
    const fixture = feasibilityPhase.replace(/\s+/g, ' ')

    // Assert
    expect(fixture).toContain('the absolute paths of the run dir\'s `FRAME.md`, `MAP.md`, and `REASON.md`')
    expect(fixture).toContain('record the verdict as `UNVERIFIED` in `ANALYSIS.md` `## Feasibility`')
    expect(fixture).toContain('debate-parse.mjs --kind feasibility')
  })

  test('routes Feasibility critique and remaining disagreements to Open questions', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)
    const feasibilityPhase = phaseSlice(command, 'Feasibility —').replace(/\s+/g, ' ')

    // Assert
    expect(feasibilityPhase).toContain(
      'After the Astra turn, Fable writes `## Feasibility critique` per the skill and puts remaining ' +
        'disagreements in `## Open questions`',
    )
  })

  test('keeps the skill run-file matrix aligned with the command fixtures', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    // Act
    const rows = [
      '| Map | FRAME.md | MAP.md `## Astra map`, MAP.md `## Map critique` |',
      '| Reason | FRAME.md, MAP.md, REASON.md | REASON.md round |',
      '| Feasibility | FRAME.md, MAP.md, REASON.md | ' +
        'REASON.md Feasibility turn, REASON.md `## Feasibility critique`; ' +
        'ANALYSIS.md `## Feasibility` |',
    ] as const

    // Assert
    for (const row of rows) expect(skill).toContain(row)
  })

  test('keeps the skill turn blocks and run-file matrix in order', () => {
    // Arrange
    const skill = readText(BRAINSTORM_SKILL_PATH)

    // Act
    const positions = [
      '## Standards block',
      '### Map turn',
      '### Reason turn',
      '### Feasibility turn',
      '## Run files per turn',
      '## Parse every Astra output fail-closed',
    ].map((heading) => skill.indexOf(heading))

    // Assert
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })

  test('pins Decide routing and verbatim dissent handling', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')
    const decidePhase = command.slice(command.indexOf('## Decide —'))

    expect(decidePhase).toContain('One more round is offered only while the Reason round cap leaves room')
    expect(decidePhase).toContain('never a fourth round')
    expect(decidePhase).toContain('returns to Reason for one round, then re-runs Feasibility and Decide')
    expect(decidePhase).toContain('Amend that changes the recommendation re-runs Feasibility then Decide')
    expect(decidePhase).toContain('wording-only amend is applied and the question is re-asked')
    expect(decidePhase).toContain('`parked`')
    expect(decidePhase).toContain("copy Astra's last non-null `dissent` verbatim and never soften it")
  })

  test('pins temporary raw-answer transport and cleanup', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('save the raw answer verbatim to a temporary file outside the workspace created with `mktemp`')
    expect(command).toContain('debate-parse.mjs --kind <kind> … --file <tmp path>')
    expect(command).toContain('append the raw answer verbatim to the phase file')
    expect(command).toContain('then delete the temporary file')
  })

  test('pins unparsed Astra destinations for Map and Feasibility', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('unparsed: <parseError>` with the raw answer')
    expect(command).toContain('mark every Divergence entry from Astra\'s side `UNVERIFIED`')
    expect(command).toContain('list dropped map entries by their `droppedReasons`')
    expect(command).toContain('record the verdict as `UNVERIFIED` in `ANALYSIS.md` `## Feasibility`')
    expect(command).toContain('log `feasibility=unverified`')
  })

  test('pins the phase boundaries and Feasibility routing', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')

    expect(command).toContain('No option or recommendation is written in this phase.')
    expect(command).toContain("stop per the skill's stop rule")
    expect(command).toContain('exactly one Astra turn')
    expect(command).toContain('only the surviving recommendation')
    expect(command).toContain('A NOT-FEASIBLE verdict returns to Reason at most once')
    expect(command).toContain('one Reason round within the cap')
    expect(command).toContain('When the cap is already spent, Fable revises the thesis without a new Astra turn')
    expect(command).toContain('When no recommendation survives Reason, skip the Astra turn')
  })

  test('builds Agreements and disagreements from the ledger and register', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')
    const decidePhase = command.slice(command.indexOf('## Decide —'))

    // Assert
    expect(decidePhase).toContain(
      'Build `## Agreements and disagreements` from the standpoint ledger and assumption register; ' +
        'include each `UNRESOLVED` standpoint\'s Crux and list high-importance low-certainty assumptions first',
    )
    expect(decidePhase).toContain(
      '`## Open questions` lists UNRESOLVED standpoints with their Crux, UNVERIFIED entries recorded ' +
        'per the skill, and high-importance low-certainty assumptions first',
    )
  })

  test('removes the superseded claims-table wording from the command', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)

    // Assert
    expect(command).not.toContain('claims table')
    expect(command).not.toContain('ACCEPTED (unconfirmed)')
  })

  test('keeps exactly three Codex execute calls', () => {
    // Arrange
    const command = readText(BRAINSTORM_COMMAND_PATH)

    // Assert
    expect(command.match(/mcp__codex__codex_execute/g) ?? []).toHaveLength(3)
  })

  test('keeps the skill response rules', () => {
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    expect(skill).toContain('ADOPT | DECLINE')
    expect(skill).toContain('## Open questions')
  })

  test('carries the run-dir paths and evidence rules', () => {
    const command = readText(BRAINSTORM_COMMAND_PATH).replace(/\s+/g, ' ')
    const skill = readText(BRAINSTORM_SKILL_PATH).replace(/\s+/g, ' ')

    expect(command).toContain("the absolute paths of the run dir's `FRAME.md`, `MAP.md`, and `REASON.md`")
    expect(skill).toContain('mark it `prior-art:`')
    expect(skill).toContain(
      'marked UNVERIFIED in the Evidence column and cannot make a standpoint MAINTAINED',
    )
  })

  test('the sync gate lists the brainstorm mirror pair', async () => {
    // @ts-expect-error — plain .mjs script
    const { SYNC_PAIRS } = await import('../scripts/check-command-sync.mjs')

    expect(SYNC_PAIRS).toContainEqual(['commands/brainstorm.md', '.claude/commands/brainstorm.md'])
  })
})

describe('thin entry commands', () => {
  const entries = [
    ['analyze', 'data'],
    ['design', 'design'],
    ['plan', 'plan'],
  ] as const

  test.each(entries)('%s satisfies the thin entry command contract', async (name, profile) => {
    const sourcePath = path.join(REPO_ROOT, 'commands', `${name}.md`)
    const mirrorPath = path.join(REPO_ROOT, '.claude', 'commands', `${name}.md`)
    const source = readFileSync(sourcePath)
    const mirror = readFileSync(mirrorPath)
    const command = source.toString('utf8')
    const fields = parseFrontmatterFields(command)

    expect(source.equals(mirror)).toBe(true)

    // @ts-expect-error — plain .mjs script
    const { SYNC_PAIRS } = await import('../scripts/check-command-sync.mjs')
    expect(SYNC_PAIRS).toContainEqual([
      `commands/${name}.md`,
      `.claude/commands/${name}.md`,
    ])

    expect(source.byteLength).toBeLessThanOrEqual(1_500)
    expect(fields.map(({ key }) => key)).toEqual(['description', 'argument-hint'])
    expect(command).toContain('$ARGUMENTS')
    expect(command).toContain(`--profile ${profile}`)
    expect(command).toContain('codex-flow:codex-flow')
    expect(existsSync(COMMAND_PATH)).toBe(true)
    expect(command).toMatch(/interview[^\n]*confirm[^\n]*preset profile/i)
    expect(command).toMatch(/do not take a fast-path lane/i)
    expect(command).toContain('CODEX_FLOW_PROFILE_MODE')
    expect(command).toContain('CODEX_FLOW_EVIDENCE')
    expect(command).toContain('CODEX_FLOW_RUN_LANGUAGE')
    expect(command).not.toMatch(/scripts\/[^\s`]*\.mjs/)
  })
})

describe('event journal archive obligation', () => {
  const sentencesNaming = (text: string, marker: string): string[] => (
    text.replace(/\s+/g, ' ').split(/(?<=[.;])\s/).filter((sentence) => sentence.includes(marker))
  )

  test('the command restart instruction archives EVENTS.jsonl', () => {
    // Arrange
    const command = readText(path.join(REPO_ROOT, 'commands', 'codex-flow.md'))

    // Act
    const sentences = sentencesNaming(command, 'EVENTS.jsonl')

    // Assert
    expect(sentences.some((sentence) => /archive the old control files/.test(sentence))).toBe(true)
  })

  test('the preflight Restart and phase-complete bullets archive EVENTS.jsonl', () => {
    // Arrange
    const skill = readText(path.join(REPO_ROOT, 'skills', 'preflight', 'SKILL.md')).replace(/\s+/g, ' ')

    // Act
    const restart = skill.match(/\*\*Restart\*\* → .*?then begin fresh/)?.[0] ?? ''
    const complete = skill.match(/\*\*`phase: complete`\*\* → .*?Resume is offered/)?.[0] ?? ''

    // Assert
    expect(restart).toContain('EVENTS.jsonl')
    expect(complete).toContain('EVENTS.jsonl')
  })
})

describe('orphaned event journal recovery', () => {
  test.each([
    ['command', path.join(REPO_ROOT, 'commands', 'codex-flow.md')],
    ['preflight skill', path.join(REPO_ROOT, 'skills', 'preflight', 'SKILL.md')],
  ])('the %s archives an orphaned EVENTS.jsonl when STATE.md is missing', (_, filePath) => {
    // Arrange
    const text = readText(filePath).replace(/\s+/g, ' ')

    // Act
    const sentence = text.match(/If STATE\.md does not exist[^]*?orphaned control files/)?.[0] ?? ''

    // Assert
    expect(sentence).toContain('archive-paths')
  })
})
