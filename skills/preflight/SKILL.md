---
name: preflight
description: Phase 0 preflight for codex-flow — gate on Codex login/health, detect and offer to resume an interrupted run, and baseline the workspace (git cleanliness + ref, gitignore live logs, known-red test baseline) so later phases have a rollback point and review blames only new failures.
---

# Preflight (Phase 0 — run FIRST, it is a gate)

Nothing downstream is safe until these pass. Do not interview, plan, or execute until the gate is green.

## Step 1 — Health gate

Call `mcp__codex__codex_health` before anything else:

- **Tool call fails / server missing** → the MCP server isn't set up. Point the user to the codex-mcp
  README install steps (or `node scripts/doctor.mjs`), then offer the command's **Executor
  fallback**: fix and re-check, or continue with Claude as executor. Never continue silently.
- **`loggedIn: false`** → tell the user to run `codex login` (ChatGPT Plus/Pro/Team, or set
  `OPENAI_API_KEY`), then offer the same Executor fallback choice. Proceed only after a re-check
  shows `loggedIn: true` or the user explicitly chose the fallback.
- **`loggedIn: true`** → report the Codex version, record `executor: codex`, and continue.
- The analysis lane of the Fast-path gate needs no Codex session and no fallback decision.

## Step 2 — Resume check (don't clobber an interrupted run)

If `.codex-flow/STATE.md` exists, treat it as an interrupted run even when PLAN.md or TASKS.md has
not been created yet:

- Read `.codex-flow/STATE.md` as the resume authority. Its approval fields decide which phases may
  be skipped; any phase whose approval is not recorded MUST be re-run. The existence of
  PLAN.md/TASKS.md is NOT proof of approval.
- When both `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md` exist, run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-slice.mjs" --resume` and read
  `.codex-flow/RESUME.md` instead of the raw files. If the helper is unavailable in a standalone
  install, fall back to reading PLAN.md and TASKS.md directly. If the helper is present but exits
  non-zero, surface the error to the user and STOP; never use the standalone fallback for a failing
  helper. When either file does not exist, read only the control files that exist; do not require a
  missing TASKS.md to resume an earlier phase.
- When TASKS.md exists, show its task Statuses. Ask **resume vs restart** in every case.
- Before scheduling anything, reconcile every task whose Status is `in-progress`. Read its recorded
  Session line. The resume slice's Task statuses section carries Session content for every
  in-progress task even though it embeds the full task text only for the first unfinished task; do
  not assume the other in-progress task blocks are embedded. A launching line may be sequential
  (`- Session: launching (base: <short sha>)`) or parallel (`- Session: launching (base: <short
  sha>, worktree: <path>, branch: <name>)`). Extract the base sha from either launching form or the
  completed-session form. Then cross-check `git log --oneline <base sha>..HEAD` and `git status`
  for changes to the task's declared `Files:` since that base. Report the evidence and ask the user
  to choose exactly one: **continue in the recorded session (when a real session id exists) /
  review the work as-is / reset to pending**. For reset to pending, roll back through the
  checkpoint commit when `checkpointCommits` is enabled. Never blindly re-execute an in-progress
  task.
- **Resume** → first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" check`; when it reports only missing keys on a legacy file, add them
  with `set` (`currentTask -`, `taskStage idle`, `wave -`) and continue; any other violation is
  surfaced to the user before routing. Then skip only the phases whose approvals STATE.md records, and route from STATE.md's
  recorded `phase`. For `phase: execution`, enter Phase 4 at the first task not marked done. Before
  that, first route by `taskStage` regardless of `currentTask` (`currentTask` names the task in sequential
  mode; in parallel mode it is `-` and `wave` names the wave): `reviewing` → resume Phase 5 for that task;
  `launching` or `executing` → run the in-progress reconciliation above before anything else;
  `handoff` → finish Phase 5 step 7's durable handoff (or the wave's Step 3.8); `merge-conflict` → surface the conflict to the
  user and STOP; `idle` → the next pending task. For
  `phase: review`, resume Phase 5 completion work; when all tasks are done but `phase` is not
  `complete`, also resume Phase 5 for the final dual review, requirement ID-walk, improvement gate,
  cost/report delivery gates, and completion write instead of concluding there is no work. For an
  earlier phase, enter its first unapproved gate. Treat
  every `[verify]` block as a hypothesis: confirm it against `git diff` and the current code before
  relying on it. Record the current `git rev-parse HEAD` as `resumeHead` and update `phase`; apart
  from the legacy-key backfill above, change no other STATE.md key as part of the resume operation.
  The reconciliation choice for an in-progress task (continue / review as-is / reset) is made
  first; the `taskStage` routing then applies to the task as the user left it.
