---
description: "6-phase workflow: preflight → Claude interviews → plans architecture → breaks backlog → Codex executes per task → Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude + Codex

Task: $ARGUMENTS

Follow these six phases (0–5) strictly. Do NOT write implementation code yourself — Codex does the implementation.

Each phase names plugin skills (`codex-flow:*`) to load via the Skill tool before starting the phase — they carry the detailed checklists. If a named skill is unavailable (command installed without the plugin), continue with the phase instructions below as written.

## Phase 0 — Preflight (gate, do this FIRST)

**Load skill first**: `codex-flow:preflight` (health gate, resume check, workspace baseline) — it carries the detailed checklist for the steps below.

Call `mcp__codex__codex_health` before anything else:

- **Tool call fails / server missing** → the MCP server is not set up. Tell the user to follow the
  install steps in the codex-mcp README (or run `node scripts/doctor.mjs` in the codex-mcp repo),
  then offer the **Executor fallback** (section below): fix Codex and re-check, or continue with
  Claude as executor. Never continue silently.
- **`loggedIn: false`** → tell the user to run `codex login` in their terminal (ChatGPT
  Plus/Pro/Team, or set `OPENAI_API_KEY`), then offer the **Executor fallback**: re-check after
  login, or continue with Claude as executor. Do not interview, plan, or execute anything until
  either a re-check shows `loggedIn: true` or the user has explicitly chosen the fallback.
- **`loggedIn: true`** → report the Codex version, keep `executor: codex`, and continue.

Exception: a failed health check or missing login does NOT block the **analysis lane** of the
Fast-path gate below — that lane needs no Codex session and no fallback decision. Tell the user
about the health failure, then proceed in the analysis lane; the small-change lane and the full
flow require either `loggedIn: true` or an explicit Executor-fallback choice.

**Resume check** — if `.codex-flow/STATE.md` exists, treat it as an interrupted run and offer
**resume** or **restart**, even when PLAN.md or TASKS.md has not been created yet. STATE.md is the
resume authority: skip only phases whose approvals STATE.md records, and enter the first unapproved
phase. Then route from STATE.md's recorded `phase`: for `phase: execution`, enter Phase 4 at the
first task not marked done; for `phase: review`, resume Phase 5 completion work. When all tasks are
done but `phase` is not `complete`, resume Phase 5 for the final dual review, requirement ID-walk,
improvement gate, cost/report delivery gates, and completion write instead of concluding there is
nothing to do.

When both `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md` exist, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume` and read
`.codex-flow/RESUME.md` (statuses, next task, and staleness-stamped state within a fixed budget)
instead of raw PLAN.md + TASKS.md. If the slice helper is unavailable in a standalone install, fall
back to reading `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md` directly. If the helper is present
but exits non-zero, surface the error to the user and STOP; never use the standalone fallback for a
failing helper. When either file is missing, read only the control files that exist; do not require
a missing TASKS.md to resume an earlier phase. When TASKS.md exists, show the user its task
Statuses. On resume, write the current `git rev-parse HEAD` to `resumeHead` and update `phase` to the
phase being entered; change no other state field as part of the resume operation. On restart,
archive the old control files that exist to `.codex-flow/archive/<timestamp>/` and begin fresh.

If STATE.md does not exist, do not offer resume. Treat any PLAN.md or TASKS.md as orphaned control
files and offer to archive them before beginning a fresh run.

Before baselining, evaluate the **Fast-path gate** (next section). When the task qualifies and the
user confirms the fast path, run only baseline step 1 below as an informational check and skip
steps 2–5 — a fast-path run writes no `.codex-flow/` control files and needs no known-red baseline.

Then baseline the workspace (in the project root):

1. `git status --porcelain` — if the tree is dirty, ask the user: commit/stash first
   (recommended, gives clean per-task diffs and a rollback point) or proceed with the dirty
   baseline noted in PLAN.md. If the user proceeds dirty, save `git diff HEAD` to
   `.codex-flow/baseline-dirty.patch`, then append a `# Untracked at run start` comment header with
   every untracked path from `git status --porcelain`. Record the baseline ref
   (`git rev-parse HEAD`). If the cwd is not a git repo, tell the user
   diffs/checkpoints/rollback are unavailable and confirm before continuing.
2. Ensure `.codex-flow/live/` is in the project's `.gitignore` (append it if missing) so raw
   live-progress JSONL logs never land in checkpoint or final commits.
3. Detect the project's test command and run it once. Record any pre-existing failures as the
   **known-red baseline** — these are not Codex's fault, and Phase 5 compares against this list
   instead of blaming Codex for old breakage. If the suite can't run at all, tell the user and
   agree on how results will be verified before continuing.
4. On a fresh run, create `.codex-flow/reports/<YYYYMMDD-HHMMSS>/` using the session-start
   local-time timestamp. On resume, reuse the report dir recorded under `## Session report` in the
   existing PLAN.md, creating it only if missing. This is the single session report dir that later
   phases write into per `codex-flow:session-report`.
5. After baselining a fresh run, write `.codex-flow/STATE.md` per `codex-flow:preflight`, with
   `phase: interview`, all approvals `no`, `runBaselineRef` set to the run-start git HEAD,
   `resumeHead` empty, the compact original `knownRed` list, `checkpointCommits` empty, and
   `executionMode: undecided`. Set `dirtyBaseline` to `baseline-dirty.patch` when the user proceeded
   dirty, otherwise `none`. Set `executor` to `codex`, or to the fallback value when the user chose
   the Executor fallback in the health gate. The orchestrator is the only writer. Never modify `runBaselineRef`,
   `knownRed`, or `dirtyBaseline` on resume.

## Fast-path gate — small and analysis-only tasks

