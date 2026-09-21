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
1. Conformance to the task's .codex-flow/CONTEXT-T<n>.md slice and acceptance criteria.
Treat [verify]-stamped context as hypotheses to re-confirm against the current code before relying on it.
Read full .codex-flow/PLAN.md only as escalation when a finding disputes plan intent.
2. Quality: correctness hazards, silent failures, edge cases, and test quality.
3. Security: secrets, injection, validation, and unsafe patterns.
Output numbered findings tagged CRITICAL, HIGH, MEDIUM, or LOW.
For every finding, give file:line plus expected vs observed behavior.
Then add a SEPARATE `## Improvements` section.
Tag non-blocking suggestions IMP-1, IMP-2, ...: worthwhile refactors, better naming, missing nice-to-have tests, or documentation gaps that are not defects.
```

## Pass the task's scope, and route out-of-scope findings to the ledger

Call `mcp__codex__codex_review` with `scope: { files: <the task's `Files:` list>, contract: <the
PLAN Contracts the task lists> }` alongside `focus`. The server appends the contract and the file
list to the reviewer prompt and stamps each returned finding with `inScope`, counting the rest in
`reviewFindings.outOfScopeCount`.

A finding with `inScope: false` goes to the improvements ledger by default and never blocks the
task. It blocks only when the reviewer verifies, with evidence, that it affects THIS task's
acceptance criteria; say so explicitly when you promote one. Report `outOfScopeCount` with the
comparison result so a reviewer that ignored the declared scope is visible instead of silent.

## Run the two reviews concurrently

`mcp__codex__codex_review` is read-only and does not depend on Claude's pass, so never run the two
in series. Launch a background subagent whose single job is to call `mcp__codex__codex_review`
with the focus block above and return the result's `reviewFindings` and `status` verbatim; run
Claude's conformance → quality → security pass while it works; then compare. Only when the Agent
tool is unavailable call `mcp__codex__codex_review` directly after Claude's pass.

## Read Codex's findings from `reviewFindings`, not prose

The tool asks Codex to end with one fenced json block and parses it fail-closed into
`reviewFindings: { parsed, findings[], improvements[], dropped, droppedReasons[], parseError? }`.

- `parsed: true` → `findings[]` (severity ∈ CRITICAL/HIGH/MEDIUM/LOW, file, line, summary,
  expected, observed) and `improvements[]` (IMP ids) ARE the Codex review. Never re-grade a
  finding's severity from the surrounding prose.
- `dropped > 0` means Codex emitted malformed entries and **blocks acceptance**. The reviewer must
  read `droppedReasons` (one ordered reason per dropped entry, e.g. `findings[0].line`) and report
  them before treating the review as complete; a review with `dropped > 0` is incomplete, so the
  task stays not-accepted until the dropped entries are re-obtained in another reviewer round or the
  user explicitly waives them. Never reconstruct a dropped entry from the prose.
- `parsed: false` → say so to the user, work from the prose `agentMessage`, and mark every severity
  you assign yourself as unverified until the evidence check.

## Comparison protocol

- Bucket the union of Claude's and Codex's findings into agreed, unique-to-one, and conflicting.
- Verify EVERY finding with evidence: read the code and run the relevant test. Let the evidence determine the verdict, not the reviewer.
- Feed verified findings into the normal `mcp__codex__codex_continue` round per review-feedback severity rules (CRITICAL/HIGH always; MEDIUM/LOW piggyback only).
- Use AskUserQuestion ONLY when a CRITICAL/HIGH finding cannot be verified either way, or two mutually exclusive valid fixes exist.
- Give the verified outcome, including counts for each bucket and the resolution, to the single
  post-review Decision-log writer defined in `plan-architecture`; do not append from this review step.
- If `mcp__codex__codex_review` fails, times out, or returns status `partial`, proceed with Claude-only review, tell the user, and do not auto-retry because of quota.

## Improvements ledger

Append non-blocking improvements from BOTH reviews to `.codex-flow/IMPROVEMENTS.md`, one per line:
`- [ ] IMP-<n> (T<k>, source: codex|claude|both) <description> — <file:line>`
Allocate `IMP-<n>` from one global counter across the whole run, never from per-review counters.
When Claude and Codex suggest the same improvement, record ONE line with `source: both`.
The ledger NEVER blocks marking a task done and NEVER spends an `mcp__codex__codex_continue` round.

## Jev-assisted finding triage (optional)

Default to shadow-only logging; Jev output must not change review behavior. For each task review,
for each raw finding from Claude or Codex, before verification, first confirm from your own read
whether any security-review-mandatory-trigger category—auth/session, user input, database queries,
file paths, external API calls, crypto, payments, or secrets/env—is at stake. Only findings that
pass this check are included; findings that fail it are skipped entirely and handled via normal
Claude+Codex review—never build a batch from the full diff/context first and filter after. For each
included finding `<n>`, add a Score question `severity_<n>` with the 0–3 severity rubric and Noul
questions `is_duplicate_<n>` and `is_in_scope_<n>`. Claude may make one batched `askJev` call
(fan-out), with `state` containing only included findings. Invoke it through
`node scripts/jev-client.mjs ask --point review-triage --json '<json>'`;
unavailable or disabled Jev is non-blocking.

It never changes review-feedback.md's severity/3-round rule or the 3-round `codex_continue`
escalation rule; Jev output is additive metadata only. In `shadow` mode, after Claude finishes
its own verified severity/duplicate/in-scope call for each finding, log each comparison with:

```text
node scripts/jev-client.mjs log --point review-triage --jev '<jevAnswer>' --claude '<claudeVerdict>'
```

Behavior is unchanged. In `enforce` mode (defined for completeness, ships inert), annotate a
finding as `pre-triaged` in the findings table only when its Jev severity Score has confidence
greater than 0.85 and agrees with one reviewer's initial severity. CRITICAL/HIGH findings still
go through the full 3-round verify+continue loop unchanged.

## Jev-assisted root-cause classification (optional)

Default to shadow-only logging; Claude remains responsible for the decision. When a finding needs
implementation-bug-vs-plan-drift classification, first confirm from your own read whether any
security-review-mandatory-trigger category—auth/session, user input, database queries, file paths,
external API calls, crypto, payments, or secrets/env—is at stake for this finding. If one is at
stake, skip Jev entirely and rely on normal Claude+Codex review. Only when none is at stake, call
`askJev` with a Choice question `root_cause` whose choices are `implementation_bug`, `plan_drift`,
and `ambiguous`, as an advisory input for the command's Phase 5 step 6 plan-drift transaction.
Claude still makes the final call and still runs the existing plan-drift transaction unchanged.

## Improvement decision gate

- Consider only unchecked ledger entries without an `(approved: T<n>)` marker as pending. If `.codex-flow/IMPROVEMENTS.md` is missing or has no unchecked pending entries, skip AskUserQuestion and note "no improvements" in the delivery summary.
- After the final whole-feature review, compile those entries into a summary and proposed execution plan, grouped and effort-estimated, then present it via AskUserQuestion.
- Slice approved items into new tasks and append them to `.codex-flow/TASKS.md`. Mark each approved ledger line `(approved: T<n>)` when its task is created, then check it off when the task passes review.
- Run approved tasks through the normal Phase 4 → Phase 5 loop. Improvement tasks spawned by the gate do NOT re-trigger the decision gate themselves.
- Have the orchestrator record declined items once using `plan-architecture`'s non-task event-block
  schema, then check off each ledger line with `(declined)`.

### Jev-assisted improvement prioritization (optional)

Default to shadow-only logging; Jev output only helps order the summary. For each pending
`.codex-flow/IMPROVEMENTS.md` entry, Claude must first confirm from its own read that its
description does not quote code in any security-review-mandatory-trigger category—auth/session,
user input, database queries, file paths, external API calls, crypto, payments, or secrets/env. If
such a category is at stake, skip the Jev call for that item entirely and use the normal
Claude+Codex judgment; never call-then-filter. Only descriptions that pass this check may be sent
in `state` for an optional Jev Score question (0–3, “worth a new task”), used only to order the
summary presented through AskUserQuestion. The user still approves/declines each item manually,
unchanged. Log shadow comparisons with `node scripts/jev-client.mjs log --point
improvement-priority --jev '<jevAnswer>' --claude '<claudeVerdict>'`; no approval, task creation,
or ledger status changes are automated.