- On resume, reuse the report dir recorded under `## Session report` in PLAN.md; create it only if
  missing.
- **Restart** → archive the old control files that exist to `.codex-flow/archive/<timestamp>/`,
  then begin fresh.

If STATE.md does not exist, do not offer resume. Treat any PLAN.md or TASKS.md as orphaned control
files and offer to archive them before beginning a fresh run.

## Step 3 — Baseline the workspace

1. **Git cleanliness + ref**: `git status --porcelain`. Dirty → ask the user to commit/stash first
   (recommended: clean per-task diffs + a rollback point) or proceed with the dirty baseline noted
   in PLAN.md. When the user proceeds dirty, write `.codex-flow/baseline-dirty.patch`: save the
   baseline-to-working-tree output from `git diff HEAD`, then append a `# Untracked at run start`
   comment header with each untracked path from `git status --porcelain`. Record the baseline ref
   (`git rev-parse HEAD`). Not a git repo → warn that diffs/checkpoints/rollback are unavailable and
   confirm before continuing.
2. **Ignore live logs**: ensure `.codex-flow/live/` is in `.gitignore` (append if missing) so raw
   JSONL progress logs never land in checkpoint or final commits.
3. **Known-red baseline**: detect the project's test command and run it once. Record pre-existing
   failures as the **known-red baseline** — Phase 5 compares against this list so Codex is blamed
   only for NEW failures. If the suite can't run at all, tell the user and agree how results will be
   verified before continuing.
4. **Write run state**: after baselining, write `.codex-flow/STATE.md` with exactly one
   `## Run state` section and these fixed `- <key>: <value>` lines:

   ```markdown
   ## Run state
   - phase: interview
   - requirementsApproved: no
   - planApproved: no
   - backlogApproved: no
   - runBaselineRef: <git HEAD at run start, or unavailable outside git>
   - resumeHead:
   - knownRed: <recorded known-red failures, compact; none when green>
   - checkpointCommits:
   - executionMode: undecided
   - dirtyBaseline: <none | baseline-dirty.patch>
   - executor: codex
   - currentTask: -
   - taskStage: idle
   - wave: -
   ```

   `executor` records who writes code: `codex` (default), `claude (fallback: <reason> <ISO 8601>)`
   after an explicit Executor-fallback choice, or `codex (restored <ISO 8601>)` after returning.
   It changes only at a task boundary and never silently.

   `currentTask` is the task being worked (`T<n>`) or `-`; `taskStage` is one of
   `idle | launching | executing | reviewing | handoff | merge-conflict`; `wave` is the current
   parallel wave number or `-`. `phase` stays `execution` for the whole task loop — per-task
   progress lives in `currentTask` + `taskStage`; `phase: review` means the whole-feature review
   after the last task.

   Write STATE.md and TASKS.md status lines only through the helper:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" set <key> <value>`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" check`, and
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/flow-state.mjs" task <T-id> <status>` (which appends the transition
   line). If the helper is unavailable in a standalone install, edit the file directly; if it is present but exits non-zero, surface the error to the user and STOP.

   The orchestrator is the only writer. `runBaselineRef`, `knownRed`, and `dirtyBaseline` are
   written once at run start and NEVER modified on resume. A resume writes only `resumeHead` and
   updates `phase` as its resume operation (apart from the legacy-key backfill); later approval or execution transitions update only
   their corresponding mutable fields.

## Why it's a gate

Skipping preflight is how runs go wrong quietly: executing while logged out wastes a round,
clobbering an interrupted plan loses work, and reviewing without a known-red baseline blames Codex
for breakage it never caused. The few checks here pay for themselves across the whole flow.
