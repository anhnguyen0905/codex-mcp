---
description: "Run codex-flow with the data profile preset"
argument-hint: "<task or request>"
---

# Codex Flow — Analyze

Task: $ARGUMENTS

- Invoke `codex-flow:codex-flow` with the same arguments (`$ARGUMENTS`).
- Run the full flow. The Profile router is Full flow only (not fast-path lanes); do not take a fast-path lane. This preset counts as the "full flow" request.
- At the Phase 0 Profile router step, pass `--profile data` instead of classifying.
- In the Phase 1 interview, confirm the preset profile instead of asking for it. A correction follows the normal profile-correction rule in `codex-flow:profile-pilot`.
- `profileMode`, `evidenceMode`, and `languageMode` come from `CODEX_FLOW_PROFILE_MODE`, `CODEX_FLOW_EVIDENCE`, and `CODEX_FLOW_RUN_LANGUAGE`; never set them here.
