---
name: parallel-execution
description: Run a large codex-flow backlog faster by executing independent tasks concurrently — compute dependency/file-disjoint waves from TASKS.md, give each parallel task its own git worktree (codex-mcp serializes per cwd but parallelizes across cwds), run a Claude subagent per worktree, then merge and integration-review each wave. Use only when the backlog has genuinely independent tasks and the speedup is worth the quota and merge overhead.
---

# Parallel Execution (optional Phase 4 mode)

codex-mcp serializes runs per `cwd` (to prevent file/git races) but runs different `cwd`s in
parallel. So real parallelism = **one git worktree per concurrent task**, each driven by its own
Claude subagent calling `codex_execute` into that worktree.

## When to use it

- Backlog has **≥3 independent tasks** (no dependency chain, disjoint files) — check with the
  wave tool below. If it reports "fully sequential", do NOT parallelize; use normal Phase 4.
- The speedup is worth **N× simultaneous quota burn** and a merge/integration step. For small
  backlogs the orchestration overhead loses to just running sequentially.

## Step 1 — Compute waves

`node "${CLAUDE_PLUGIN_ROOT}/scripts/task-waves.mjs" .codex-flow/TASKS.md`

A **wave** is a set of tasks that can run at once: every task's dependencies are satisfied by
earlier waves, and no two tasks in the wave touch the same file (`Files:` field). Tasks with no
declared files run alone (unknown blast radius). The tool prints each wave and its width; a wave
of width 1 just runs like normal Phase 4.

Show the wave plan to the user before spawning anything.

## Step 2 — Per wave: spawn a subagent + worktree per task

For each task in the wave (width > 1):

1. Create an isolated worktree for the task — use the `Agent` tool with `isolation: "worktree"`
   (or `EnterWorktree`), branched off the Phase 0 baseline ref. Each worktree is a distinct `cwd`.
2. In each subagent, run the **normal Phase 4 execution** for its ONE task: embed the standards +
   the task's `Skills:` blocks, call `codex_execute` with that worktree as `cwd`, pick `model` by
   task complexity, save the `sessionId`.
3. Subagents run concurrently — launch them in a single batch, not one after another.

Because each `cwd` differs, the per-workspace concurrency guard allows all of them at once.

## Step 3 — Per wave: review, then merge

1. Each subagent runs its own **Phase 5 review** (conformance → quality → security) inside its
   worktree and reports back only after its task passes (or escalates a blocker).
2. The coordinator merges each passed worktree branch back into the integration branch **in task
   order**. Resolve conflicts here — they should be rare because the wave is file-disjoint, but
   dependency-driven edits to shared files across waves can still collide.
3. After merging the whole wave, run a **wave integration review**: full test suite on the merged
   result + a quick end-to-end probe. Branches never saw each other, so a green-in-isolation task
   can still break in combination — this pass is mandatory, not optional.
4. Append merged outcomes to PLAN.md's Decision log, then compute the next wave (dependencies of
   later tasks are now satisfied).

## Step 4 — Final integration

After the last wave: whole-feature review + full suite + end-to-end verification (same as
sequential Phase 5 step 7), then summarize. Offer to squash the per-task/per-wave commits.

## Rules & failure handling

- Never parallelize tasks that share a file — the wave tool already prevents this; do not override.
- If a subagent's task fails after 3 review rounds, quarantine it: keep the rest of the wave,
  report the failure, and ask the user before retrying (quota is not free).
- If a merge conflict is non-trivial, stop and surface it — do not let a subagent force-resolve
  another task's code.
- Cap concurrency to a sane N (e.g. 3–4) even if a wave is wider, to bound quota and review load.
- Keep the option OFF by default: only enter parallel mode when Step 1 shows real width and the
  user opts in.
