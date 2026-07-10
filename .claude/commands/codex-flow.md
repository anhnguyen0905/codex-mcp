---
description: "4-phase workflow: Claude interviews & plans, Codex executes, Claude reviews"
argument-hint: "<feature or task description>"
---

# Codex Flow — Plan with Claude, Execute with Codex, Review with Claude

Task: $ARGUMENTS

Follow these 4 phases strictly. Do NOT write implementation code yourself — Codex does the implementation.

## Phase 1 — Interview (Claude)

Before any design work, verify Codex is ready by calling `mcp__codex__codex_health`.

Interview the user about the task using AskUserQuestion. Cover at minimum:
- Goal and success criteria (what does "done" look like?)
- Scope boundaries (what is explicitly OUT of scope?)
- Constraints (stack, patterns to follow, files/areas not to touch)
- Testing expectations

Keep asking until requirements are unambiguous. Summarize your understanding and get confirmation.

## Phase 2 — Design Review & Planning (Claude)

1. Explore the codebase to understand relevant architecture and conventions.
2. Write a plan file at `.codex-flow/PLAN.md` in the project root containing:
   - **Context**: what the project is, conventions Codex must follow
   - **Objective**: the confirmed goal from Phase 1
   - **Implementation steps**: ordered, concrete, file-level steps
   - **Out of scope**: things Codex must NOT do
   - **Acceptance criteria**: how the result will be verified (tests to pass, behaviors to check)
3. Show the plan to the user and get approval before executing.

## Phase 3 — Execution (Codex)

Call `mcp__codex__codex_execute` with:
- `prompt`: "Read .codex-flow/PLAN.md and implement it exactly. Follow the acceptance criteria. Run the tests before finishing." (embed the full plan text in the prompt as well, in case the file is unreadable)
- `cwd`: absolute path of the project root
- `sandbox`: `workspace-write`
- `timeoutMs`: scale to task size (default 30 min)
- `terminal`: `true` — opens a Terminal window streaming live Codex progress so the user can follow along (macOS). The structured result is unchanged.

**Save the returned `sessionId`** — it is required for review feedback in Phase 4.
Report to the user: files changed, commands run, Codex's final message.

## Phase 4 — Review (Claude)

1. Inspect what Codex did: `git diff` (or compare files if not a git repo), read every changed file.
2. Review against the plan's acceptance criteria plus code quality standards (correctness, error handling, immutability, naming, no hardcoded secrets, test coverage).
3. Run the project's tests/build yourself to verify.
4. **If issues found**: call `mcp__codex__codex_continue` with the saved `sessionId` and a numbered list of concrete findings to fix. Then re-review. Repeat up to 3 rounds.
5. **If clean**: summarize the delivered change, remaining risks, and suggest a commit message. Do not commit unless the user asks.

Rules:
- Never skip the interview or plan approval.
- Never fix Codex's code yourself in round 1-3 — send findings back via `codex_continue` so the Codex session stays consistent. Only fix by hand if 3 rounds fail, and tell the user.