The full six-phase flow exists for multi-task feature work. Its fixed overhead (interview docs,
PLAN/TASKS/STATE, per-task slices, dual review, reports) is the wrong cost for a small or
read-only task, so route those through one of two lite lanes instead. Evaluate this gate right
after the preflight health and resume checks, before any control file is written.

**Eligibility** — the task must fit ONE of these lanes, and NONE of the exclusions:

- **Analysis lane**: the deliverable is an answer, report, or data readout; no tracked project
  file is created or modified. Examples: "why is X slow", "analyze this export", "compare these
  two builds", "review this module's structure".
- **Small-change lane**: a well-specified change touching ≤ 2 files with unambiguous requirements
  and a checkable outcome. Examples: a config flag, a copy fix, a single-function bug fix with a
  known repro.

**Exclusions (always full flow)**: security-sensitive changes (auth, payments, secrets,
migrations, input handling), changes spanning components or contracts, ambiguous requirements
that need real elicitation, anything the user explicitly asked to run as the full flow. When
unsure, ask the user one question: fast path or full flow.

**Analysis lane workflow**: Claude works directly — read code, run read-only commands, query
data — and delivers the findings with a short "what I verified" note. No Codex session is
required (this lane is exempt from the Codex health gate); use a single read-only
`mcp__codex__codex_execute` only when an independent second opinion adds value AND Codex is
healthy. For any data-analysis work, follow the Data tooling rules in
`codex-flow:exec-deliverable` (measure input sizes first, ingest-once columnar tooling,
sample-first iteration) — never row-by-row scripts over large raw files.

**Small-change lane workflow**: first run the project's test command once and note any
pre-existing failures as the lane's known-red list — only failures NOT on that list count against
the change. Then one `mcp__codex__codex_execute` carrying the same embedded blocks
Phase 4 would use (`codex-flow:exec-coding-standards`, `codex-flow:exec-self-testing`, the
project-language skill), then ONE Claude review pass in Phase 5 order (conformance → quality →
security triggers, per `codex-flow:review-conformance`, `codex-flow:review-quality`,
`codex-flow:review-security`) plus running the relevant tests yourself against that known-red
list. Skip the dual `codex_review`, backlog, reports, and improvement gate. Route fixes back via
`mcp__codex__codex_continue`, up to 3 rounds as usual. Do not commit unless the user asks.

**Scope trip-wire (mechanical, not judgment)**: after each small-change `codex_execute` or
`codex_continue` returns, diff the actual changed files (the returned `diff` plus
`git status --porcelain`) against the ≤ 2 files the lane was entered with. ANY extra changed
file — excluding generated lockfiles — triggers the escalation rule automatically; do not review
the oversized diff in-lane and do not re-argue eligibility after the fact.

**Fast-path log**: append one line per fast-path run to `.codex-flow/notes/fastpath.log`:
`<ISO 8601> <analysis|small-change> <one-line task> session=<sessionId or -> outcome=<delivered|done|escalated|failed>`.
The recorded sessionId is what later `codex_continue` fix rounds attach to; the log is the only
durable trace a fast-path run leaves, so write it even on escalation or failure.

**Escalation rule**: the moment fast-path work reveals the task is bigger than its lane — more
files than declared (the trip-wire), architectural impact, hidden ambiguity — STOP, log
`outcome=escalated` with a note of any partial work that exists, tell the user what changed,
and restart at Phase 1 with the full flow. A wrong up-front size estimate is not a failure;
stretching the lane to avoid the restart is. Never stretch a lane.

## Executor fallback — Claude executes when Codex is unavailable

Codex is the default executor. When it cannot run, the flow does not die: the user chooses once,
explicitly, between fixing Codex and letting Claude execute. The planning, approval, review, and
reporting contract stays identical; only WHO writes the code changes.

**Triggers** (any one):
- Phase 0: `mcp__codex__codex_health` tool call fails, the server is missing, or `loggedIn: false`.
- Mid-run: a `codex_execute` / `codex_continue` / `codex_review` returns `failed` or `aborted` with
  no `sessionId`, or its `errors`/`stderr` indicate authentication, quota exhaustion, or an
  unreachable service — AND an immediate `mcp__codex__codex_health` re-check is not healthy.
- Mid-run: the same task exhausts bounded auto-resume twice in a row (`attempts`/`resumeReasons`).

**Decision** — use AskUserQuestion exactly once per outage with two options: **Fix Codex and
re-check** (recommended when the user can log in or restore service now) or **Continue with Claude
as executor**. Never switch executors silently, and never switch mid-task: finish or reset the
current task first (per the preflight in-progress reconciliation), then switch at the task boundary.

**Recording** — STATE.md carries `executor: codex` by default. On fallback set
`executor: claude (fallback: <not-logged-in | server-missing | codex-unavailable> <ISO 8601>)`;
on return set `executor: codex (restored <ISO 8601>)`. Record each switch once in PLAN.md's
Decision log using the non-task event-block schema from `codex-flow:plan-architecture`.

**Phase 4 under fallback** — for each task in dependency order, sequential mode only:
- Generate and read the task's `.codex-flow/CONTEXT-T<n>.md` slice exactly as for Codex, and apply
  the loaded `exec-coding-standards`, `exec-self-testing`, language, deliverable, and distilled
  domain-skill blocks to your own work — they bind Claude the same way they bind Codex.
- Perform the same durable pre-launch writes, but write `- Session: claude-fallback (base: <short sha>)`.
- Implement ONLY this task, within its `Files:` scope. Run the task's acceptance command yourself
  and record `- Verification: <command> → exit <code>` in the task's report entry; this replaces
  the server-side `verification` field.
- Parallel worktree mode is not available under fallback; when `task-waves` reports width > 1,
  still run sequentially and note it in the Decision log.

