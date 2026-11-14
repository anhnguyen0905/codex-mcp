# Profile pilot

The multiscope Phase 1 pilot applies data, design, plan, and content profiles while keeping routing, evidence checking, and run language separable. Three independent switches control them. Defaults preserve today's behaviour.

## Switches

| Environment variable | Values (default) | Effect |
| --- | --- | --- |
| `CODEX_FLOW_PROFILE_MODE` | `off` \| `shadow` \| `enforce` (`shadow`) | `off` leaves gates unchanged; `shadow` records what the confirmed non-code profile would replace; `enforce` replaces the four profile gates. |
| `CODEX_FLOW_EVIDENCE` | `off` \| `shadow` \| `enforce` (`off`) | `off` does not require evidence; `shadow` checks evidence after acceptance without blocking; `enforce` uses the checker as the verification command. |
| `CODEX_FLOW_RUN_LANGUAGE` | `off` \| `on` (`off`) | `off` does not detect a run language; `on` detects `vi`, `en`, or `mixed` and carries it through the run. |

The defaults keep today's behaviour. In particular, profile `shadow` only logs to `.codex-flow/notes/profile-shadow.log`. An unknown value falls back to that switch's default and emits a warning.

## State

The optional `STATE.md` keys are `profile`, `profileMode`, `evidenceMode`, `languageMode`, and `runLanguage`. `flow-state init` sets them from the router's `initFlags`; resume preserves and reuses them. Values are `profile`: `code|data|design|plan|content|mixed|-`, `profileMode` and `evidenceMode`: `off|shadow|enforce`, `languageMode`: `off|on`, and `runLanguage`: `vi|en|mixed|-`.

## Profile routing

When `profileMode` is `enforce`, the router replaces these inventory gates for confirmed `data`, `design`, `plan`, and `content` profiles: Known-red test baseline, Verify command, Codex review git diff, and Checkpoint task commits. See the [gate inventory](gate-inventory.md) table. The profile-correction rule is: if the confirmed profile is `code` or `mixed`, run the skipped known-red baseline, record it with `flow-state set knownRed <value>`, then apply normal gates. Non-code tasks load `codex-flow:profile-design`, `codex-flow:profile-plan`, or `codex-flow:profile-content` as applicable; each supplies its own rubric. Code and mixed routing remain unchanged.

## Entry commands

`/codex-flow:analyze`, `/codex-flow:design`, and `/codex-flow:plan` preset the profile and force the full flow. Analyze presets `data`; design presets `design`; plan presets `plan`.

## Evidence manifest

Write `evidence.json` next to the deliverable. It has `schemaVersion: 2`, a relative `deliverable`, `figures`, `claims`, and optional `tables[]` and `ignoreNumbers`. A figure has an `id` (`F<n>`), numeric `value`, shell `command`, and optional numeric `tolerance`, positive integer `timeoutMs`, and string-array `display`. A claim has an `id` (`C<n>`), `text`, and `sources` containing a figure id, relative `file[:line]`, or URL.

```json
{
  "schemaVersion": 2,
  "deliverable": "report.md",
  "figures": [{"id": "F1", "value": 42, "command": "node -e \"const row=require('fs').readFileSync('results/q1.csv','utf8').trim().split('\\n')[1].split(','); console.log(row[2])\"", "display": ["42.0"]}],
  "claims": [{"id": "C1", "text": "The result is 42.0.", "sources": ["F1"]}]
}
```

Report example: `Revenue was 42.0<!--F1-->.`

Run the checker with `node scripts/evidence-check.mjs --manifest <path> [--json] [--sample <n> [--seed <int>]]`.

It exits `0` for no findings, `1` for findings, and `2` for a manifest or invocation error. Findings are named `figure-timeout`, `figure-command-failed`, `figure-not-numeric`, `figure-mismatch`, `claim-unsourced`, `claim-no-figure`, `source-unknown-figure`, `source-missing`, `anchor-mismatch`, `anchor-unknown`, `unanchored-number`, `table-unknown`, `table-mismatch`, and `table-command`.

## Run language

With `languageMode` `on`, after acceptance run `node "${CLAUDE_PLUGIN_ROOT}/scripts/language-check.mjs" --deliverable <path> --language <runLanguage>` for each deliverable. In `shadow` or `off` profile mode, record the result in reviews.md; in `enforce`, exit 1 findings (`untranslated-term` or `wrong-language-term`) route back to the executor. Exit 2 is a usage error: surface it and stop. With `languageMode` `off`, never run the checker.

If `tolerance` is omitted, `defaultTolerance(value)` derives it from the figure `value` as written in the manifest: the numeric string `"12.30"` gives `0.005`, while the JSON number `42` gives `0.5`. In v2, each measured number needs an anchor; `display` matches the formatted literal at that anchor. The checker ignores numbers in fenced or inline code, ISO date-times, `HH:MM` times, `dd/mm/yyyy` dates, years 1900–2100, list markers, or numbers glued to letters/identifiers.

`evidence.json` is executable: its commands run with the operator's shell and have the same trust boundary as a `verifyCommand`. Review those commands as code.

## Evaluation procedure

1. Record the baseline with all defaults using the [baseline procedure](gate-inventory.md#baseline-procedure).
2. Run pilot variants that change **one switch at a time**.
3. Compare runs with `node scripts/run-ledger.mjs summary --filter profileMode=enforce`, and use the analogous `evidenceMode=enforce` and `languageMode=on` filters. Filters are repeatable and ANDed; an absent mode field counts as `off`.
4. Pass only when always-loaded bytes do not increase (command ≤ 15 000 B, fast-path lane ≤ 5 000 tokens at chars/4, flow total ≤ 158 686 B, with per-phase loaded ceilings pinned in `tests/flowDocs.test.ts`), `tests/evidenceCheck.test.ts` is green, and median `fixRounds`, `ownerGates`, and `wallClockMinutes` are no worse than baseline.
