---
description: "6-phase workflow: preflight → Claude interviews → plans architecture → breaks backlog → Codex executes per task → Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude + Codex

Task: $ARGUMENTS

Follow the six phases (0–5) strictly. Do NOT write implementation code yourself — Codex does that.

Each phase names plugin skills (`codex-flow:*`) to load via the Skill tool before starting the phase — they carry the detailed checklists this command routes to. If a named skill cannot be loaded, STOP and tell the user to reinstall the codex-flow plugin; never improvise a phase or a lane from memory.

**Helper rule** (every `scripts/*.mjs` call below): If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. (except `run-ledger.mjs`, which is best-effort per `codex-flow:run-ledger`.)

## Phase 0 — Preflight (gate, do this FIRST)

**Load skills first**: If `.codex-flow/STATE.md`, `PLAN.md`, `TASKS.md` or `EVENTS.jsonl` exists, load
`codex-flow:preflight` and run its Step 2 resume check FIRST; otherwise evaluate the Fast-path gate
first and load preflight only after it selects the small-change lane or full flow (the analysis lane
never loads it). Load `codex-flow:fast-path` at the gate and `codex-flow:executor-fallback` when an
outage routes there.
Before any `codex_health` call and before baselining, evaluate the **Fast-path gate** (section
below). When the task qualifies and the user confirms the fast path, run only `git status --porcelain`
as an informational check (preflight Step 3 item 1) and skip the rest of baselining — a fast-path run writes no `.codex-flow/` control
files and needs no known-red baseline. The analysis lane stops at that gate: no `codex_health`
call at all unless the user requests a Codex second opinion.

Then follow `codex-flow:preflight` Step 1 for health routing, including the single deep probe and
the `authMode` handoff to Phase 4.

Follow `codex-flow:preflight` Step 3 for PROJECT.md generation and workspace baselining.

## Fast-path gate — small and analysis-only tasks

**Load skill**: `codex-flow:fast-path`. Evaluate the gate here — after the resume check, before the
`codex_health` call and before any control file is written — then follow that skill for the decision
and workflow.

**Profile router**: Full flow only (not fast-path lanes), per `codex-flow:preflight` after the gate.

## Executor fallback — Claude executes when Codex is unavailable

**Load skill**: `codex-flow:executor-fallback`. Offer the fallback from that skill whenever a trigger fires.

## Phase 1 — Interview (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:interview-elicitation` and `codex-flow:interview-ask-back`.

Interview the user with AskUserQuestion per those skills. Keep asking until every acceptance criterion is verifiable, then write the Requirements Summary and get confirmation.

Immediately after confirmation, write the confirmed Requirements Summary VERBATIM to
`.codex-flow/REQUIREMENTS.md` using the `codex-flow:interview-elicitation` format. Do not start
Phase 2 until the write completes.
Immediately when the user grants requirements approval, run `flow-state approve requirements` then `flow-state advance`
before entering Phase 2.

For a confirmed mid-run requirement delta, append the delta per
`codex-flow:interview-elicitation`, then run `flow-state requirement-delta` (which resets plan/backlog approval
and sets phase plan).
Before execution resumes, re-run Phase 2 impact analysis and plan approval, rebuild the affected
backlog, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`,
and obtain backlog re-approval. A prior approval never survives a requirement delta.

Scale interview depth to task complexity: a small, unambiguous change needs only a short
Requirements Summary and a quick confirmation; a large or ambiguous feature warrants the full
elicitation. When in doubt, ask.

## Phase 2 — Plan & Architecture (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:plan-research-first`, `codex-flow:plan-architecture`, `codex-flow:skill-selection`, `codex-flow:context-discipline`, and `codex-flow:session-report`.