**Phase 5 under fallback** — Claude must not grade its own homework alone:
- Replace `mcp__codex__codex_review` with an independent review by a fresh subagent (a code-review
  agent, or a general-purpose agent with the review skills), given the same focus block from
  `codex-flow:review-dual` (task id, acceptance criteria, `Files:` list, review order).
- Run your own conformance → quality → security pass as usual, then apply the review-dual
  comparison protocol to the two reviews.
- Fix verified CRITICAL/HIGH findings directly (there is no Codex session to route them to), re-run
  the acceptance checks and the suite after every round, and keep the 3-round cap; after 3 rounds,
  stop and re-plan the task with the user.
- Report PIC for a fallback task is `claude (fallback: <reason>)` per `codex-flow:session-report`;
  `cost.md` reports measured Codex cost for the run's Codex tasks only and says so.

**Returning to Codex** — at any task boundary, when the user says Codex is available again, re-run
`mcp__codex__codex_health`; on `loggedIn: true` restore `executor: codex (restored <ISO 8601>)` and
run the remaining tasks through Codex normally. Tasks completed under fallback keep their
`claude-fallback` Session line and are never re-executed.

**Fast-path small-change lane under fallback** — allowed: Claude implements the ≤ 2 files itself
under the same embedded blocks, runs the lane's known-red comparison, and gets the independent
subagent review in place of the skipped `codex_review`. Log `session=claude-fallback` in
`fastpath.log`.

## Phase 1 — Interview (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:interview-elicitation` (six question domains, stop condition) and `codex-flow:interview-ask-back` (5 Whys, example probing, hidden assumptions).

Interview the user with AskUserQuestion following those skills. Keep asking until every acceptance criterion is verifiable, then write the Requirements Summary and get confirmation.

Immediately after confirmation, write the confirmed Requirements Summary VERBATIM to
`.codex-flow/REQUIREMENTS.md` using the `codex-flow:interview-elicitation` format. Do not start
Phase 2 until the write completes.
Immediately when the user grants requirements approval, set `requirementsApproved` in
`.codex-flow/STATE.md` to `yes (<ISO 8601 timestamp>)` and set `phase` to `plan` before entering
Phase 2.

For a confirmed mid-run requirement delta, append the delta per
`codex-flow:interview-elicitation`, refresh `requirementsApproved` to
`yes (delta <ISO date>)`, reset `planApproved` and `backlogApproved` to
`no (delta <ISO date>)`, and set `phase` to `plan`. Before execution resumes, re-run Phase 2 impact
analysis and plan approval, rebuild the affected backlog, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md`,
and obtain backlog re-approval. A prior approval never survives a requirement delta.

Scale interview depth to task complexity: a small, unambiguous change needs only a short
Requirements Summary and a quick confirmation — don't force the full six-domain interview. A large
or ambiguous feature warrants the full elicitation. When in doubt, ask.

## Phase 2 — Plan & Architecture (Claude)

**Load skills first**: (if not already loaded this session) `codex-flow:plan-research-first` (search existing solutions before designing), `codex-flow:plan-architecture` (convention discovery, option trade-off analysis, PLAN.md structure), `codex-flow:skill-selection` (pick domain skills from the local skill index), and `codex-flow:context-discipline` (Explore subagents, boundary compaction, tiered AGENTS.md).
Also load `codex-flow:session-report` (report templates and PIC rules).

1. Explore the codebase through Explore subagents per `codex-flow:context-discipline` to return conclusions with paths and line anchors.
2. **Select domain skills from the local index** per `codex-flow:skill-selection`: derive search
   terms from the confirmed requirements + acceptance criteria + stack, grep the index, load every relevant skill that fits a
   ~3%-of-context budget (≈6000 tokens; no fixed count) and concretely changes the plan or the
   Codex prompts. Do NOT install or blind-load whole collections. The index scans the user's
   skills, the skill library, AND every installed plugin's `skills/` dir — rebuild it before
   concluding a domain is uncovered. 0 index matches is fine as a *matching* result but never as a
   *selection* result: for each uncovered facet the plan depends on, run `codex-flow:skill-selection`
   Step 7 to closure — re-index, vet an unvetted candidate, search for an existing skill, and if
   nothing can be adopted, **author the missing `SKILL.md` now** (before execution), rebuild the
   index, and load it. Record adopted/authored skills in PLAN.md *Skills plan*; a domain task must
   never reach Phase 4 with an empty `Skills:` field.
   **Every facet must end in one explicit verdict** — `LOAD` (named skills + paths), `VET` (named
   indexed candidates being vetted now), or `AUTHOR` (named skill to write via Step 7c/7d) — stated
   in PLAN.md *Skills plan* and to the user. Prose like "no relevant skills found" is not a verdict,
   and a `LOAD` verdict may not name a skill whose stated purpose does not match the facet.
   A facet whose loaded skills do not cover its requirements and acceptance criteria must record
   `INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)` (or `INSUFFICIENT → VET (gap: R<n>.<m>, …)`) in
   PLAN.md *Skills plan*; loaded-but-insufficient is never a silent pass. Retain the covered parts
   and escalate to Step 7 for the missing part only. Authoring is brief-first: generate
   `.codex-flow/SKILL-BRIEF-<facet>.md` via
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>`
   Multiword `--facet` values must be quoted; the output filename uses the facet slug (lowercase,
   spaces→`-`, other characters stripped).
   First write the authored skill to `<library>/quarantine/authored/<skill-name>/SKILL.md`;
   quarantine is never indexed.
   Pass the R-IDs recorded in the verdict (`AUTHOR (gap: …)` / `INSUFFICIENT → AUTHOR (gap: …)`)
   as `--rids`; omit `--rids` only when no gap IDs were recorded. Author the skill against the
   brief, then require
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-lint.mjs" <SKILL.md path>` to pass. The run's authored
   skills must get `one batched AskUserQuestion` approval before they are indexed, loaded, or
   embedded.
   The order is fixed: brief → author → lint → one batched approval → only then rebuild the index
   and load/embed — indexing or loading an authored skill before its approval is a defect.
   Promotion into the trusted library at `<library>/<skill-name>/SKILL.md` happens only after the
   lint pass and that batched approval.
