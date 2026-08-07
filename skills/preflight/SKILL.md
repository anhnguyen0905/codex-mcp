---
name: preflight
description: Phase 0 preflight for codex-flow — gate on Codex login/health, detect and offer to resume an interrupted run, and baseline the workspace (git cleanliness + ref, gitignore live logs, known-red test baseline) so later phases have a rollback point and review blames only new failures.
---

# Preflight (Phase 0 — run FIRST, it is a gate)

Nothing downstream is safe until these pass. Do not interview, plan, or execute until the gate is green.

## Step 1 — Health gate

Call `mcp__codex__codex_health` before anything else:

- **Tool call fails / server missing** → the MCP server isn't set up. Point the user to the codex-mcp
  README install steps (or `node scripts/doctor.mjs`), then STOP.
- **`loggedIn: false`** → tell the user to run `codex login` (ChatGPT Plus/Pro/Team, or set
  `OPENAI_API_KEY`), then STOP until a re-check shows `loggedIn: true`.
- **`loggedIn: true`** → report the Codex version and continue.

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
- **Resume** → skip only the phases whose approvals STATE.md records, then route from STATE.md's
  recorded `phase`. For `phase: execution`, enter Phase 4 at the first task not marked done. For
  `phase: review`, resume Phase 5 completion work; when all tasks are done but `phase` is not
  `complete`, also resume Phase 5 for the final dual review, requirement ID-walk, improvement gate,
  cost/report delivery gates, and completion write instead of concluding there is no work. For an
  earlier phase, enter its first unapproved gate. Treat
  every `[verify]` block as a hypothesis: confirm it against `git diff` and the current code before
  relying on it. Record the current `git rev-parse HEAD` as `resumeHead` and update `phase`; change
  no other STATE.md key as part of the resume operation.
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
   ```

   The orchestrator is the only writer. `runBaselineRef`, `knownRed`, and `dirtyBaseline` are
   written once at run start and NEVER modified on resume. A resume writes only `resumeHead` and
   updates `phase` as its resume operation; later approval or execution transitions update only
   their corresponding mutable fields.

## Why it's a gate

Skipping preflight is how runs go wrong quietly: executing while logged out wastes a round,
clobbering an interrupted plan loses work, and reviewing without a known-red baseline blames Codex
for breakage it never caused. The few checks here pay for themselves across the whole flow.
