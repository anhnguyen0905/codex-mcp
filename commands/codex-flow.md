---
description: "5-phase workflow: Claude interviews → plans architecture → breaks backlog → Codex executes per task → Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude

Task: $ARGUMENTS

Follow these 5 phases strictly. Do NOT write implementation code yourself — Codex does the implementation.

## Phase 1 — Interview (Claude)

Before any design work, verify Codex is ready by calling `mcp__codex__codex_health`.

Interview the user about the task using AskUserQuestion. Cover at minimum:
- Goal and success criteria (what does "done" look like?)
- Scope boundaries (what is explicitly OUT of scope?)
- Constraints (stack, patterns to follow, files/areas not to touch)
- Testing expectations

Keep asking until requirements are unambiguous. Summarize your understanding and get confirmation.

## Phase 2 — Plan & Architecture (Claude)

1. Explore the codebase to understand relevant architecture and conventions.
2. Write `.codex-flow/PLAN.md` in the project root containing:
   - **Context**: what the project is, conventions Codex must follow
   - **Objective**: the confirmed goal from Phase 1
   - **Architecture**: components/modules touched, data flow, key design decisions and why
   - **Out of scope**: things Codex must NOT do
   - **Acceptance criteria**: how the result will be verified (tests to pass, behaviors to check)
3. Show the plan to the user and get approval before continuing.

## Phase 3 — Backlog (Claude)

Decompose the approved plan into tasks and write `.codex-flow/TASKS.md`:

```markdown
## T1: <imperative title>
- Depends on: — | T<n>
- Files: <files to create/modify>
- Steps: <concrete, file-level steps>
- Acceptance: <verifiable criteria for THIS task — tests to pass, behaviors>
- Status: pending
```

Rules for slicing:
- Each task independently verifiable, roughly one Codex run (~5–30 min of work).
- Order by dependency; a task may only depend on earlier tasks.
- Also mirror the tasks with TaskCreate so the user sees live progress.

Show the backlog to the user and get approval before executing.

## Phase 4 — Execution (Codex, one task at a time)

For each task in dependency order:

1. Call `mcp__codex__codex_execute` with:
   - `prompt`: "Read .codex-flow/PLAN.md for context. Implement task T<n> exactly as specified below, and only this task. Run its acceptance checks before finishing." + the full task text embedded
   - `cwd`: absolute path of the project root
   - `sandbox`: `workspace-write`
   - `timeoutMs`: scale to task size (default 30 min)
   - `terminal`: `true` — opens a live-progress terminal window when supported; progress also streams into the session via MCP notifications
2. **Save the returned `sessionId`** — reviews in Phase 5 go back into this session. Reuse one session for the whole backlog when tasks build on each other (`codex_continue` with the next task); start a fresh `codex_execute` when a task is independent.
3. Update the task's Status in TASKS.md and TaskUpdate after each run.
4. Run Phase 5 review for the task BEFORE starting the next one.

## Phase 5 — Review (Claude, per task + final)

1. Inspect what Codex did: use the `diff` field returned by the tool (git status + patch), and read changed files where the patch is not enough.
2. Review against the task's acceptance criteria plus code quality standards (correctness, error handling, immutability, naming, no hardcoded secrets, test coverage).
3. Run the project's tests/build yourself to verify.
4. **If issues found**: call `mcp__codex__codex_continue` with the saved `sessionId` and a numbered list of concrete findings to fix. Then re-review. Repeat up to 3 rounds per task.
5. **If clean**: mark the task done, move to the next task.
6. **After the last task**: do a whole-feature review pass (optionally `mcp__codex__codex_review` for a second opinion), run the full test suite, then summarize the delivered change, remaining risks, and suggest a commit message. Do not commit unless the user asks.

Rules:
- Never skip the interview, plan approval, or backlog approval.
- Never fix Codex's code yourself in rounds 1–3 — send findings back via `codex_continue` so the Codex session stays consistent. Only fix by hand if 3 rounds fail, and tell the user.
- If a Codex run fails or times out, report it and ask the user before retrying (quota is not free).