3. Write `.codex-flow/PLAN.md` in the project root containing:
   - **Context**: what the project is, conventions Codex must follow
   - **Objective**: the confirmed goal from Phase 1
   - **Architecture**: components/modules touched, data flow, key design decisions and why
   - **Contracts**: the fixed seams between components — signatures, data shapes, API/event
     contracts — pinned down before slicing so tasks are independent and review against a stable
     contract (see `codex-flow:plan-architecture` Step 3)
   - **Component → files**: each component mapped to the exact files it creates/modifies — the
     backlog slices along this, and disjoint file sets are what let tasks run in parallel
   - **Risk & blast radius**: sensitive areas the change touches (auth, data, migrations, config),
     what could break beyond the target files, and the rollback point (baseline ref from Phase 0)
   - **Skills plan**:
     - *Verdict per facet*: one of `LOAD` / `VET` / `AUTHOR` for every facet the plan depends on —
       there is no empty state, because a facet with no indexed match resolves to `AUTHOR`
     - *Skills to use*: the domain skills selected in step 2 (name, path, what each informs), plus
       any skill authored in this flow
     - *Skills to create*: the `AUTHOR` verdicts still outstanding (working name, the gap each fills,
       the needed rules inline); write `*Skills to create*: —` only when every facet resolved to
       `LOAD` or `VET`
   - **Known-red baseline**: pre-existing test failures from Phase 0
   - **Out of scope**: things Codex must NOT do
   - **Acceptance criteria**: how the result will be verified (tests to pass, behaviors to check)
     Every entry must cite the R-IDs it covers, for example
     `- A3 (covers R2.1, R2.2): ...`.
   - **Session report**: path of the report dir and exact session-start ISO 8601 value
   - **Decision log**: empty, append-only — filled during execution
4. Show the plan to the user and get approval before continuing.
   Record the grant timestamp, but do not update STATE.md yet.
5. After approval, generate/update tiered AGENTS.md per `codex-flow:context-discipline`: root plus
   each package in the approved PLAN.md **Component → files** map whose conventions differ from
   root; make additive-only changes. Before Phase 3, commit all AGENTS.md creations/updates as
   `docs(agents): update AGENTS.md guidance` so sequential runs and parallel worktrees branch from
   HEAD with the guidance and a clean tracked baseline.
6. After approval, write `planning.md` to the report dir per `codex-flow:session-report`. Under a
   `## Session report` heading in PLAN.md, record `- Report dir: <report dir>` and
   `- Session start: <ISO 8601>`.
7. Only after steps 5 and 6 complete, set `planApproved` in `.codex-flow/STATE.md` to
   `yes (<ISO 8601 timestamp>)` using the user's grant time, then set `phase` to `backlog` before
   entering Phase 3. Never persist Phase 2 approval before its post-approval artifacts are durable.

## Phase 3 — Backlog (Claude)

**Load skill first**: `codex-flow:plan-backlog` (slicing rules, dependency ordering, sanity checks).

At the approval boundary after preparing the backlog below, immediately when the user grants
backlog approval, set `backlogApproved` in `.codex-flow/STATE.md` to
`yes (<ISO 8601 timestamp>)`, record the checkpoint choice in `checkpointCommits`, record the
selected mode in `executionMode`, and set `phase` to `execution` before entering Phase 4.

Decompose the approved plan into tasks and write `.codex-flow/TASKS.md`:

```markdown
## T1: <imperative title>
- Depends on: — | T<n>
- Files: <files to create/modify>
- Requirements: <R-IDs covered>
- Steps: <concrete, file-level steps>
- Skills: <Phase 2 domain skills relevant to THIS task, or — >
- Acceptance: <verifiable criteria for THIS task — tests to pass, behaviors>
- Session: —
- Status: pending
```

Rules for slicing (see `codex-flow:plan-backlog` for the full sizing guidance):
- **Size for one execution AND one review**: one reviewable concern per task, a bounded diff (aim
  ≤ ~5 files / a few hundred lines so review is thorough and stays under the 64 KB diff cap),
  roughly one Codex run (~5–30 min). Split anything bigger.
- **Self-sufficient**: each task must be doable by a fresh Codex session from PLAN.md + the task
  text alone — put needed context in `Steps` and name the files to read, don't rely on prior tasks'
  session memory.
- **Contracts/foundations first**: shared seams (types, schemas, interfaces, migrations) from
  PLAN.md are the earliest tasks so dependents build and review against a fixed contract.
- **Acceptance names the exact check** the reviewer will run (test file/pattern, build command, or a
  concrete probe), not just prose.
- **File-disjoint where independent**: actively reshape task boundaries so independent tasks own
  disjoint `Files:` sets (for example, move a shared helper edit into its own earlier task and make
  the others depend on it). For multi-task backlogs, make `task-waves` width > 1 the norm, not the
  exception.
