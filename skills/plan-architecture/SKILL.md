---
name: plan-architecture
description: Architecture design for the Planning phase — codebase convention discovery, 2-3 option trade-off analysis, and the PLAN.md structure that Codex executes against.
---

# Architecture Planning

## Step 1 — Discover conventions before designing

Read the codebase until you can answer: How are modules organized (by feature or by layer)? How do errors propagate? Where does validation live? How is the existing code tested? What naming style rules? Your design must read like the codebase's current author wrote it — deviations are review findings waiting to happen.

## Step 2 — Compare options before choosing

For any non-trivial design decision, write 2–3 realistic options with trade-offs:

```markdown
### Decision: <what>
- Option A: … | + simple, matches existing pattern X | − doesn't scale past Y
- Option B: … | + handles Y | − new dependency, more moving parts
→ Chosen: A, because Y is out of scope (see requirements).
```

Never present only one option — the first idea is rarely the best, and the comparison is what makes the plan reviewable. Tie every "chosen because" back to a confirmed requirement.

## Step 3 — Write PLAN.md

```markdown
# Plan: <feature>
## Context        — what the project is; conventions Codex MUST follow (list them explicitly)
## Objective      — confirmed goal from the interview
## Architecture   — components touched, data flow, decisions + why (from step 2)
## Out of scope   — things Codex must NOT do or touch
## Acceptance criteria — verifiable checks for the whole feature
```

## Design principles

- Smallest architecture that satisfies the confirmed requirements — no speculative extension points (YAGNI).
- Respect existing boundaries; don't introduce a new layer/pattern unless an option-analysis justifies it.
- Design for testability: seams (injected dependencies) where Codex will need to fake I/O.
- Flag risky areas (migrations, shared state, public API changes) so the backlog isolates them into their own tasks.
