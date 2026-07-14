---
description: "5-phase workflow: Claude interviews → plans architecture → breaks backlog → Codex executes per task → Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude

Task: $ARGUMENTS

Follow these 5 phases strictly. Do NOT write implementation code yourself — Codex does the implementation.

Each phase names plugin skills (`codex-flow:*`) to load via the Skill tool before starting the phase — they carry the detailed checklists. If a named skill is unavailable (command installed without the plugin), continue with the phase instructions below as written.

## Phase 0 — Preflight (gate, do this FIRST)

**Load skill first**: `codex-flow:preflight` (health gate, resume check, workspace baseline) — it carries the detailed checklist for the steps below.

Call `mcp__codex__codex_health` before anything else:

- **Tool call fails / server missing** → the MCP server is not set up. Tell the user to follow the
  install steps in the codex-mcp README (or run `node scripts/doctor.mjs` in the codex-mcp repo),
  then STOP.
- **`loggedIn: false`** → tell the user to run `codex login` in their terminal (ChatGPT
  Plus/Pro/Team, or set `OPENAI_API_KEY`), then STOP. Do not interview, plan, or execute anything
  until a re-check shows `loggedIn: true`.
- **`loggedIn: true`** → report the Codex version and continue.

**Resume check** — if `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md` already exist from a prior
run, do NOT clobber them. Show the user the task Statuses and ask: **resume** (continue from the
first task not marked done — skip Phases 1–3, jump to Phase 4 for the remaining tasks) or **restart**
(archive the old files to `.codex-flow/archive/<timestamp>/` and begin fresh). Only interview/plan
from scratch on restart or when no plan exists.

Then baseline the workspace (in the project root):

1. `git status --porcelain` — if the tree is dirty, ask the user: commit/stash first
   (recommended, gives clean per-task diffs and a rollback point) or proceed with the dirty
   baseline noted in PLAN.md. Record the baseline ref (`git rev-parse HEAD`). If the cwd is not a
   git repo, tell the user diffs/checkpoints/rollback are unavailable and confirm before continuing.
2. Ensure `.codex-flow/live/` is in the project's `.gitignore` (append it if missing) so raw
   live-progress JSONL logs never land in checkpoint or final commits.
3. Detect the project's test command and run it once. Record any pre-existing failures as the
   **known-red baseline** — these are not Codex's fault, and Phase 5 compares against this list
   instead of blaming Codex for old breakage. If the suite can't run at all, tell the user and
   agree on how results will be verified before continuing.

## Phase 1 — Interview (Claude)

**Load skills first**: `codex-flow:interview-elicitation` (six question domains, stop condition) and `codex-flow:interview-ask-back` (5 Whys, example probing, hidden assumptions).

Interview the user with AskUserQuestion following those skills. Keep asking until every acceptance criterion is verifiable, then write the Requirements Summary and get confirmation.

Scale interview depth to task complexity: a small, unambiguous change needs only a short
Requirements Summary and a quick confirmation — don't force the full six-domain interview. A large
or ambiguous feature warrants the full elicitation. When in doubt, ask.

## Phase 2 — Plan & Architecture (Claude)

**Load skills first**: `codex-flow:plan-research-first` (search existing solutions before designing), `codex-flow:plan-architecture` (convention discovery, option trade-off analysis, PLAN.md structure), and `codex-flow:skill-selection` (pick domain skills from the local skill index).

1. Explore the codebase to understand relevant architecture and conventions.
2. **Select domain skills from the local index** per `codex-flow:skill-selection`: derive search
   terms from the requirements + stack, grep the index, load every relevant skill that fits a
   ~3%-of-context budget (≈6000 tokens; no fixed count) and concretely changes the plan or the
   Codex prompts. Do NOT install or blind-load whole collections; 0 matches is fine.