- Each task independently verifiable; order by dependency (a task may only depend on earlier tasks).
- Decide the skill→task mapping ONCE here (the `Skills:` field), from PLAN.md's *Skills to use*
  plus any *Skills to create* marked before execution — so Phase 4 embeds a consistent,
  user-reviewable set per task instead of re-guessing. Before Phase 4, create every
  before-execution skill by writing its `SKILL.md` and rebuilding the index per
  `codex-flow:skill-selection` Steps 7–8, then list it in each relevant task's `Skills:` field.
  A facet discovered at backlog time whose loaded skills do not cover the task's requirements
  records the same `INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)` (or `→ VET`) qualifier in PLAN.md
  *Skills plan* before the task may enter Phase 4.
  Creation is brief-first: generate `.codex-flow/SKILL-BRIEF-<facet>.md` via
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-brief.mjs" --facet <facet> --rids <gap R-IDs>`
  Multiword `--facet` values must be quoted; the output filename uses the facet slug (lowercase,
  spaces→`-`, other characters stripped).
  First write the authored skill to `<library>/quarantine/authored/<skill-name>/SKILL.md`;
  quarantine is never indexed.
  Pass the R-IDs recorded in the verdict (`AUTHOR (gap: …)` / `INSUFFICIENT → AUTHOR (gap: …)`)
  as `--rids`; omit `--rids` only when no gap IDs were recorded. Author the skill against the
  brief, and require
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/skill-lint.mjs" <SKILL.md path>` to pass. The run's authored
  skills must get `one batched AskUserQuestion` approval before they are indexed, loaded, or
  embedded.
  The order is fixed: brief → author → lint → one batched approval → only then rebuild the index
  and load/embed — indexing or loading an authored skill before its approval is a defect.
  Promotion into the trusted library at `<library>/<skill-name>/SKILL.md` happens only after the
  lint pass and that batched approval.
  Keep retro-timed entries as PLAN.md rule blocks and embed those rules directly in the relevant
  task prompt.
- Also mirror the tasks with TaskCreate so the user sees live progress.

Before asking for backlog approval, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md`.
Every effective R<n>.<m> must be cited by at least one task and no task may cite an unknown ID; fix
the backlog before presenting it for approval. If the helper is unavailable in a standalone
install, verify those two conditions manually. If the helper is present but exits non-zero,
surface the error to the user and STOP; never continue to backlog approval with a failing helper.

Show the backlog to the user and get approval before executing. At the same time ask once:
**checkpoint commits after each passed task — yes/no?** (recommended yes on multi-task backlogs;
gives per-task rollback points).
After backlog approval, write `allocation.md` (task → PIC table) to the report dir per
`codex-flow:session-report`.

## Phase 4 — Execution (Codex)

**Load skills first (code tasks)**: (if not already loaded this session) `codex-flow:exec-coding-standards` and `codex-flow:exec-self-testing` (blocks to embed into every Codex prompt), `codex-flow:context-discipline` (no-raw-read, task-boundary compaction), plus the language skill matching the project: `codex-flow:exec-typescript`, `codex-flow:exec-python`, `codex-flow:exec-go`, `codex-flow:exec-jvm` (Java/Kotlin), `codex-flow:exec-rust`, `codex-flow:exec-csharp`, `codex-flow:exec-php`, `codex-flow:exec-ruby`, `codex-flow:exec-swift`, or `codex-flow:exec-cpp` (C/C++). If the project's language has no exec skill, use `codex-flow:exec-coding-standards` alone plus any language guidance from the skill index. Codex cannot see Claude's skills — the prompt is the only channel, so these standards blocks MUST be embedded in the prompt text. When a task must illustrate a chart/graph (code OR deliverable), also load `codex-flow:exec-visualization` so Codex routes the chart to flint-chart (PNG/SVG) instead of ad-hoc Python.

**Non-code tasks**: when a task produces content instead of code (data analysis, marketing copy, docs, research, a plan), load `codex-flow:exec-deliverable` INSTEAD of `exec-coding-standards` + `exec-self-testing` + the language skill, and embed its deliverable + verification blocks. A mixed backlog picks per task: code tasks get the coding blocks, content tasks get the deliverable block. The selected domain skills (from Phase 2) are embedded either way. `codex-flow:context-discipline` still applies either way.

**Data processing tooling**: the project-language skill governs code that lands in the repo, NOT ad-hoc data processing inside a task. Whenever a task reads or transforms a dataset beyond ~50 MB — measure with `du -h` first, never guess sizes — (in any lane, code or content), also embed the Data tooling block from `codex-flow:exec-deliverable`: ingest once into columnar tooling (DuckDB first), iterate on a sample, run the full pass once at the end — never let Codex write row-by-row scan scripts over large raw files just because the repo happens to be TypeScript/Node (or any other language).

**Sequential vs parallel**: always run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/task-waves.mjs" .codex-flow/TASKS.md` to compute execution
waves from the `Depends on:` + `Files:` metadata. When it reports width > 1, **parallel mode is the
default**: load `codex-flow:parallel-execution` and follow it (one git worktree + subagent per
concurrent task, then merge + integration-review per wave), including its clean tracked-baseline
gate, serial worktree creation + control-file copy, and mandatory reviewed task commit before
merge. Proceed without asking for waves of ≤3 concurrent tasks; when a wave exceeds 3, ask the
user before running it at that width because parallel mode costs N× simultaneous quota. Stay
sequential only when the tool reports "fully sequential", the user opted out of parallel mode,
the project is not a git repo, or the tracked baseline cannot be made clean.

For each task in dependency order (sequential mode):

