---
name: exec-deliverable
description: Non-code deliverable standards to embed into Codex prompts when a task produces content rather than code — data analysis, marketing copy, docs, research, plans. Replaces the coding-standards + self-testing blocks for non-engineering output, with the same "prove your own work" verification bar.
---

# Deliverable Standards for Non-Code Output (embed into Codex prompts)

The core flow assumes code, so Phase 4 embeds `exec-coding-standards` + `exec-self-testing` by
default. When a task's output is **content, not code** (a data analysis, a marketing brief, a
launch email, documentation, a research summary, a plan), those blocks don't fit. Embed THIS block
instead — plus any domain skills selected via `skill-selection`.

## Standards block

```
Deliverable standards (mandatory — this task produces content, not code):
- Accuracy first: every factual claim, number, or quote must be verifiable. Do not invent data,
  statistics, sources, quotes, or citations. If a figure is estimated or assumed, label it as such.
- Ground it: derive conclusions from the provided inputs/files/data; when you use an external fact,
  name the source. Distinguish "the data shows X" from "I recommend Y".
- Structure for the audience: lead with the answer/recommendation, then support it; use headings,
  short paragraphs, and lists so the reader can scan. Match the requested format and length exactly.
- Match voice & conventions: follow the project's existing tone, terminology, and templates (read a
  sample first) over a generic voice. Respect brand/style guides when provided.
- Scope discipline: deliver what the task asked for and nothing extra; flag gaps or missing inputs
  rather than filling them with speculation.
- No fabrication of authority: never imply endorsement, real people's words, or official records
  that don't exist.
```

## Verification block (the non-code equivalent of self-testing)

```
Verification before finishing (mandatory):
- Re-derive every number from the source data — recompute totals/percentages, don't eyeball them.
  For analysis tasks, show the calculation or the query so it can be checked.
- Fact-check each external claim against its named source; remove or flag anything you can't support.
- Check the piece against the task's acceptance criteria one by one before declaring done.
- Proofread: no broken references, no placeholder text, no contradictions between sections.
- State explicitly what you verified and what remains an assumption the reviewer should confirm.
```

## Claude's review duty for non-code tasks

Phase 5 conformance/quality still applies, re-read for content: does it meet each acceptance
criterion, are the numbers reproducible from the source, are claims sourced (not fabricated), does
it match the requested format and the project's voice? Spot-check at least one figure and one claim
yourself — Codex's "verified" is input, not evidence. `review-security` still triggers if the
deliverable embeds credentials, PII, or internal data that shouldn't leave the workspace.