3. Write `.codex-flow/PLAN.md` in the project root containing:
   - **Context**: what the project is, conventions Codex must follow
   - **Objective**: the confirmed goal from Phase 1
   - **Architecture**: components/modules touched, data flow, key design decisions and why
   - **Risk & blast radius**: sensitive areas the change touches (auth, data, migrations, config),
     what could break beyond the target files, and the rollback point (baseline ref from Phase 0)
   - **Skills used**: the domain skills selected in step 2 (name, path, what each informs)
   - **Known-red baseline**: pre-existing test failures from Phase 0
   - **Out of scope**: things Codex must NOT do
   - **Acceptance criteria**: how the result will be verified (tests to pass, behaviors to check)
   - **Decision log**: empty, append-only — filled during execution
4. Show the plan to the user and get approval before continuing.

## Phase 3 — Backlog (Claude)

**Load skill first**: `codex-flow:plan-backlog` (slicing rules, dependency ordering, sanity checks).

Decompose the approved plan into tasks and write `.codex-flow/TASKS.md`:

```markdown
## T1: <imperative title>
- Depends on: — | T<n>
- Files: <files to create/modify>
- Steps: <concrete, file-level steps>
- Skills: <Phase 2 domain skills relevant to THIS task, or — >
- Acceptance: <verifiable criteria for THIS task — tests to pass, behaviors>
- Status: pending
```

Rules for slicing:
- Each task independently verifiable, roughly one Codex run (~5–30 min of work).
- Order by dependency; a task may only depend on earlier tasks.
- Decide the skill→task mapping ONCE here (the `Skills:` field), from the skills selected in
  Phase 2 — so Phase 4 embeds a consistent, user-reviewable set per task instead of re-guessing.
- Also mirror the tasks with TaskCreate so the user sees live progress.

Show the backlog to the user and get approval before executing. At the same time ask once:
**checkpoint commits after each passed task — yes/no?** (recommended yes on multi-task backlogs;
gives per-task rollback points).

## Phase 4 — Execution (Codex)

**Load skills first (code tasks)**: `codex-flow:exec-coding-standards` and `codex-flow:exec-self-testing` (blocks to embed into every Codex prompt), plus the language skill matching the project: `codex-flow:exec-typescript`, `codex-flow:exec-python`, `codex-flow:exec-go`, `codex-flow:exec-jvm` (Java/Kotlin), `codex-flow:exec-rust`, `codex-flow:exec-csharp`, `codex-flow:exec-php`, `codex-flow:exec-ruby`, `codex-flow:exec-swift`, or `codex-flow:exec-cpp` (C/C++). If the project's language has no exec skill, use `codex-flow:exec-coding-standards` alone plus any language guidance from the skill index. Codex cannot see Claude's skills — the prompt is the only channel, so these standards blocks MUST be embedded in the prompt text.

**Non-code tasks**: when a task produces content instead of code (data analysis, marketing copy, docs, research, a plan), load `codex-flow:exec-deliverable` INSTEAD of `exec-coding-standards` + `exec-self-testing` + the language skill, and embed its deliverable + verification blocks. A mixed backlog picks per task: code tasks get the coding blocks, content tasks get the deliverable block. The selected domain skills (from Phase 2) are embedded either way.

**Sequential vs parallel**: by default run tasks one at a time in dependency order (below). For a
large backlog with independent tasks, consider **parallel mode**: run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/task-waves.mjs" .codex-flow/TASKS.md` to compute execution
waves from the `Depends on:` + `Files:` metadata. If it reports width > 1 AND the user opts in,
load `codex-flow:parallel-execution` and follow it (one git worktree + subagent per concurrent
task, then merge + integration-review per wave). If it reports "fully sequential", or the backlog
is small, or the user declines, stay sequential. Parallel mode costs N× simultaneous quota.

For each task in dependency order (sequential mode):