1. Before each `mcp__codex__codex_execute`, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>`. If the helper is present
   but exits non-zero, surface the error to the user and STOP; never use the standalone fallback for
   a failing helper. If it reports `mandatory slice content exceeds tokenBudget`, split the
   oversized task in the backlog before continuing; never raise the slice budget. Immediately
   before the call, record `git rev-parse --short HEAD` as the task's base sha. In the same durable
   update, set the task's `- Status:` line to `in-progress`, append
   `  - <ISO 8601 ts> pending -> in-progress` beneath it, and write
   `- Session: launching (base: <short sha>)`. Complete all three writes before calling
   `mcp__codex__codex_execute` with:
   - `prompt`: start the assembled prompt with the single header line `Run position: phase execution — task T<n> <title> — next gate: <gate>`. Then use the opener "Read .codex-flow/CONTEXT-T<n>.md for context (a budgeted slice of PLAN.md; its header records the generation anchor, and blocks marked [verify] must be re-checked against the current code before relying on them)." when the slice was generated, or "Read .codex-flow/PLAN.md for context." when the helper is unavailable in a standalone install. When the slice was generated, append "Implement task T<n> exactly as specified below, and only this task. Run its acceptance checks before finishing." + the standards, testing, and language blocks from the loaded skills (or the `exec-deliverable` blocks for a non-code task) + a distilled ≤ 30-line rules block for each skill listed in the task's `Skills:` field (see `codex-flow:skill-selection` Step 6 — never paste a whole SKILL.md); do not append the full task text because the slice already embeds it as mandatory content. In the standalone fallback, append the same directive + the full task text + those same standards/testing/language, deliverable, and distilled skill blocks.
   - `cwd`: absolute path of the project root
   - `sandbox`: `workspace-write` by default. Use `read-only` for investigation-only tasks; use `danger-full-access` ONLY when the task genuinely needs network or a global install — and tell the user before doing so.
   - `model`: match the task's complexity — a stronger model for architectural, cross-cutting, or subtle-logic tasks; the default (or a faster/cheaper model) for small, mechanical, well-specified tasks. Note the choice in the Decision log.
   - `reasoningEffort`: map task complexity explicitly — `low` for mechanical, well-specified tasks; omit it for standard implementation work (use the CLI default); `high` for architectural, cross-cutting, or subtle-logic tasks. Note the choice in the Decision log.
   - `timeoutMs`: default 60 min; scale UP for large tasks rather than letting them die. The server automatically resumes a timed-out or dropped session within bounded limits. Do NOT immediately retry a failed run manually — inspect `attempts` and `resumeReasons` in the payload first, and ask the user before retrying only after the server's auto-resume allowance has already been used.
   - `terminal`: `true` — opens a live-progress terminal window when supported; progress also streams into the session via MCP notifications; on macOS, the window closes itself after a successful run and stays open on failure
   - `verifyCommand`: the task's exact acceptance check from its `Acceptance:` field (test file/pattern or build command, e.g. `npx vitest run tests/foo.test.ts`). The server runs it in `cwd` after the run settles and returns `verification` (`exitCode`, `passed`, `outputTail`) — deterministic evidence that the check ran, independent of Codex's account. Pass the same `verifyCommand` on every `codex_continue` fix round. Omit only when the acceptance is a manual probe with no command.
2. **Check the returned `status` field** before anything else:
   - `success` → proceed normally.
   - `partial` (not a tool error) → the run ended without a completion marker or with unparseable
     event lines after any bounded auto-resume, so Codex's own account of the run is suspect.
     Inspect `attempts`/`resumeReasons`, `diff`/`attribution`, and the live log; explicitly verify
     the acceptance checks before treating it as done, and ask the user before any manual retry.
   - `failed` / `aborted` (tool error) → inspect `attempts`/`resumeReasons` first. If bounded
     auto-resume was exhausted or the failure was ineligible for auto-resume, report it and ask the
     user before any manual retry (see Rules below).
3. **Save the returned `sessionId`** — when `codex_execute` returns, replace the task's launching
   Session line with `- Session: <sessionId> (cwd: <path>, base: <short sha>)`, preserving the base
   recorded before the call. Reviews and fix rounds in Phase 5 go
   back into the session recorded on that line. The DEFAULT is a fresh `codex_execute` per task;
   use `codex_continue` for review/fix rounds within the same task. Cross-task session reuse is
   allowed only when the next task directly depends on the previous task AND stays in the same
   domain, and is capped at that one adjacent task — after that, start fresh. A fresh session gets
   the new task's distilled skill blocks instead of inheriting stale context from the previous
   domain.
4. Keep the task `in-progress` while it is under review and while its durable handoff is being
   written. Do not mark it done here; Phase 5 step 7 makes that the last durable task write. When a
   task is abandoned, set `- Status:` to `failed`, append
   `  - <ISO 8601 ts> in-progress -> failed (session: <id>; reason: <reason>)`, and update
   TaskUpdate. Transition lines are append-only — never rewrite or delete earlier ones.
5. Run Phase 5 review for the task BEFORE starting the next one.
6. When the task passes review, act as the only per-task writer in sequential mode. Phase 5 step 7
   performs the durable completion handoff in this order: append one schema block (see
   plan-architecture / PLAN.md Contracts) to PLAN.md's **Decision log**, write the task and review
   report entries, and, if the user opted in at Phase 3, make the checkpoint commit
   (`wip(codex-flow): T<n> <title>`). Only after all of those writes succeed may step 7 flip the
   task to `done`; `done` means the complete durable handoff exists.

## Phase 5 — Review (Claude, per task + final)

**Load skills first**: (if not already loaded this session) `codex-flow:review-conformance` (requirement/plan/structure conformance — check FIRST), `codex-flow:review-quality` (correctness hazards, silent failures, test quality), `codex-flow:review-security` (mandatory when the diff touches auth, input, queries, files, or secrets), `codex-flow:review-feedback` (severity levels + codex_continue format), `codex-flow:review-dual` (dual Codex+Claude review, comparison protocol, improvements ledger + decision gate), and `codex-flow:context-discipline` (no-raw-read, task-boundary compaction).
Also load `codex-flow:session-report` (report templates for `tasks.md`, `reviews.md`, `cost.md`, and `SUMMARY.md`).

At the Phase 4 → Phase 5 boundary, set `phase` in `.codex-flow/STATE.md` to `review`.

0. Before reviewing, when the slice helper is available, reuse the existing `.codex-flow/CONTEXT-T<n>.md` only when its generated header's anchor equals the current `git rev-parse HEAD` and the tree is clean; otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --task T<n>` to regenerate this task's `.codex-flow/CONTEXT-T<n>.md` slice, then re-read it and this task's entry in `.codex-flow/TASKS.md`. If the helper is unavailable in a standalone install, fall back to reading `.codex-flow/PLAN.md` directly and still read this task's TASKS.md entry. If the helper is present but exits non-zero, surface the error to the user and STOP; never use the standalone fallback for a failing helper. Treat the files read on disk as the source of truth for acceptance criteria, architecture, `Files:` scope, and the known-red baseline, not session memory (which may have been compacted across a long backlog). Outside the standalone fallback, read full `.codex-flow/PLAN.md` only when a finding disputes plan intent or the slice's omitted-pointer line points at a section the review needs.
1. **Start the Codex-side review in the background FIRST**: `mcp__codex__codex_review` is read-only and independent of your own pass, so do not run it after your review — launch a background subagent (Agent tool, general-purpose) whose only job is to call `mcp__codex__codex_review` for THIS task with the focus block from `codex-flow:review-dual` (task id/title, acceptance criteria, `Files:` list) and return the tool result's `reviewFindings` object plus `status` verbatim, nothing else. Then do steps 2–4 yourself while it runs; collect the subagent's result in step 5. If the Agent tool is unavailable, call `mcp__codex__codex_review` directly at step 5 instead (sequential fallback).
   Inspect what Codex did: use the `diff` field returned by the tool (git status + patch), and read changed files where the patch is not enough. For diffs over 400 lines, follow `codex-flow:context-discipline` no-raw-read rules: get a subagent summary, then read only targeted critical hunks.
