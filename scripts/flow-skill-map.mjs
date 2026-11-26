export const PHASE_SKILL_MAP = [
  { phase: 'Phase 0', skills: ['preflight', 'fast-path', 'executor-fallback'] },
  { phase: 'Phase 1', skills: ['interview-elicitation', 'interview-ask-back'] },
  { phase: 'Phase 2', skills: ['plan-research-first', 'plan-architecture', 'skill-selection', 'context-discipline', 'session-report'] },
  { phase: 'Phase 3', skills: ['plan-backlog'] },
  { phase: 'Phase 4', skills: ['exec-coding-standards', 'exec-self-testing', 'exec-typescript', 'context-discipline', 'parallel-execution', 'task-loop'] },
  { phase: 'Phase 5', skills: ['review-conformance', 'review-quality', 'review-security', 'review-feedback', 'review-dual', 'context-discipline', 'session-report', 'run-ledger', 'task-loop', 'final-review'] },
]

export const FLOW_COMMAND_PATH = 'commands/codex-flow.md'

export function flowSkillNames() {
  return [...new Set(PHASE_SKILL_MAP.flatMap(({ skills }) => skills))]
}
