---
description: "6-phase workflow: preflight → Claude interviews → plans architecture → breaks backlog → Codex executes per task → Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude + Codex

Task: $ARGUMENTS

Follow the six phases (0–5) strictly. Do NOT write implementation code yourself — Codex does that.

Each phase names plugin skills (`codex-flow:*`) to load via the Skill tool before starting the phase — they carry the detailed checklists this command routes to. If a named skill cannot be loaded, STOP and tell the user to reinstall the codex-flow plugin; never improvise a phase or a lane from memory.

## Phase 0 — Preflight (gate, do this FIRST)

**Load skills first**: `codex-flow:preflight` (health gate, resume check, workspace baseline; it carries the detailed checklist for the steps below) plus `codex-flow:fast-path` at the gate and `codex-flow:executor-fallback` when an outage routes there.

**Resume check** — if `.codex-flow/STATE.md` exists, treat it as an interrupted run and offer
**resume** or **restart** per `codex-flow:preflight` Step 2 (resume authority, in-progress task
reconciliation, `taskStage` routing, report-dir reuse), even when PLAN.md or TASKS.md has not been
created yet: skip only phases whose approvals STATE.md records, and enter the first unapproved
phase. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" check` first — when it reports
ONLY missing keys on a legacy file, add them with `set` (`currentTask -`, `taskStage idle`,
`wave -`) and continue; any other violation is surfaced to the user before routing. When
`.codex-flow/TASKS.md` exists, make that same call
`node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" check --tasks .codex-flow/TASKS.md` so the
terminal-status validation runs too. When both `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md`
exist, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume` and read
`.codex-flow/RESUME.md` instead of the raw files; when either file is missing, read only the control files that exist.
If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. On resume, write the current `git rev-parse HEAD` to `resumeHead` and update `phase` to the
phase being entered; apart from that legacy-key backfill, change no other state field. On restart,
archive the old control files that exist to `.codex-flow/archive/<timestamp>/` and begin fresh.

`phase: complete` is terminal: the previous run is finished, so do NOT offer resume for it. Archive
the run's control files to `.codex-flow/archive/<timestamp>/` and begin fresh, exactly as a restart
would. Resume is offered only for a non-complete `phase`. If STATE.md does not exist, do not offer
resume: treat any PLAN.md or TASKS.md as orphaned control files and offer to archive them before
beginning a fresh run.

Before any `codex_health` call and before baselining, evaluate the **Fast-path gate** (section
below). When the task qualifies and the user confirms the fast path, run only baseline step 1 below
as an informational check and skip steps 2–5 — a fast-path run writes no `.codex-flow/` control
files and needs no known-red baseline. The analysis lane stops at that gate: no `codex_health`
call at all unless the user requests a Codex second opinion.

Then, for the small-change lane and the full flow only, call `mcp__codex__codex_health` with
`{ deep: true }` ONCE — after the gate decision and the resume check, before anything else. The
deep input adds a one-shot read-only `codex exec` probe, returning `execProbe`
(`ok | quota | model | error | skipped`) plus `execProbeMessage` next to `loggedIn`. Read
`execProbe` from that single call; never re-probe per phase or per task. Route it per
`codex-flow:preflight` Step 1:

- **Tool call fails / server missing** → the MCP server is not set up: point the user at the
  codex-mcp README install steps (or `node scripts/doctor.mjs`), then
  offer the **Executor fallback** (section below): fix Codex and re-check, or continue with
  Claude as executor. Never continue silently.
- **`loggedIn: false`** → tell the user to run `codex login`, then offer the same fallback choice;
  do not interview, plan, or execute anything until either a re-check shows `loggedIn: true` or the
  user has explicitly chosen the fallback.
- **`execProbe: quota` or `execProbe: model`** → logged in but unable to execute: quote
  `execProbeMessage` and offer the fallback immediately; a `quota` or `model` probe result is
  sufficient on its own and needs NO unhealthy health re-check to justify the fallback.
- **`execProbe: error`** → report `execProbeMessage` verbatim, then offer the same fallback.
- **`loggedIn: true` with `execProbe: ok` (or `skipped`)** → report the Codex version, keep
  `executor: codex`, and continue. Read `authMode` (`chatgpt | apikey | unknown`) from this same
  call and carry it into Phase 4's `model` decision.

The **analysis lane** of the Fast-path gate never reaches this gate: it needs no Codex session and
no fallback decision, so a failed health check or missing login does NOT block it. Tell the user
about any health failure, then proceed in the analysis lane; the small-change lane and the full
flow require either `loggedIn: true` or an explicit Executor-fallback choice.

On a fresh run, before baselining, when `.codex-flow/PROJECT.md` is absent generate it with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/project-context.mjs" --generate` (if that helper is missing or
exits non-zero, surface the error to the user and STOP), and ask the user to confirm or edit it in
the Phase 1 interview. PROJECT.md is tracked, not run state: include it in the checkpoint and final
commits and never archive it with the run; when it was created before baselining, list it as
pre-existing in the `baseline-dirty.patch` manifest.