2. Review in order: conformance → quality → security, per the loaded skills.
3. Read the tool result's `verification` field first: `passed: true` is evidence the task's
   acceptance command ran green in the workspace; `passed: false` (or `skipped`) means the task is
   not done regardless of what `agentMessage` says — quote `outputTail` in the finding. Then run
   the project's full tests/build yourself — Codex's claim is input, not evidence. Compare
   failures against the **known-red baseline** in PLAN.md: only new failures count against the task.
4. **Collect the Codex-side review** started in step 1 (wait for the subagent; in the sequential
   fallback call `mcp__codex__codex_review` now with the same focus block). Without checkpoint
   commits, the uncommitted diff is cumulative, so the focus block restricts the review to this
   task's scope. Read Codex's findings from the result's `reviewFindings` field: when
   `parsed: true`, its `findings[]` (severity, file, line, summary, expected, observed) and
   `improvements[]` are the Codex review — do not re-derive severities from the prose; when
   `parsed: false`, tell the user, fall back to the prose `agentMessage`, and treat any severity you
   assign yourself as unverified until checked. Compare Claude's and Codex's findings
   per the review-dual comparison protocol: bucket agreed / unique-to-one / conflicting, and verify
   every finding with evidence. Use AskUserQuestion only for an unverifiable CRITICAL/HIGH finding
   or two mutually exclusive valid fixes. Append non-blocking suggestions from BOTH reviews to
   `.codex-flow/IMPROVEMENTS.md` per the review-dual skill; they never block the task. If
   `mcp__codex__codex_review` fails, times out, or returns status `partial`, fall back to Claude-only
   review for this task, tell the user, and do not auto-retry because of quota.
5. **If issues found**: route verified CRITICAL/HIGH findings from EITHER review to the task's
   recorded Session line via `mcp__codex__codex_continue`, never to the fresh reviewer session
   created by `mcp__codex__codex_review`. Use the review-feedback format (numbered,
   severity-tagged, file:line, expected vs observed). If `codex_continue` fails because the
   recorded session is gone (expired or compacted), fall back to a fresh `codex_execute` fix task
   that embeds the finding text plus the task's `.codex-flow/CONTEXT-T<n>.md` slice; never hand-edit
   Codex's code. Then re-review. Repeat up to 3 rounds per task.
