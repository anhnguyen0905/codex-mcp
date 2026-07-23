---
name: review-dual
description: Run independent Codex and Claude reviews, reconcile findings by evidence, and track non-blocking improvements.
---

# Dual Review (Codex + Claude)

Give every task TWO independent reviews: Claude reviews with the review-conformance, review-quality, and review-security skills; Codex reviews via `mcp__codex__codex_review` in a fresh read-only session so it never grades its own homework. Compare both reviews and select the optimal resolution supported by evidence.

## Codex reviewer role (focus block)

Paste this template into the `focus` parameter of `mcp__codex__codex_review`. Without checkpoint commits, each per-task `mcp__codex__codex_review` sees the cumulative uncommitted diff, so the `focus` block MUST name and enforce the task's `Files:` scope:

```text
Role: Act as an independent senior reviewer.
Task: <task id> — <task title>
Acceptance criteria: <paste the task's acceptance criteria>
Files: <paste the task's Files: list>
Review only the task's Files: list; report no findings outside it.
Review in this exact order:
1. Conformance to .codex-flow/PLAN.md and the task's acceptance criteria.
2. Quality: correctness hazards, silent failures, edge cases, and test quality.
3. Security: secrets, injection, validation, and unsafe patterns.
Output numbered findings tagged CRITICAL, HIGH, MEDIUM, or LOW.
For every finding, give file:line plus expected vs observed behavior.
Then add a SEPARATE `## Improvements` section.
Tag non-blocking suggestions IMP-1, IMP-2, ...: worthwhile refactors, better naming, missing nice-to-have tests, or documentation gaps that are not defects.
```

## Comparison protocol

- Bucket the union of Claude's and Codex's findings into agreed, unique-to-one, and conflicting.
- Verify EVERY finding with evidence: read the code and run the relevant test. Let the evidence determine the verdict, not the reviewer.
- Feed verified findings into the normal `mcp__codex__codex_continue` round per review-feedback severity rules (CRITICAL/HIGH always; MEDIUM/LOW piggyback only).
- Use AskUserQuestion ONLY when a CRITICAL/HIGH finding cannot be verified either way, or two mutually exclusive valid fixes exist.
- Record the outcome as one line in `.codex-flow/PLAN.md`'s Decision log: counts for each bucket plus the resolution.
- If `mcp__codex__codex_review` fails, times out, or returns status `partial`, proceed with Claude-only review, tell the user, and do not auto-retry because of quota.

## Improvements ledger

Append non-blocking improvements from BOTH reviews to `.codex-flow/IMPROVEMENTS.md`, one per line:
`- [ ] IMP-<n> (T<k>, source: codex|claude|both) <description> — <file:line>`
Allocate `IMP-<n>` from one global counter across the whole run, never from per-review counters.
When Claude and Codex suggest the same improvement, record ONE line with `source: both`.
The ledger NEVER blocks marking a task done and NEVER spends an `mcp__codex__codex_continue` round.

## Improvement decision gate

- Consider only unchecked ledger entries without an `(approved: T<n>)` marker as pending. If `.codex-flow/IMPROVEMENTS.md` is missing or has no unchecked pending entries, skip AskUserQuestion and note "no improvements" in the delivery summary.
- After the final whole-feature review, compile those entries into a summary and proposed execution plan, grouped and effort-estimated, then present it via AskUserQuestion.
- Slice approved items into new tasks and append them to `.codex-flow/TASKS.md`. Mark each approved ledger line `(approved: T<n>)` when its task is created, then check it off when the task passes review.
- Run approved tasks through the normal Phase 4 → Phase 5 loop. Improvement tasks spawned by the gate do NOT re-trigger the decision gate themselves.
- Record declined items in `.codex-flow/PLAN.md`'s Decision log and check off each ledger line with `(declined)`.
