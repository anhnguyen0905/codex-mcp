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

If `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md` already exist:

- Show the task Statuses and ask **resume vs restart**.
- **Resume** → continue from the first task not marked done; skip Phases 1–3, jump to Phase 4 for
  the remaining tasks.
- **Restart** → archive the old files to `.codex-flow/archive/<timestamp>/`, then begin fresh.
- Only interview/plan from scratch on restart or when no plan exists.

## Step 3 — Baseline the workspace

1. **Git cleanliness + ref**: `git status --porcelain`. Dirty → ask the user to commit/stash first
   (recommended: clean per-task diffs + a rollback point) or proceed with the dirty baseline noted
   in PLAN.md. Record the baseline ref (`git rev-parse HEAD`). Not a git repo → warn that
   diffs/checkpoints/rollback are unavailable and confirm before continuing.
2. **Ignore live logs**: ensure `.codex-flow/live/` is in `.gitignore` (append if missing) so raw
   JSONL progress logs never land in checkpoint or final commits.
3. **Known-red baseline**: detect the project's test command and run it once. Record pre-existing
   failures as the **known-red baseline** — Phase 5 compares against this list so Codex is blamed
   only for NEW failures. If the suite can't run at all, tell the user and agree how results will be
   verified before continuing.

## Why it's a gate

Skipping preflight is how runs go wrong quietly: executing while logged out wastes a round,
clobbering an interrupted plan loses work, and reviewing without a known-red baseline blames Codex
for breakage it never caused. The few checks here pay for themselves across the whole flow.