Then baseline the workspace per `codex-flow:preflight` Step 3 (in the project root):

1. `git status --porcelain` — dirty tree → ask the user: commit/stash first (recommended, gives
   clean per-task diffs and a rollback point) or proceed with the dirty baseline noted in PLAN.md
   and captured in `.codex-flow/baseline-dirty.patch`. Record the baseline ref
   (`git rev-parse HEAD`). Not a git repo → tell the user diffs/checkpoints/rollback are
   unavailable and confirm before continuing.
2. Ensure `.codex-flow/live/` is in the project's `.gitignore` (append it if missing) so raw
   live-progress JSONL logs never land in checkpoint or final commits.
3. Detect the project's test command, run it once, and record the pre-existing failures as the
   **known-red baseline** per that skill — Phase 5 blames Codex only for NEW failures.
4. On a fresh run, create `.codex-flow/reports/<YYYYMMDD-HHMMSS>/` using the session-start
   local-time timestamp; on resume, reuse the report dir recorded under `## Session report` in the
   existing PLAN.md — the single report dir later phases write into per
   `codex-flow:session-report`.
5. After baselining a fresh run, write all 14 `.codex-flow/STATE.md` keys per
   `codex-flow:preflight` Step 4, with `phase: interview`, every approval `no`, `runBaselineRef`
   at the run-start git HEAD, the compact original `knownRed` list, `dirtyBaseline` set to
   `baseline-dirty.patch` when the user proceeded dirty, and `executor` set to `codex` — or to the
   fallback value when the user chose the Executor fallback in the health gate. From here on, write
   STATE.md keys and TASKS.md status lines only through
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs"` (`set`, `check`, `task`) — including the
   Phase 1–3 approval gates, the plan-drift and improvement transactions, and the executor switch.
   If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. The orchestrator is the only writer. Never modify `runBaselineRef`, `knownRed`, or
   `dirtyBaseline` on resume.

## Fast-path gate — small and analysis-only tasks

**Load skill**: `codex-flow:fast-path` — it carries this gate in full: the two lite lanes
(analysis, small-change), the exclusions that force the full flow, each lane's workflow, the
mechanical scope trip-wire, the `fastpath.log` record, and the escalation rule. Evaluate the gate
here — after the resume check, before the `codex_health` call and before any control file is
written — then follow that skill for the decision and the chosen lane's workflow.

## Executor fallback — Claude executes when Codex is unavailable

**Load skill**: `codex-flow:executor-fallback` — it carries the outage triggers, the single
AskUserQuestion switch (task boundary only, never silent), the STATE.md `executor` and
Decision-log recording, Phase 4 and Phase 5 with Claude as executor (independent subagent review
in place of `codex_review`, same 3-round cap), returning to Codex, and the small-change lane under
fallback. Offer the fallback from that skill whenever a trigger fires.

## Phase 1 — Interview (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:interview-elicitation` (six question domains, stop condition) and `codex-flow:interview-ask-back` (5 Whys, example probing, hidden assumptions).

Interview the user with AskUserQuestion per those skills. Keep asking until every acceptance criterion is verifiable, then write the Requirements Summary and get confirmation.