1. Read `.codex-flow/PROJECT.md` first (the executor under inverted roles reads it too), then explore the codebase through Explore subagents per `codex-flow:context-discipline`, requiring conclusions with paths and line anchors.
2. **Select domain skills from the local index** by running `codex-flow:skill-selection` end to
   end — it carries the search terms, the ~3%-of-context load budget, the index scan, and the
   no-blind-loading rule. Every facet the
   plan depends on must end in one explicit verdict — `LOAD`, `VET`, or `AUTHOR` — recorded in
   PLAN.md *Skills plan* and stated to the user; prose like "no relevant skills found" is not a
   verdict, and a domain task must never reach Phase 4 with an empty `Skills:` field. A facet whose
   loaded skills do not cover its requirements and acceptance criteria records
   `INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)` (or `INSUFFICIENT → VET (gap: R<n>.<m>, …)`);
   loaded-but-insufficient is never a silent pass. Author the missing skill NOW (before execution)
   through `codex-flow:skill-selection` Step 7, whose fixed order is brief (`skill-brief.mjs`, with
   the verdict's gap R-IDs) → author into `<library>/quarantine/authored/` → lint
   (`skill-lint.mjs`) → one batched AskUserQuestion approval → rebuild the index → load/embed and
   promote. Indexing, loading, embedding, or promoting an authored skill before that approval is a
   defect.
3. Write `.codex-flow/PLAN.md` in the project root with the sections
   `codex-flow:plan-architecture` prescribes, in its order and content: **Context**, **Objective**,
   **Architecture**, **Contracts**, **Component → files**, **Risk & blast
   radius** (including the rollback point — the baseline ref from Phase 0), **Skills plan** (one
   `LOAD` / `VET` / `AUTHOR` verdict per facet — there is no empty state — plus *Skills to use* and
   *Skills to create*), **Known-red baseline** (from Phase 0), **Out of scope**, **Acceptance
   criteria**, **Session report** (report dir + session-start ISO 8601), and
   **Decision log** (empty, append-only).
   Every entry must cite the R-IDs it covers, for example `- A3 (covers R2.1, R2.2): ...`.
4. Show the plan to the user and get approval before continuing.
   Record the grant timestamp, but do not update STATE.md yet.
5. After approval, generate/update tiered AGENTS.md per `codex-flow:context-discipline` — root plus
   each package in the approved **Component → files** map whose conventions differ from root,
   additive-only changes. Before Phase 3, commit every AGENTS.md creation/update as
   `docs(agents): update AGENTS.md guidance` so later runs and worktrees branch from a clean
   tracked baseline that carries the guidance.
6. After approval, write `planning.md` to the report dir per `codex-flow:session-report`, and under
   a `## Session report` heading in PLAN.md record `- Report dir: <report dir>` and
   `- Session start: <ISO 8601>`.
7. Only after steps 5 and 6 complete, run `flow-state approve plan --at <grant time>` then `flow-state advance` before
   entering Phase 3. Never persist Phase 2 approval before its post-approval artifacts are durable.

## Phase 3 — Backlog (Claude)

**Load skill first**: `codex-flow:plan-backlog`.

Immediately when the user grants backlog approval below, run `flow-state approve backlog --checkpoint-commits <yes|no> --execution-mode "<mode>"` then `flow-state advance` before entering Phase 4.

Slice per `codex-flow:plan-backlog`, which carries the full rules: task sizing, self-sufficiency,
contracts first, acceptance that names the reviewer's exact check, and dependency order. These
three stay here:
- **Acceptance cites the plan's A-entries**: end each `Acceptance:` field with the citation form
  `; satisfies A<n>[, A<n>]` — every PLAN `A<n>` must be cited by at least one task, and the tokens
  after `satisfies` must be bare `A<n>` IDs (no suffixes).
- **File-disjoint where independent**: actively reshape task boundaries so independent tasks own
  disjoint `Files:` sets (for example, move a shared helper edit into its own earlier task and make
  the others depend on it). For multi-task backlogs, make `task-waves` width > 1 the norm, not the
  exception.
- Decide the skill→task mapping ONCE here (the `Skills:` field), from PLAN.md's *Skills to use*
  plus any *Skills to create* marked before execution — so Phase 4 embeds a consistent,
  user-reviewable set per task instead of re-guessing. A facet discovered at backlog time whose
  loaded skills do not cover the task's requirements records the same
  `INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)` (or `→ VET`) qualifier in PLAN.md *Skills plan*, and
  its skill is created through the same `codex-flow:skill-selection` Step 7 procedure Phase 2 uses,
  in that same fixed order, before the task may enter Phase 4. Keep retro-timed entries as PLAN.md
  rule blocks and embed those rules directly in the relevant task prompt.
- Mirror the tasks with TaskCreate so the user sees live progress.

```markdown
## T1: <imperative title>
- Depends on: — | T<n>
- Files: <files to create/modify>
- Requirements: <R-IDs covered>
- Steps: <concrete, file-level steps>
- Skills: <Phase 2 domain skills relevant to THIS task, or — >
- Acceptance: <verifiable criteria for THIS task — tests to pass, behaviors>; satisfies A<n>[, A<n>]
- Session: —
- Status: pending
```

Before asking for backlog approval, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`.
Every effective R<n>.<m> must be cited by at least one task and no task may cite an unknown ID; fix
the backlog before presenting it for approval. Every PLAN `A<n>` acceptance entry must be cited by
at least one task's `Acceptance:` field; treat a non-zero exit (orphan `A<n>`, unknown citation) as
fix the backlog before presenting it.

Show the backlog to the user and get approval before executing, asking once at the same time:
**checkpoint commits after each passed task — yes/no?** (recommended yes on multi-task backlogs;
gives per-task rollback points). After backlog approval, write `allocation.md` (task → PIC table)
to the report dir per `codex-flow:session-report`.

## Phase 4 — Execution (Codex)

**Load skills first (code tasks)**: (if not already loaded this session) `codex-flow:exec-coding-standards` and `codex-flow:exec-self-testing` (blocks to embed into every Codex prompt), `codex-flow:context-discipline` (no-raw-read, task-boundary compaction), plus the language skill matching the project: `codex-flow:task-loop`, `codex-flow:exec-typescript`, `codex-flow:exec-python`, `codex-flow:exec-go`, `codex-flow:exec-jvm` (Java/Kotlin), `codex-flow:exec-rust`, `codex-flow:exec-csharp`, `codex-flow:exec-php`, `codex-flow:exec-ruby`, `codex-flow:exec-swift`, or `codex-flow:exec-cpp` (C/C++). If the project's language has no exec skill, use `codex-flow:exec-coding-standards` alone plus any language guidance from the skill index. Codex cannot see Claude's skills — the prompt is the only channel, so these standards blocks MUST be embedded in the prompt text. When a task must illustrate a chart/graph (code OR deliverable), also load `codex-flow:exec-visualization` so Codex routes the chart to flint-chart (PNG/SVG) instead of ad-hoc Python.

**Non-code tasks**: when a task produces content instead of code (data analysis, marketing copy, docs, research, a plan), load `codex-flow:exec-deliverable` INSTEAD of `exec-coding-standards` + `exec-self-testing` + the language skill, and embed its deliverable + verification blocks. A mixed backlog picks per task. The Phase 2 domain skills, `codex-flow:context-discipline`, and `codex-flow:task-loop` apply either way.

**Data processing tooling**: the project-language skill governs code that lands in the repo, NOT ad-hoc data processing inside a task. Whenever a task reads or transforms a dataset beyond ~50 MB — measure with `du -h` first, never guess sizes — in any lane, also embed the Data tooling block from `codex-flow:exec-deliverable`: never let Codex write row-by-row scan scripts over large raw files just because of the repo language.

## Phase 5 — Review (Claude, per task + final)

**Load skills first**: (if not already loaded this session) `codex-flow:task-loop`, `codex-flow:final-review`, `codex-flow:review-conformance` (requirement/plan/structure conformance — check FIRST), `codex-flow:review-quality` (correctness hazards, silent failures, test quality), `codex-flow:review-security` (mandatory when the diff touches auth, input, queries, files, or secrets), `codex-flow:review-feedback` (severity levels + codex_continue format), `codex-flow:review-dual` (dual review, comparison protocol, improvements ledger + decision gate), `codex-flow:context-discipline` (no-raw-read, task-boundary compaction), `codex-flow:session-report` (templates for `tasks.md`, `reviews.md`, `cost.md`, `SUMMARY.md`), and `codex-flow:run-ledger`.

**Final review**: load `codex-flow:final-review` and follow its Phase 5 steps 8–10.

Rules:
- Never skip the interview, plan approval, or backlog approval.
- Never switch executors silently or mid-task — an outage triggers exactly one AskUserQuestion per the Executor fallback section.