6. **Plan drift**: if a finding traces to the PLAN being wrong (wrong architecture, missed
   requirement) rather than Codex mis-implementing it, do NOT burn review rounds. Run this
   plan-change transaction before execution resumes: FIRST durably set
   `backlogApproved: no (plan drift <ISO date>)` and `phase: backlog` in STATE.md → amend PLAN.md
   with user approval → write an impact analysis listing which done and pending tasks the change
   touches → update the affected
   TASKS.md `Steps` / `Files` / `Requirements` / `Acceptance` fields → re-run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md`
   plus the `plan-backlog` backlog sanity checks → regenerate affected slices → recompute waves →
   get backlog re-approval → only then restore
   `backlogApproved: yes (<ISO 8601 timestamp>)` and return `phase` to `execution`. Improvement
   tasks appended at the improvement decision gate go through the same mini-transaction — state
   invalidation first, impact analysis, coverage lint, backlog sanity checks, re-approval, then
   approval and phase restoration — before they are scheduled.
7. **If clean**: complete the durable handoff while the task remains `in-progress`.
   **Sequential mode**: follow Phase 4 step 6: append the Decision-log schema block, append this
   task's section to the report dir's `tasks.md`, append its dual-review record to `reviews.md`, and
   make the checkpoint commit when enabled. When a task is dropped or abandoned, record it with
   `Result: dropped` at the moment of that decision. After every required write succeeds, update
   TaskUpdate, then make the LAST durable task write: set `- Status:` to `done` and append
   `  - <ISO 8601 ts> in-progress -> done (session: <id>)`. Once the full
   durable handoff and final status transition are on disk, verify the durable state,
   tell the user this is a safe compaction point, and suggest running `/compact`; with state on
   disk, an auto-compaction landing at or after the boundary is lossless. Then move to the next task.
   **Parallel mode**: follow `codex-flow:parallel-execution`'s wave workflow: always commit each
   passed worktree task; after the wave merge and passing integration review, the coordinator
   appends the schema blocks, verifies durable state, tells the user this is a safe compaction
   point, and suggests running `/compact`. An auto-compaction at or after that boundary is lossless.
8. **After the last task**: do a whole-feature dual review — Claude's pass PLUS a required
   `mcp__codex__codex_review`. Review the baseline-to-working-tree diff with
   `git diff runBaselineRef` (the one-argument form), taking `runBaselineRef` from
   `.codex-flow/STATE.md`; never use a resume-point ref for final review. This includes
   checkpoint/merge commits plus staged and unstaged changes. Also inspect untracked files from
   `git status --porcelain`. When `dirtyBaseline` names `baseline-dirty.patch`, subtract the
   run-start hunks and untracked paths recorded in that manifest when attributing run changes;
   report them as pre-existing instead. Compare current failures against the original
   `knownRed` list from STATE.md; only failures absent from that run-start list are new. If
   `mcp__codex__codex_review` fails, times out, or returns status `partial`, fall back to Claude-only
   review, tell the user, and do not auto-retry because of quota. Compare the final findings per the
   review-dual comparison protocol, verify every finding, and append non-blocking suggestions from
   BOTH reviews to `.codex-flow/IMPROVEMENTS.md`. Route verified CRITICAL/HIGH findings to the
   relevant Phase-4 IMPLEMENTATION `sessionId` through the same `mcp__codex__codex_continue`
   fix/re-review loop; repeat up to 3 rounds before delivery. Run the full test suite, AND verify the
   feature end-to-end by actually exercising the changed behavior (run the app/flow, not only unit
   tests). Re-run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/requirements-coverage.mjs" --requirements .codex-flow/REQUIREMENTS.md --tasks .codex-flow/TASKS.md`;
   if the helper is unavailable in a standalone install, verify coverage manually, but if it is
   present and exits non-zero, surface the error to the user and STOP. Walk the effective
   REQUIREMENTS.md set ID-by-ID, reporting met/not-met with evidence (test name, file, or
   demonstrated behavior); any not-met ID blocks completion. Then summarize the delivered change,
   remaining risks, and suggest a commit message. If
   per-task checkpoint commits were made, offer to squash the `wip(codex-flow)` commits into one
   clean commit (or keep them — user's call). Do not commit or squash unless the user asks.
   After the whole-feature dual review resolves, record its final comparison in the report dir's
   `reviews.md` per `codex-flow:session-report`, and record it once in the Decision log using the
   non-task event-block schema from `codex-flow:plan-architecture`.
9. **Improvement decision gate**: consider only unchecked entries without an
   `(approved: T<n>)` marker in `.codex-flow/IMPROVEMENTS.md` as pending. If the ledger is missing
   or has no unchecked pending entries, skip AskUserQuestion and note "no improvements" in the
   delivery summary. Otherwise compile those entries into a summary + proposed execution plan,
   grouped and effort-estimated per the review-dual skill, and present it via AskUserQuestion.
   Before appending any approved task, FIRST durably set
   `backlogApproved: no (improvement tasks <ISO date>)` and `phase: backlog` in STATE.md. Slice
   approved items into new tasks appended to `.codex-flow/TASKS.md`; when each task is
   created, mark its ledger line `(approved: T<n>)`, and check it off when the task passes review.
   Run the impact analysis, coverage lint, and backlog sanity checks, then get backlog re-approval;
   only afterward restore `backlogApproved: yes (<ISO 8601 timestamp>)` and return `phase` to
   `execution` before scheduling the new tasks.
   Execute those tasks through the normal Phase 4 → Phase 5 loop, but do not re-trigger this
   decision gate for improvement tasks spawned by the gate. Record declined items once in
   `.codex-flow/PLAN.md`'s Decision log using the non-task event-block schema from
   `codex-flow:plan-architecture`, and check off their ledger lines with `(declined)`.
   After the improvement decision gate has fully resolved — all approved improvement tasks have
   been executed and reviewed, or no improvements are pending — and just before delivering the
   final summary, generate `cost.md` from the project root. Read `<session-start ISO>` from PLAN.md's
   recorded `- Session start: <ISO 8601>` line, falling back to the report-dir timestamp interpreted
   in local time, and run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-cost.mjs" --since "<session-start ISO>" --cwd "$PWD"`
   If `${CLAUDE_PLUGIN_ROOT}` is unset in a standalone install, locate `session-cost.mjs` in the
   codex-mcp package or repository install; if unavailable, still write `cost.md` with the Claude
   qualitative section, mark measured Codex cost `unavailable`, never fabricate numbers, and never
   embed raw stderr.
   When the helper is available, embed its output; always include the Claude qualitative section.
   Generate `SUMMARY.md` in the report dir per `codex-flow:session-report`. Mention both reports in
   the final delivery summary. Only after the improvement gate and all final review, requirement,
   cost, report, and delivery gates complete, set `phase` in `.codex-flow/STATE.md` to `complete`.
10. **Retro**: per `codex-flow:skill-selection` Step 8, if the flow produced reusable domain
   knowledge not covered by any indexed skill, offer to save it as a new skill in the local
   library and rebuild the index.

Rules:
- Never skip the interview, plan approval, or backlog approval.
- Never fix Codex's code yourself in rounds 1–3 — send findings back via `codex_continue` so the Codex session stays consistent. Only fix by hand if 3 rounds fail, and tell the user. After any hand-fix, re-run the task's acceptance checks before marking it done. (Under the Executor fallback there is no Codex session: Claude fixes directly, still within the 3-round cap and with the acceptance checks re-run every round.)
- Never switch executors silently or mid-task — an outage triggers exactly one AskUserQuestion per the Executor fallback section, and the switch is recorded in STATE.md `executor` plus the Decision log.
- If a Codex run still fails or times out after bounded auto-resume, inspect `attempts` and
  `resumeReasons`, report it, and ask the user before any manual retry (quota is not free).