Immediately after confirmation, write the confirmed Requirements Summary VERBATIM to
`.codex-flow/REQUIREMENTS.md` using the `codex-flow:interview-elicitation` format. Do not start
Phase 2 until the write completes.
Immediately when the user grants requirements approval, set `requirementsApproved` in
`.codex-flow/STATE.md` to `yes (<ISO 8601 timestamp>)` and set `phase` to `plan` before entering
Phase 2.

For a confirmed mid-run requirement delta, append the delta per
`codex-flow:interview-elicitation`, refresh `requirementsApproved` to `yes (delta <ISO date>)`,
reset `planApproved` and `backlogApproved` to `no (delta <ISO date>)`, and set `phase` to `plan`.
Before execution resumes, re-run Phase 2 impact analysis and plan approval, rebuild the affected
backlog, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`,
and obtain backlog re-approval. A prior approval never survives a requirement delta.

Scale interview depth to task complexity: a small, unambiguous change needs only a short
Requirements Summary and a quick confirmation; a large or ambiguous feature warrants the full
elicitation. When in doubt, ask.

## Phase 2 — Plan & Architecture (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:plan-research-first` (search existing solutions before designing), `codex-flow:plan-architecture` (convention discovery, option trade-offs, PLAN.md structure), `codex-flow:skill-selection` (pick domain skills from the local skill index), `codex-flow:context-discipline` (Explore subagents, boundary compaction, tiered AGENTS.md), and `codex-flow:session-report` (report templates and PIC rules).

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
7. Only after steps 5 and 6 complete, set `planApproved` in `.codex-flow/STATE.md` to
   `yes (<ISO 8601 timestamp>)` using the user's grant time, then set `phase` to `backlog` before
   entering Phase 3. Never persist Phase 2 approval before its post-approval artifacts are durable.

## Phase 3 — Backlog (Claude)

**Load skill first**: `codex-flow:plan-backlog` (slicing rules, dependency ordering, sanity checks).

Immediately when the user grants backlog approval below, set `backlogApproved` in
`.codex-flow/STATE.md` to `yes (<ISO 8601 timestamp>)`, record the checkpoint choice in
`checkpointCommits` and the selected mode in `executionMode`, and set `phase` to `execution`
before entering Phase 4.

Decompose the approved plan into tasks in `.codex-flow/TASKS.md`:

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