1. Call `mcp__codex__codex_execute` with:
   - `prompt`: "Read .codex-flow/PLAN.md for context. Implement task T<n> exactly as specified below, and only this task. Run its acceptance checks before finishing." + the full task text + the standards, testing, and language blocks from the loaded skills (or the `exec-deliverable` blocks for a non-code task) + a distilled ≤ 30-line rules block for each skill listed in the task's `Skills:` field (see `codex-flow:skill-selection` Step 6 — never paste a whole SKILL.md)
   - `cwd`: absolute path of the project root
   - `sandbox`: `workspace-write` by default. Use `read-only` for investigation-only tasks; use `danger-full-access` ONLY when the task genuinely needs network or a global install — and tell the user before doing so.
   - `model`: match the task's complexity — a stronger model for architectural, cross-cutting, or subtle-logic tasks; the default (or a faster/cheaper model) for small, mechanical, well-specified tasks. Note the choice in the Decision log.
   - `timeoutMs`: scale to task size (default 30 min)
   - `terminal`: `true` — opens a live-progress terminal window when supported; progress also streams into the session via MCP notifications
2. **Save the returned `sessionId`** — reviews in Phase 5 go back into this session. Reuse one session (`codex_continue`) while consecutive tasks build on each other in the SAME domain; start a fresh `codex_execute` when a task is independent OR shifts domain (e.g. backend → data pipeline → marketing copy) — a fresh session gets the new task's distilled skill blocks instead of inheriting stale context from the previous domain.
3. Update the task's Status in TASKS.md and TaskUpdate after each run.
4. Run Phase 5 review for the task BEFORE starting the next one.
5. When the task passes review: append one line to PLAN.md's **Decision log** (deviations from the
   plan, decisions made, surprises) so later tasks and fresh Codex sessions inherit the context —
   and, if the user opted in at Phase 3, make the checkpoint commit
   (`wip(codex-flow): T<n> <title>`).

## Phase 5 — Review (Claude, per task + final)

**Load skills first**: `codex-flow:review-conformance` (requirement/plan/structure conformance — check FIRST), `codex-flow:review-quality` (correctness hazards, silent failures, test quality), `codex-flow:review-security` (mandatory when the diff touches auth, input, queries, files, or secrets), and `codex-flow:review-feedback` (severity levels + codex_continue format).

0. Re-read `.codex-flow/PLAN.md` and this task's entry in `.codex-flow/TASKS.md` before reviewing — treat the files on disk as the source of truth for acceptance criteria, architecture, `Files:` scope, and the known-red baseline, not session memory (which may have been compacted across a long backlog).
1. Inspect what Codex did: use the `diff` field returned by the tool (git status + patch), and read changed files where the patch is not enough.
2. Review in order: conformance → quality → security, per the loaded skills.
3. Run the project's tests/build yourself to verify — Codex's claim is input, not evidence. Compare
   failures against the **known-red baseline** in PLAN.md: only new failures count against the task.
4. **If issues found**: send findings via `mcp__codex__codex_continue` using the review-feedback format (numbered, severity-tagged, file:line, expected vs observed). Then re-review. Repeat up to 3 rounds per task.
5. **Plan drift**: if a finding traces to the PLAN being wrong (wrong architecture, missed
   requirement) rather than Codex mis-implementing it, do NOT burn review rounds — go back to
   Phase 2, amend PLAN.md with user approval, re-slice the affected tasks, then resume.
6. **If clean**: mark the task done, move to the next task.
7. **After the last task**: do a whole-feature review pass (optionally `mcp__codex__codex_review` for a second opinion), run the full test suite, AND verify the feature end-to-end by actually exercising the changed behavior (run the app/flow, not only unit tests). Then summarize the delivered change, remaining risks, and suggest a commit message. If per-task checkpoint commits were made, offer to squash the `wip(codex-flow)` commits into one clean commit (or keep them — user's call). Do not commit or squash unless the user asks.
8. **Retro**: per `codex-flow:skill-selection` Step 7, if the flow produced reusable domain
   knowledge not covered by any indexed skill, offer to save it as a new skill in the local
   library and rebuild the index.

Rules:
- Never skip the interview, plan approval, or backlog approval.
- Never fix Codex's code yourself in rounds 1–3 — send findings back via `codex_continue` so the Codex session stays consistent. Only fix by hand if 3 rounds fail, and tell the user. After any hand-fix, re-run the task's acceptance checks before marking it done.
- If a Codex run fails or times out, report it and ask the user before retrying (quota is not free).
