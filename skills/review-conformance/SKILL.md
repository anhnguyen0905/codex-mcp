---
name: review-conformance
description: Conformance review — verify Codex's output against the confirmed requirements, the approved plan/architecture, and the task's acceptance criteria before any quality nitpicking.
---

# Conformance Review (first pass, before quality)

Wrong-but-clean code is worse than ugly-but-right code. Check conformance FIRST.

## Three-level check

1. **Requirement conformance** — For each acceptance criterion of the task: point at the exact code/test that satisfies it. No pointer = finding. Check scope both ways: nothing promised is missing, and nothing out-of-scope was touched (the `diff.status` list shows every file — files outside the task's declared `Files:` list need justification).
2. **Plan/architecture conformance** — Does the implementation follow the approved design: same components, same data flow, same chosen option? Codex silently substituting its own design is a finding even when the substitute works — the plan was reviewed, the substitute wasn't. If the deviation is genuinely better, surface it to the user as a plan change, don't wave it through.
3. **Structure conformance** — Files in the right places, naming matching conventions, integration through existing seams (not parallel copies of existing helpers), tests where the project keeps tests.

## Evidence rules

- Work from the tool result's `diff` field (status + patch); read full files when the patch lacks context. Never review from Codex's `agentMessage` alone — it describes intent, not reality.
- Run the acceptance checks yourself (tests, build, manual probe). `commands` in the result shows what Codex ran and exit codes — verify it actually ran the full suite, not a subset.

## Output

A conformance verdict per acceptance criterion (met / not met / partially met + evidence), feeding into review-feedback for anything not met.