Before asking for backlog approval, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`.
Every effective R<n>.<m> must be cited by at least one task and no task may cite an unknown ID; fix
the backlog before presenting it for approval. Every PLAN `A<n>` acceptance entry must be cited by
at least one task's `Acceptance:` field; treat a non-zero exit (orphan `A<n>`, unknown citation) as
fix the backlog before presenting it. If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand.

Show the backlog to the user and get approval before executing, asking once at the same time:
**checkpoint commits after each passed task — yes/no?** (recommended yes on multi-task backlogs;
gives per-task rollback points). After backlog approval, write `allocation.md` (task → PIC table)
to the report dir per `codex-flow:session-report`.

## Phase 4 — Execution (Codex)

**Load skills first (code tasks)**: (if not already loaded this session) `codex-flow:exec-coding-standards` and `codex-flow:exec-self-testing` (blocks to embed into every Codex prompt), `codex-flow:context-discipline` (no-raw-read, task-boundary compaction), plus the language skill matching the project: `codex-flow:exec-typescript`, `codex-flow:exec-python`, `codex-flow:exec-go`, `codex-flow:exec-jvm` (Java/Kotlin), `codex-flow:exec-rust`, `codex-flow:exec-csharp`, `codex-flow:exec-php`, `codex-flow:exec-ruby`, `codex-flow:exec-swift`, or `codex-flow:exec-cpp` (C/C++). If the project's language has no exec skill, use `codex-flow:exec-coding-standards` alone plus any language guidance from the skill index. Codex cannot see Claude's skills — the prompt is the only channel, so these standards blocks MUST be embedded in the prompt text. When a task must illustrate a chart/graph (code OR deliverable), also load `codex-flow:exec-visualization` so Codex routes the chart to flint-chart (PNG/SVG) instead of ad-hoc Python.

**Non-code tasks**: when a task produces content instead of code (data analysis, marketing copy, docs, research, a plan), load `codex-flow:exec-deliverable` INSTEAD of `exec-coding-standards` + `exec-self-testing` + the language skill, and embed its deliverable + verification blocks. A mixed backlog picks per task. The Phase 2 domain skills and `codex-flow:context-discipline` apply either way.

**Data processing tooling**: the project-language skill governs code that lands in the repo, NOT ad-hoc data processing inside a task. Whenever a task reads or transforms a dataset beyond ~50 MB — measure with `du -h` first, never guess sizes — in any lane, also embed the Data tooling block from `codex-flow:exec-deliverable`: never let Codex write row-by-row scan scripts over large raw files just because of the repo language.

**Sequential vs parallel**: always run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/task-waves.mjs" .codex-flow/TASKS.md` to compute execution
waves from the `Depends on:` + `Files:` metadata. When it reports width > 1, **parallel mode is the
default**: load `codex-flow:parallel-execution` and follow that skill end to end — worktree +
subagent workflow, clean tracked-baseline gate, serial worktree/control-file setup, reviewed task
commit, wave merge + integration review, and when to stay sequential. Proceed without asking for
waves of ≤3 concurrent tasks; ask the user before a wider wave (N× simultaneous quota). Record each
wave with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set wave <n>` before dispatching it.

For each task in dependency order (sequential mode):

1. Before each `mcp__codex__codex_execute`, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>`. If it reports
   `mandatory slice content exceeds tokenBudget`, split the
   oversized task in the backlog before continuing; never raise the slice budget. Immediately
   before the call, record `git rev-parse --short HEAD` as the task's base sha. In the same durable
   update, set the task's `- Status:` line to `in-progress`, append
   `  - <ISO 8601 ts> pending -> in-progress` beneath it, and write
   `- Session: launching (base: <short sha>)`. Make the Status write and its transition line with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" task T<n> in-progress`, and set `currentTask T<n>` and
   `taskStage launching` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set`; once the call is dispatched, set `taskStage executing`.
   Both helper calls in this step are required. If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. Complete all of these writes before calling
   `mcp__codex__codex_execute` with:
   - `prompt`: start with the single header line `Run position: phase execution — task T<n> <title> — next gate: <gate>`, then the opener "Read .codex-flow/CONTEXT-T<n>.md for context (a budgeted slice of PLAN.md; its header records the generation anchor, and blocks marked [verify] must be re-checked against the current code before relying on them)." Then append "Implement task T<n> exactly as specified below, and only this task. Run its acceptance checks before finishing." + the standards, testing, and language blocks from the loaded skills (or the `exec-deliverable` blocks for a non-code task) + a distilled ≤ 30-line rules block per skill in the task's `Skills:` field (see `codex-flow:skill-selection` Step 6 — never paste a whole SKILL.md); do not append the full task text because the slice already embeds it as mandatory content.
   - `cwd`: absolute path of the project root
   - `sandbox`: `workspace-write` by default; `read-only` for investigation-only tasks; `danger-full-access` ONLY when the task genuinely needs network or a global install, and tell the user first.
   - `model` and `reasoningEffort`: pass `model` only when Phase 0's `codex_health.authMode` is `apikey`; otherwise omit `model` and steer with `reasoningEffort` (the server rejects a `model` override under ChatGPT auth). Match effort to complexity — `high` (plus a stronger model where `model` is allowed) for architectural, cross-cutting, or subtle-logic tasks; `low` for small, mechanical, well-specified tasks; omit `reasoningEffort` for standard implementation work (use the CLI default). Note both choices in the Decision log.
   - `timeoutMs`: default 60 min; scale UP for large tasks rather than letting them die. The server auto-resumes within bounded limits, so never retry manually before inspecting `attempts` and `resumeReasons` (see step 2).
   - `terminal`: `true` — opens a live-progress terminal window when supported; progress also streams into the session via MCP notifications
   - `verifyCommand`: the task's exact acceptance check from its `Acceptance:` field (test file/pattern or build command, e.g. `npx vitest run tests/foo.test.ts`). The server runs it in `cwd` after the run settles and returns `verification` (`exitCode`, `passed`, `outputTail`) — deterministic evidence that the check ran, independent of Codex's account. Pass the same `verifyCommand` on every `codex_continue` fix round. Omit only when the acceptance is a manual probe with no command.
2. **Check the returned `status` field** before anything else:
   - `success` → proceed normally.
   - `partial` (not a tool error) → the run ended without a completion marker, or with unparseable
     event lines after any bounded auto-resume, so Codex's account of the run is suspect. Inspect
     `attempts`/`resumeReasons`, `diff`/`attribution`, and the live log; explicitly verify the
     acceptance checks before treating it as done, and ask the user before any manual retry.
   - `failed` / `aborted` (tool error) → inspect `attempts`/`resumeReasons` first; if bounded
     auto-resume was exhausted or the failure was ineligible for it, report it and ask the user
     before any manual retry (see Rules below).
3. **Save the returned `sessionId`** — when `codex_execute` returns, replace the task's launching
   Session line with `- Session: <sessionId> (cwd: <path>, base: <short sha>)`, preserving the base
   recorded before the call. Phase 5 reviews and fix rounds go back into that session. The DEFAULT
   is a fresh `codex_execute` per task; use `codex_continue` for review/fix rounds within the same
   task. Cross-task session reuse is allowed only when the next task directly depends on the
   previous task AND stays in the same domain, and is capped at that one adjacent task — after
   that, start fresh. A fresh session gets the new task's distilled skill blocks instead of
   inheriting stale context from the previous domain.
4. Keep the task `in-progress` while it is under review and its durable handoff is being written.
   Do not mark it done here; Phase 5 step 7 makes that the last durable task write. When a
   task is abandoned, set `- Status:` to `failed` via `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" task T<n> failed` (the helper appends the
   bare transition line `  - <ISO 8601 ts> in-progress -> failed`; record the session id and reason
   in the Decision log, never as a suffix on that line), then set `taskStage idle` and
   `currentTask -`, and update TaskUpdate. Transition lines are append-only — never rewrite or delete earlier ones.
