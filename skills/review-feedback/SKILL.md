---
name: review-feedback
description: Review verdict process — severity levels, the codex_continue feedback format that gets findings fixed in one round, and the 3-round escalation rule.
---

# Review Feedback Process

## Severity levels

| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Security vulnerability, data loss, breaks existing behavior | Block — must fix this round |
| HIGH | Bug, unmet acceptance criterion, missing/false tests | Fix before task is done |
| MEDIUM | Maintainability concern, convention violation | Fix if the round is cheap; else note |
| LOW | Style/naming preference | Mention once; never spend a round on it alone |

## Feedback format for `codex_continue`

Numbered, concrete, self-contained — Codex sees only what you send, not your reasoning:

```
Review findings to fix (address ALL, re-run the full test suite, do not change anything else):
1. [HIGH] src/api/users.ts:42 — `getUser` returns 200 with null body when the ID doesn't exist;
   acceptance criterion 2 requires 404. Fix the handler and add a test for the missing-ID case.
2. [MEDIUM] src/api/users.ts:15 — validation duplicates `validateId` from src/lib/validate.ts; use it.
```

Rules: exact file:line · observed vs expected behavior · which criterion/standard it violates · what "fixed" looks like. Group by file. Send CRITICAL/HIGH always; MEDIUM/LOW piggyback only.

## Round discipline

- Re-review after every round: verify each finding is actually fixed (re-run tests yourself) and nothing new broke — diff the diff.
- Max 3 rounds per task. Persisting findings after 3 rounds → stop sending to Codex; tell the user, then either fix by hand (flagging it) or re-plan the task.
- Never fix Codex's code yourself during rounds 1–3 — parallel edits desync the Codex session's view of the workspace.
- Clean review → mark the task done, state what was verified (suite ran, criteria met) — not just "looks good".
