import { existsSync, readFileSync } from 'node:fs'
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
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'codex-flow.md')
const CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'codex-flow.md')
const COMMAND_TOKEN_ALLOWLIST = new Set(['codex-flow:codex-flow'])
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
      'at most ONCE',
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
    expect(skill).toContain('standalone fallback when the slice helper is unavailable')
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
  test('uses the budgeted resume slice with fallback and trust-but-verify guidance', () => {
    const skill = readText(PREFLIGHT_PATH)
    const normalizedSkill = skill.replace(/\s+/g, ' ')

    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume')
    expect(skill).toContain('`.codex-flow/RESUME.md`')
    expect(skill).toMatch(/helper is unavailable in a standalone\s+install, fall back/)
    expect(normalizedSkill).toContain(
      'helper is present but exits non-zero, surface the error to the user and STOP; never use the standalone fallback for a failing helper',
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
      /- Acceptance: <[^\n]+>\r?\n- Session: —\r?\n- Status: pending/,
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
    expect(skill).toContain('return `phase` to `review`')
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
    expect(step).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>',
    )
    expect(step).toContain('skill-lint.mjs')
    expect(step).toContain('one batched AskUserQuestion')
    expect(step).toContain('loaded-but-insufficient is never a silent pass')
    expect(step).toContain('brief → author → lint → one batched approval')
    expect(step).toContain('quarantine/authored')
  })

  test('requires brief-first authoring before Phase 3 execution', () => {
    const command = readText(COMMAND_PATH)
    const phaseStart = command.indexOf('## Phase 3 — Backlog (Claude)')
    const phaseEnd = command.indexOf('## Phase 4 — Execution (Codex)')
    const phaseSection = extractPhaseSection(command, 3).replace(/\s+/g, ' ')

    expect(phaseStart).toBeGreaterThanOrEqual(0)
    expect(phaseEnd).toBeGreaterThan(phaseStart)
    expect(phaseSection).toContain('Creation is brief-first')
    expect(phaseSection).toContain('skill-brief.mjs')
    expect(phaseSection).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>',
    )
    expect(phaseSection).toContain('skill-lint.mjs')
    expect(phaseSection).toContain('one batched AskUserQuestion')
    expect(phaseSection).toContain('brief → author → lint → one batched approval')
    expect(phaseSection).toContain('quarantine/authored')
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

describe('fast-path gate contract', () => {
  test('defines both lanes with exclusions and a full-flow escalation', () => {
    const section = extractFastPathSection(readText(COMMAND_PATH))

    expect(section).toContain('**Analysis lane**')
    expect(section).toContain('**Small-change lane**')
    expect(section).toContain('security-sensitive')
    expect(section).toContain('restart at Phase 1 with the full flow')
    expect(section).toContain('Never stretch a lane')
  })

  test('exempts the analysis lane from the Codex health gate', () => {
    const command = readText(COMMAND_PATH)
    const phaseZero = extractPhaseSection(command, 0).replace(/\s+/g, ' ')
    const section = extractFastPathSection(command).replace(/\s+/g, ' ')

    expect(phaseZero).toContain(
      'a failed health check or missing login does NOT block the **analysis lane**',
    )
    expect(section).toContain('this lane is exempt from the Codex health gate')
    expect(phaseZero).toContain(
      'the small-change lane and the full flow still require `loggedIn: true`',
    )
  })

  test('enforces a mechanical scope trip-wire on the small-change lane', () => {
    const section = extractFastPathSection(readText(COMMAND_PATH)).replace(/\s+/g, ' ')

    expect(section).toContain('**Scope trip-wire (mechanical, not judgment)**')
    expect(section).toContain('ANY extra changed file — excluding generated lockfiles — triggers the escalation rule automatically')
    expect(section).toContain('do not review the oversized diff in-lane')
  })

  test('gives the small-change lane its own known-red baseline', () => {
    const section = extractFastPathSection(readText(COMMAND_PATH)).replace(/\s+/g, ' ')

    expect(section).toContain(
      "first run the project's test command once and note any pre-existing failures as the lane's known-red list",
    )
    expect(section).toContain('only failures NOT on that list count against the change')
  })

  test('logs every fast-path run to the durable fastpath log', () => {
    const section = extractFastPathSection(readText(COMMAND_PATH)).replace(/\s+/g, ' ')

    expect(section).toContain('`.codex-flow/notes/fastpath.log`')
    expect(section).toContain('session=<sessionId or ->')
    expect(section).toContain('outcome=<delivered|done|escalated|failed>')
    expect(section).toContain('so write it even on escalation or failure')
  })

  test('skips control files and baseline steps 2-5 in Phase 0 for fast-path runs', () => {
    const phaseZero = extractPhaseSection(readText(COMMAND_PATH), 0).replace(/\s+/g, ' ')

    expect(phaseZero).toContain('evaluate the **Fast-path gate** (next section)')
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

  test('generates and reads the resume slice in Phase 0 with a standalone fallback', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 0)
    const normalizedPhase = phaseSection.replace(/\s+/g, ' ')

    expect(phaseSection).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume',
    )
    expect(phaseSection).toContain('`.codex-flow/RESUME.md`')
    expect(phaseSection).toMatch(
      /fall\s+back to reading `\.codex-flow\/PLAN\.md` and `\.codex-flow\/TASKS\.md` directly/,
    )
    expect(phaseSection).toContain('if `.codex-flow/STATE.md` exists')
    expect(phaseSection).toContain('even when PLAN.md or TASKS.md has not been created yet')
    expect(phaseSection).toContain('skip only phases whose approvals STATE.md records')
    expect(normalizedPhase).not.toContain('skip Phases 1–3')
    expect(phaseSection).toMatch(
      /On resume,\s+reuse the report dir recorded under `## Session report`/,
    )
    expect(normalizedPhase).toContain(
      'for `phase: review`, resume Phase 5 completion work. When all tasks are done but `phase` is not `complete`, resume Phase 5',
    )
    expect(normalizedPhase).toContain(
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
    expect(command.slice(phaseStart, phaseEnd).replace(/\s+/g, ' ')).toContain(
      'If the helper is present but exits non-zero, surface the error to the user and STOP; never continue to backlog approval with a failing helper.',
    )
  })

  test('generates a task slice before each Phase 4 execution and uses it in the prompt', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4)
    const sliceCommand = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>'
    const promptBullet = '- `prompt`:'

    expect(phaseSection).toContain(sliceCommand)
    expect(phaseSection).toContain(promptBullet)
    expect(phaseSection.indexOf(sliceCommand)).toBeLessThan(phaseSection.indexOf(promptBullet))
    expect(phaseSection).toContain('Read .codex-flow/CONTEXT-T<n>.md for context')
    expect(phaseSection).toContain('Read .codex-flow/PLAN.md for context.')
    expect(phaseSection).toContain('its header records the generation anchor')
    expect(phaseSection).toContain('blocks marked [verify] must be re-checked')
    expect(phaseSection).toMatch(
      /when the slice was generated, or "Read \.codex-flow\/PLAN\.md for context\." when the helper is unavailable/,
    )
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

  test('omits duplicate task text from generated-slice prompts but keeps it in the fallback', () => {
    const phaseSection = extractPhaseSection(readText(COMMAND_PATH), 4)

    const promptInstruction = extractParameterBullet(phaseSection, 'prompt').replace(/\s+/g, ' ')

    expect(promptInstruction).toContain(
      'do not append the full task text because the slice already embeds it as mandatory content.',
    )
    expect(promptInstruction).toMatch(
      /When the slice was generated, append .* \+ the standards, testing, and language blocks .* \+ a distilled ≤ 30-line rules block/,
    )
    expect(promptInstruction).toMatch(
      /In the standalone fallback, append the same directive \+ the full task text \+ those same standards\/testing\/language, deliverable, and distilled skill blocks/,
    )
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
    expect(stepSeven).toContain('`  - <ISO 8601 ts> in-progress -> done (session: <id>)`')
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
    expect(stepZero).toContain('`.codex-flow/CONTEXT-T<n>.md` slice')
    expect(stepZero).toContain("this task's entry in `.codex-flow/TASKS.md`")
    expect(stepZero).toContain('helper is unavailable in a standalone install')
    expect(stepZero).toContain('fall back to reading `.codex-flow/PLAN.md` directly')
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
    const helperFailure = 'If the helper is present but exits non-zero, surface the error to the user and STOP; never use the standalone fallback for a failing helper.'

    for (const phaseNumber of [0, 4, 5]) {
      const normalizedPhase = extractPhaseSection(command, phaseNumber).replace(/\s+/g, ' ')
      expect(normalizedPhase).toContain(helperFailure)
    }
    expect(extractPhaseSection(command, 4).replace(/\s+/g, ' ')).toContain(
      '`mandatory slice content exceeds tokenBudget`, split the oversized task in the backlog before continuing; never raise the slice budget.',
    )
  })
})