5. Run Phase 5 review for the task BEFORE starting the next one.
6. When the task passes review, act as the only per-task writer in sequential mode: Phase 5 step 7
   performs the durable completion handoff in the order given there, and only after all of its
   writes succeed may it flip the task to `done`; `done` means the complete durable handoff exists.

## Phase 5 — Review (Claude, per task + final)

**Load skills first**: (if not already loaded this session) `codex-flow:review-conformance` (requirement/plan/structure conformance — check FIRST), `codex-flow:review-quality` (correctness hazards, silent failures, test quality), `codex-flow:review-security` (mandatory when the diff touches auth, input, queries, files, or secrets), `codex-flow:review-feedback` (severity levels + codex_continue format), `codex-flow:review-dual` (dual review, comparison protocol, improvements ledger + decision gate), `codex-flow:context-discipline` (no-raw-read, task-boundary compaction), and `codex-flow:session-report` (templates for `tasks.md`, `reviews.md`, `cost.md`, `SUMMARY.md`).

At the Phase 4 → Phase 5 boundary, `phase` stays `execution`. Sequential mode: set `taskStage` to
`reviewing` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set taskStage reviewing`.
Parallel mode: `taskStage` stays `executing` for the whole wave (subagents review inside their
worktrees) and moves to `handoff` only in the coordinator's Step 3.8. `phase: review` is set once,
in step 8, after the last task.

0. Before reviewing, reuse the existing `.codex-flow/CONTEXT-T<n>.md` only when its generated header's anchor equals the current `git rev-parse HEAD` and the tree is clean; otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>` to regenerate this task's slice, then re-read it and this task's entry in `.codex-flow/TASKS.md`. If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. Treat the files read on disk — not session memory, which may have been compacted — as the source of truth for acceptance criteria, architecture, `Files:` scope, and the known-red baseline. Read full `.codex-flow/PLAN.md` only when a finding disputes plan intent or the slice's omitted-pointer line points at a section the review needs.
1. **Start the Codex-side review in the background FIRST** — it is read-only and independent of your own pass, so never run it after your review: launch a background subagent (Agent tool, general-purpose) whose only job is to call `mcp__codex__codex_review` for THIS task with the focus block from `codex-flow:review-dual` (task id/title, acceptance criteria, `Files:` list) plus `scope: { files: <the task's `Files:` list>, contract: <the PLAN Contracts the task lists> }`, and return the tool result's `reviewFindings` object plus `status` verbatim, nothing else. Do steps 2–4 yourself while it runs; collect its result in step 5. If the Agent tool is unavailable, call `mcp__codex__codex_review` directly at step 5 instead (sequential fallback).
   **Scope trip-wire (mechanical, not judgment)** — in sequential mode, before the Claude review
   pass, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs" --task T<n> --base <base sha> --tasks .codex-flow/TASKS.md`
   with the base sha recorded on this task's `- Session:` line. Exit 0 → proceed. ANY extra path it
   prints — lockfiles, `node_modules`, and `.codex-flow/` are already excluded — is a blocking finding routed through
   step 5, or, when the extra path proves the PLAN declared the wrong `Files:`, the step 6 plan-drift
   transaction; do not review the out-of-scope diff as if it were in scope and do not re-argue the
   task's `Files:` after the fact. Exit 1 with a placeholder or empty `Files:` set is the same
   blocker. Parallel mode gets this from the worktree boundary and `codex-flow:parallel-execution`'s
   undeclared-file stop instead. If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand.
   Inspect what Codex did: use the returned `diff` field (git status + patch) and read changed files where the patch is not enough; for diffs over 400 lines follow the `codex-flow:context-discipline` no-raw-read rules.
