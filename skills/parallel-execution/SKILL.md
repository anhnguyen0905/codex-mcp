---
name: parallel-execution
description: Run a codex-flow backlog faster by executing independent tasks concurrently — compute dependency/file-disjoint waves from TASKS.md, give each parallel task its own git worktree (codex-mcp serializes per cwd but parallelizes across cwds), run a Claude subagent per worktree, then merge and integration-review each wave. Use by default when task-waves reports width greater than 1; proceed without asking for waves of up to 3 concurrent tasks and ask only before a wave exceeds 3 because of simultaneous quota cost.
---

# Parallel Execution (default when wave width > 1)

codex-mcp serializes runs per `cwd` (to prevent file/git races) but runs different `cwd`s in
parallel. So real parallelism = **one git worktree per concurrent task**, each driven by its own
Claude subagent calling `codex_execute` into that worktree.

## Default-on policy

- Always run the wave tool below during Phase 4. When it reports width > 1, use parallel mode by
  default if the project is a git repo, its tracked baseline is clean, and the user has not opted
  out.
- Proceed without asking for waves of **≤3 concurrent tasks**. Show the user the wave plan, then
  start the wave.
- When a wave exceeds **3 concurrent tasks**, ask whether to run at that width or lower the cap
  before spawning; parallel execution burns N× simultaneous quota.
- Stay sequential when the tool reports "fully sequential", the user opted out, the project is
  not a git repo, or the tracked baseline cannot be made clean.

## Step 1 — Compute waves

`node "${CLAUDE_PLUGIN_ROOT}/scripts/task-waves.mjs" .codex-flow/TASKS.md`

A **wave** is a set of tasks that can run at once: every task's dependencies are satisfied by
earlier waves, and no two tasks in the wave touch the same file (`Files:` field). Tasks with no
declared files run alone (unknown blast radius). The tool prints each wave and its width; a wave
of width 1 just runs like normal Phase 4.

Wave quality is only as good as the backlog metadata: accurate per-task `Files:` sets (from PLAN.md's
**Component → files** map) and fixed **Contracts** are what make concurrent tasks genuinely
independent. If tasks were sliced with vague file lists, fix the backlog before parallelizing —
don't parallelize on guesses.

Show the wave plan to the user before spawning anything. For waves of width ≤3, this is a status
update, not an approval gate.

## Step 2 — Per wave: spawn a subagent + worktree per task

**Hard precondition:** parallel mode requires a clean tracked baseline, with every accepted project
change the tasks depend on committed at the branch point. If Phase 0 accepted a dirty baseline,
commit the required changes and stash unrelated residue before continuing, or stay sequential.
The untracked `.codex-flow` control files are copied separately below.

For each task in the wave (width > 1):

1. Create isolated worktrees **serially**, never with concurrent `git worktree add` calls. Cloud-
   synced filesystems such as OneDrive can fail concurrent creation with `mmap failed`. Use the
   `Agent` tool with `isolation: "worktree"`
   (or `EnterWorktree`). Each worktree is a distinct `cwd`. Branch point depends on the wave:
   - **Wave 1**: branch from the Phase 0 baseline ref.
   - **Wave N (N>1)**: branch from the CURRENT integration branch HEAD — i.e. only after wave
     N−1 has been merged and its wave integration review/tests passed (Step 3). Branching later
     waves off the baseline would run them on stale code missing earlier waves' merged output.
   The Phase 0 baseline ref is kept for audit/rollback only — never as a branch point after wave 1.
2. After creating each worktree, the coordinator MUST copy the untracked control files into it:

   ```bash
   mkdir -p "<worktree>/.codex-flow"
   cp .codex-flow/PLAN.md .codex-flow/TASKS.md "<worktree>/.codex-flow/"
   ```

   Treat these copies as coordinator-owned context: subagents read them but do not include them in
   task commits; the coordinator updates the integration copies in Step 3.
3. In each subagent, run the **normal Phase 4 execution** for its ONE task: embed the standards +
   the task's `Skills:` blocks, call `codex_execute` with that worktree as `cwd`, pick `model` by
   task complexity, save the `sessionId`.
4. After the serial worktree setup and control-file copies finish, launch the subagents
   concurrently in a single batch.

Because each `cwd` differs, the per-workspace concurrency guard allows all of them at once.

## Step 3 — Per wave: review, then merge

1. Each subagent runs its own **Phase 5 review** (conformance → quality → security) inside its
   worktree; a task that does not pass escalates as a blocker.
2. After review passes, each subagent MUST commit its task changes on the worktree branch as
   `wip(codex-flow): T<n> <title>`, regardless of the Phase-3 checkpoint-commit choice. This commit
   is required to transport the work back and can be squashed at delivery; exclude the copied
   `.codex-flow` control files. Only then does the subagent report the branch ready to merge.
3. Before merging, the coordinator verifies the task branch is ahead of its branch-point base
   (`git rev-list --count <base>..<branch>` must be greater than zero). A zero-commit branch is a
   failed task, not a branch to merge.
4. The coordinator merges each passed, verified worktree branch back into the integration branch
   **in task order**. Resolve conflicts here — they should be rare because the wave is
   file-disjoint, but dependency-driven edits to shared files across waves can still collide.
5. After merging the whole wave, run a **wave integration review**: full test suite on the merged
   result + a quick end-to-end probe. Branches never saw each other, so a green-in-isolation task
   can still break in combination — this pass is mandatory, not optional.
6. Append merged outcomes to PLAN.md's Decision log, then compute the next wave (dependencies of
   later tasks are now satisfied). The next wave's worktrees branch from the integration branch
   HEAD as it stands now — post-merge, post-review — so they build on this wave's output.

## Step 4 — Final integration

After the last wave: whole-feature review + full suite + end-to-end verification (same as
sequential Phase 5 step 8), then summarize. Offer to squash the per-task/per-wave commits.

## Rules & failure handling

- Never parallelize tasks that share a file — the wave tool already prevents this; do not override.
- If a subagent's task fails after 3 review rounds, quarantine it: keep the rest of the wave,
  report the failure, and ask the user before retrying (quota is not free).
- If a merge conflict is non-trivial, stop and surface it — do not let a subagent force-resolve
  another task's code.
- Never spawn more than **10 subagents at once** — the wave tool already caps each wave at 10
  (`--max <n>` to lower it) and flows the rest into the next wave, so a very wide backlog is split
  into consecutive ≤10 waves. Lower the cap when quota or review load is tight.
- Keep parallel mode ON by default when Step 1 shows width > 1. Waves of width ≤3 need no opt-in;
  ask only before running a wave at width >3. Stay sequential for the exceptions in the
  Default-on policy.
