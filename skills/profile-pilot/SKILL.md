---
name: profile-pilot
description: Conditional multiscope Phase 1 rules for data deliverables, evidence, and run language.
---

# Profile pilot (multiscope Phase 1)

Load this skill when `profileMode` is `enforce`, `evidenceMode` is not `off`, or `languageMode` is `on`. Its rules replace the gates they name; each switch is independent. The Router table applies only when the confirmed profile is `data`.

**Helpers**: required — profile-router.mjs, evidence-check.mjs, scope-check.mjs; helper rule: paths are `scripts/profile-router.mjs`, `scripts/evidence-check.mjs`, `scripts/scope-check.mjs`; if helper is missing, STOP and tell the user to reinstall the plugin; profile-router.mjs or `scope-check.mjs snapshot` non-zero → surface error and STOP; scope-check task exit 1 is a blocking finding routed per the scope trip-wire; evidence-check.mjs exit 1 or 2 is routed back to Codex.

## Router (enforce, data)

| Gate | Replacement |
| --- | --- |
| Known-red test baseline | Snapshot input paths, `du -h` sizes, row counts, and sha256 into PLAN.md's Known-red section; initialize with `--known-red "n/a (data profile)"`. |
| Verify command | Use `evidence-check.mjs` as `verifyCommand` when `evidenceMode` is `enforce`; otherwise omit `verifyCommand` and apply the `exec-deliverable` Verification block, with Claude re-deriving one figure. |
| Codex review git diff | Run `codex_review` scoped to the deliverable and its manifest, plus the rubric below. |
| Checkpoint task commits | Approve with `--checkpoint-commits no`; record each task's base as the tree id printed by `node "${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs" snapshot` (scope-check accepts it as `--base`). |

Data tasks embed `codex-flow:exec-deliverable` blocks instead of coding blocks.
For the gates named in the Router table, these replacements take precedence over the command's generic steps.

## Profile correction

If the confirmed profile is not `data` while the router is enforcing, run the skipped Phase 0 gates before continuing: run the known-red test baseline and record it with `flow-state set knownRed "<compact list>"`, noting the correction in PLAN.md's Known-red section. From then on apply the normal gates: `verifyCommand`, git-diff review, and the checkpoint question.
If the confirmed profile is corrected to `data` while enforcing, run `flow-state set profile data`, keep the known-red baseline already recorded, and apply the Router replacements for the remaining gates from then on.

## Evidence

Embed the Evidence block and use the checker only when `evidenceMode` is not `off`; with evidence `off`, data tasks use the `exec-deliverable` Verification block alone.

```
Evidence block
- Write `evidence.json` next to the deliverable with `schemaVersion: 2` (v1 is rejected), `deliverable`, `figures` (id, value, command, and optional tolerance, timeoutMs, display), `claims` (id, text, sources), and optional `tables[]` and `ignoreNumbers`.
- Put `<!--Fn-->` directly after every measured number in prose. A table copied from a results file needs a caption line carrying `<!--Tn-->` plus a `tables[]` entry whose command prints CSV with the header row first; compare cells exactly, and do not anchor its numbers.
- Use `ignoreNumbers` only for structural literals: no `.`, `,`, or `%`, integers ≤ 100, and never a figure value or display.
- Every claim cites at least one figure id. V2 adds findings `anchor-mismatch`, `anchor-unknown`, `unanchored-number`, `table-unknown`, `table-mismatch`, `table-command`, and `claim-no-figure`; existing figure, claim, and source findings still apply.
- Keep commands portable: use `node`, `duckdb`, or `python3` invocations runnable from the manifest directory.
- Run `evidence-check.mjs --manifest evidence.json` before finishing; the orchestrator gives the absolute script path.
```

In shadow, after acceptance, Claude runs the checker with `--json` and records the result in reviews.md without blocking. In enforce, the same command, with the plugin root expanded to an absolute path, is the task `verifyCommand`. Evidence-check exit 1 is a finding and exit 2 is a manifest error; route either back to Codex. evidence.json is executable: its commands run with the operator's shell and have the same trust as a verifyCommand, so review them like code.

## Fast-path analysis lane

When `CODEX_FLOW_EVIDENCE` is `shadow` or `enforce`, write `evidence.json` (v2) next to the deliverable and run the checker. In `enforce`, deliver only after exit 0; in `shadow`, put the result in the "what I verified" note. Append `evidence=<pass|fail|off>` to the `fastpath.log` line.

## Rubric and sampling

For data deliverables, when the router is enforcing or evidence is on, score each item pass/fail with evidence in reviews.md:

- `reproducible`
- `sourced`
- `answers the question`
- `decision-useful`
- `language-consistent`

When evidence is not off, run the checker with `--sample 3 --seed <task number>` and ask the owner to verify the three sampled claims in ONE AskUserQuestion, one question per claim. Record the answers in reviews.md. A claim the owner marks wrong is a finding routed back to Codex.

## Run language

When the router is enforcing, the first interview question confirms the profile; when `languageMode` is `on`, it also confirms the run language (one AskUserQuestion can carry both). A corrected profile is recorded with `flow-state set profile <p>`. `mixed` resolves to `vi` or `en`; record the language with `flow-state set runLanguage <vi|en>`. Every Codex prompt gets this line immediately after the `Run position:` line:

`Deliverable language: <vi|en>`

Write acceptance criteria and reports in that language; this overrides the session-report latest-message rule. Keep code and code comments in English.

## Ledger

The run-ledger append carries `--profile-mode`, `--evidence-mode`, and `--language-mode` from STATE.md.
Missing optional keys in an older STATE.md mean `off` for modes and `-` for `profile` and `runLanguage`.