2. Review in order: conformance → quality → security, per the loaded skills.
3. Read the tool result's `accepted` verdict first (`true` only when the run succeeded AND its
   `verification` passed — or no `verifyCommand` was given; `accepted: false` means treat the task
   as not done until you know why), then its `verification` field: `passed: true` is evidence the task's
   acceptance command ran green in the workspace; `passed: false` (or `skipped`) means the task is
   not done regardless of what `agentMessage` says — quote `outputTail` in the finding. Do NOT
   re-run the full test suite per task — `verifyCommand` is the single authoritative acceptance run;
   the full suite runs once per merged parallel wave (integration review) and once in the
   whole-feature review (step 8), where failures are compared against the **known-red baseline** in
   PLAN.md so only new ones count against the task. Codex's claim is input, not evidence: check the
   result's `commands` list for what actually ran.
4. **Collect the Codex-side review** started in step 1 (wait for the subagent; in the sequential
   fallback call `mcp__codex__codex_review` now with the same focus block and `scope`, which
   restrict the review to this task).
   Read Codex's findings from the result's `reviewFindings` field: when
   `parsed: true`, its `findings[]` and `improvements[]` are the Codex review — do not re-derive severities from the prose; when
   `parsed: false`, tell the user, fall back to the prose `agentMessage`, and treat any severity you
   assign yourself as unverified until checked. `reviewFindings.dropped > 0` blocks acceptance of
   this task: the reviewer MUST read `reviewFindings.droppedReasons` (one ordered reason per dropped
   entry) and report them before treating the review as complete. Re-obtain them in another reviewer
   round or get an explicit user waiver — never reconstruct a dropped entry from the prose, and
   never mark the task done on a review with `dropped > 0`. A finding stamped `inScope: false`
   (counted in `reviewFindings.outOfScopeCount`) is routed to the improvements ledger by default and
   does not block; it blocks only when you verify it affects THIS task's acceptance.
   Compare Claude's and Codex's findings
   per the review-dual comparison protocol (which also carries the buckets, the evidence rule, and
   the AskUserQuestion exceptions), and append non-blocking suggestions from BOTH reviews to
   `.codex-flow/IMPROVEMENTS.md` per that skill; they never block the task. A failed, timed-out, or
   `partial` `codex_review` falls back to Claude-only review per that skill.
5. **If issues found**: route verified CRITICAL/HIGH findings from EITHER review to the task's
   recorded Session line via `mcp__codex__codex_continue` (passing the same `verifyCommand`, see
   Phase 4 step 1, so acceptance re-runs mechanically), never to the fresh reviewer session from
   `mcp__codex__codex_review`, using the review-feedback format (numbered, severity-tagged,
   file:line, expected vs observed). If `codex_continue` fails because the
   recorded session is gone (expired or compacted), fall back to a fresh `codex_execute` fix task
   that embeds the finding text plus the task's `.codex-flow/CONTEXT-T<n>.md` slice; never hand-edit
   Codex's code. The fallback `codex_execute` also passes the same `verifyCommand`. Then re-review. Repeat up to 3 rounds per task.
6. **Plan drift**: when a finding traces to the PLAN being wrong (wrong architecture, missed
   requirement) rather than Codex mis-implementing it, do NOT burn review rounds. Run this
   plan-change transaction before execution resumes: FIRST durably set
   `backlogApproved: no (plan drift <ISO date>)` and `phase: backlog` in STATE.md → amend PLAN.md
   with user approval → write an impact analysis listing which done and pending tasks the change
   touches → update the affected
   TASKS.md `Steps` / `Files` / `Requirements` / `Acceptance` fields → re-run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`
   (If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand.) plus the `plan-backlog` backlog sanity checks → regenerate affected slices → recompute waves →
   get backlog re-approval → only then restore
   `backlogApproved: yes (<ISO 8601 timestamp>)` and return `phase` to `execution`. Improvement
   tasks appended at the improvement decision gate go through the same mini-transaction — state
   invalidation first, impact analysis, coverage lint, backlog sanity checks, re-approval, then
   approval and phase restoration — before they are scheduled.
7. **If clean**: complete the durable handoff while the task remains `in-progress`. In sequential
   mode first set `taskStage handoff` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set taskStage handoff`
   (parallel mode does this once per wave in Step 3.8).
   **Sequential mode**: append the Decision-log schema block, append this
   task's section to the report dir's `tasks.md`, append its dual-review record to `reviews.md`, and
   make the checkpoint commit when enabled. When a task is dropped or abandoned, record it with
   `Result: dropped` at the moment of that decision. After every required write succeeds, update
   TaskUpdate, then make the LAST durable task write: set `- Status:` to `done` via
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" task T<n> done`, which appends the bare transition line
   `  - <ISO 8601 ts> in-progress -> done` (the session id lives on the task's `- Session:` line and
   in the Decision log, never as a suffix), then set `taskStage idle` and
   `currentTask -`. With the full durable handoff and final status transition on disk, take the
   `codex-flow:context-discipline` sequential-task compaction point, then move to the next task.
   **Parallel mode**: follow `codex-flow:parallel-execution`'s wave workflow — always commit each
   passed worktree task, and after the wave merge and passing integration review the coordinator
   appends the schema blocks and takes the wave compaction point.
8. **After the last task**: set `phase` to `review` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set phase review` (the only place
   `phase: review` is written) and reset `wave -`. Then do a whole-feature dual review — Claude's pass PLUS a required
   `mcp__codex__codex_review`. Review the baseline-to-working-tree diff with
   `git diff runBaselineRef` (the one-argument form), taking `runBaselineRef` from
   `.codex-flow/STATE.md`; never use a resume-point ref for final review. This includes
   checkpoint/merge commits plus staged and unstaged changes. Also inspect untracked files from
   `git status --porcelain`. When `dirtyBaseline` names `baseline-dirty.patch`, subtract the
   run-start hunks and untracked paths recorded in that manifest when attributing run changes;
   report them as pre-existing instead. Compare current failures against the original
   `knownRed` list from STATE.md; only failures absent from that run-start list are new. The step-4
   rule for a failed, timed-out, or `partial` `codex_review` applies here too. Compare the final
   findings per the review-dual comparison protocol, verify every finding, and append non-blocking
   suggestions from BOTH reviews to `.codex-flow/IMPROVEMENTS.md`. Route verified CRITICAL/HIGH
   findings to the relevant Phase-4 IMPLEMENTATION `sessionId` through the same
   `mcp__codex__codex_continue` fix/re-review loop; repeat up to 3 rounds before delivery. Run the
   full test suite, AND verify the feature end-to-end by exercising the changed behavior (run the
   app/flow, not only unit tests). Re-run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md --plan .codex-flow/PLAN.md`;
   If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. Walk the effective
   REQUIREMENTS.md set ID-by-ID, reporting met/not-met with evidence (test name, file, or
   demonstrated behavior); any not-met ID blocks completion. Then summarize the delivered change,
   remaining risks, and suggest a commit message. With per-task checkpoint commits, offer to squash
   the `wip(codex-flow)` commits into one clean commit (or keep them — user's call). Do not commit
   or squash unless the user asks. Record the final comparison in the report dir's `reviews.md` per
   `codex-flow:session-report`, and once in the Decision log using the non-task event-block schema
   from `codex-flow:plan-architecture`. When any Decision-log block of this run records a contract
   deviation under `Contracts touched` or a Decision naming an architecture change, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/project-context.mjs" --refresh` and show the user the
   resulting `.codex-flow/PROJECT.md` diff for confirmation (owner notes survive a refresh).
9. **Improvement decision gate**: run it per `codex-flow:review-dual`, which carries the whole gate
   (pending-entry definition, the missing-ledger "no improvements" case, slicing approved items into
   `.codex-flow/TASKS.md` with `(approved: T<n>)` / `(declined)` ledger markers, and the no-re-trigger
   rule for gate-spawned tasks). Before appending any approved task, FIRST durably set
   `backlogApproved: no (improvement tasks <ISO date>)` and `phase: backlog` in STATE.md. Slice
   approved items into new tasks appended to `.codex-flow/TASKS.md`.
   Run the impact analysis, the coverage lint with `--plan .codex-flow/PLAN.md`, and backlog sanity
   checks, then get backlog re-approval;
   only afterward restore `backlogApproved: yes (<ISO 8601 timestamp>)` and return `phase` to
   `execution` before scheduling the new tasks, which run through the normal Phase 4 → Phase 5 loop.
   After the improvement decision gate has fully resolved — all approved improvement tasks have
   been executed and reviewed, or no improvements are pending — and just before delivering the
   final summary, generate `cost.md` from the project root per `codex-flow:session-report`. Read
   `<session-start ISO>` from PLAN.md's recorded `- Session start: <ISO 8601>` line, falling back to
   the report-dir timestamp in local time, and run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-cost.mjs" --since "<session-start ISO>" --cwd "$PWD"`
   If the helper is not found, STOP and tell the user to reinstall the codex-flow plugin (its scripts/ directory is required); if it is present but exits non-zero, surface the error to the user and STOP. Never edit control files by hand. Embed its output in `cost.md`; always include the Claude
   qualitative section, never fabricate numbers, and never embed raw stderr.
   Generate `SUMMARY.md` in the report dir per `codex-flow:session-report` and mention both
   reports in the final delivery summary. Only after the improvement gate and all final review, requirement,
   cost, report, and delivery gates complete, set `phase` in `.codex-flow/STATE.md` to `complete`
   with `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set phase complete`.
10. **Retro**: per `codex-flow:skill-selection` Step 8, if the flow produced reusable domain
   knowledge no indexed skill covers, offer to save it as a new skill in the local library and
   rebuild the index.

Rules:
- Never skip the interview, plan approval, or backlog approval.
- Never fix Codex's code yourself in rounds 1–3 — send findings back via `codex_continue` so the Codex session stays consistent. Only fix by hand if 3 rounds fail, tell the user, and re-run the task's acceptance checks before marking it done. (Under the Executor fallback there is no Codex session: Claude fixes directly, still within the 3-round cap and with the acceptance checks re-run every round.)
- Never switch executors silently or mid-task — an outage triggers exactly one AskUserQuestion per the Executor fallback section, and the switch is recorded in STATE.md `executor` plus the Decision log.
- Phase 4 step 2's retry rule is absolute: after bounded auto-resume, ask the user before any
  manual retry (quota is not free).
