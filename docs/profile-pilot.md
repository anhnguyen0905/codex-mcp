# Profile pilot

The multiscope Phase 1 pilot applies a data-analysis profile while keeping its effects separable. Three independent switches control routing, evidence checking, and run language. Defaults preserve today's behaviour.

## Switches

| Environment variable | Values (default) | Effect |
| --- | --- | --- |
| `CODEX_FLOW_PROFILE_MODE` | `off` \| `shadow` \| `enforce` (`shadow`) | `off` leaves gates unchanged; `shadow` records what the data profile would replace; `enforce` replaces the four data gates. |
| `CODEX_FLOW_EVIDENCE` | `off` \| `shadow` \| `enforce` (`off`) | `off` does not require evidence; `shadow` checks evidence after acceptance without blocking; `enforce` uses the checker as the verification command. |
| `CODEX_FLOW_RUN_LANGUAGE` | `off` \| `on` (`off`) | `off` does not detect a run language; `on` detects `vi`, `en`, or `mixed` and carries it through the run. |

The defaults keep today's behaviour. In particular, profile `shadow` only logs to `.codex-flow/notes/profile-shadow.log`. An unknown value falls back to that switch's default and emits a warning.

## State

The optional `STATE.md` keys are `profile`, `profileMode`, `evidenceMode`, `languageMode`, and `runLanguage`. `flow-state init` sets them from the router's `initFlags`; resume preserves and reuses them. Values are `profile`: `code|data|design|plan|content|mixed|-`, `profileMode` and `evidenceMode`: `off|shadow|enforce`, `languageMode`: `off|on`, and `runLanguage`: `vi|en|mixed|-`.

## Data profile

When the confirmed profile is `data` and `profileMode` is `enforce`, the router replaces these inventory gates with the profile rules: Known-red test baseline, Verify command, Codex review git diff, and Checkpoint task commits. See the [gate inventory](gate-inventory.md) table. The profile-correction rule is: if the confirmed profile is not `data` while routing is enforcing, run the skipped known-red baseline, record it with `flow-state set knownRed <value>`, then apply the normal verify-command, git-diff review, and checkpoint question.

## Evidence manifest

Write `evidence.json` next to the deliverable. It has `schemaVersion: 1`, a relative `deliverable`, `figures`, `claims`, and optional `ignoreNumbers`. A figure has an `id` (`F<n>`), numeric `value`, shell `command`, and optional numeric `tolerance`, positive integer `timeoutMs`, and string-array `display`. A claim has an `id` (`C<n>`), `text`, and optional `sources` containing a figure id, relative `file[:line]`, or URL.

```json
{
  "schemaVersion": 1,
  "deliverable": "report.md",
  "figures": [{"id": "F1", "value": 42, "command": "node -e \"console.log(42)\"", "display": ["42.0"]}],
  "claims": [{"id": "C1", "text": "The result is 42.0.", "sources": ["F1"]}]
}
```

Run the checker with `node scripts/evidence-check.mjs --manifest <path> [--json] [--sample <n> [--seed <int>]]`.

It exits `0` for no findings, `1` for findings, and `2` for a manifest or invocation error. Findings are named `figure-timeout`, `figure-command-failed`, `figure-not-numeric`, `figure-mismatch`, `claim-unsourced`, `source-unknown-figure`, `source-missing`, and `undeclared-number`.

If `tolerance` is omitted, `defaultTolerance(value)` derives it from the figure `value` as written in the manifest: the numeric string `"12.30"` gives `0.005`, while the JSON number `42` gives `0.5`. The `display` literals only affect the undeclared-number scan. Number declarations include each figure `value`, its `display` literals, and `ignoreNumbers`. The checker does not count numbers in fenced or inline code, ISO date-times, `HH:MM` times, `dd/mm/yyyy` dates, years 1900–2100, list markers, or numbers glued to letters/identifiers.

`evidence.json` is executable: its commands run with the operator's shell and have the same trust boundary as a `verifyCommand`. Review those commands as code.

## Evaluation procedure

1. Record the baseline with all defaults using the [baseline procedure](gate-inventory.md#baseline-procedure).
2. Run pilot variants that change **one switch at a time**.
3. Compare runs with `node scripts/run-ledger.mjs summary --filter profileMode=enforce`, and use the analogous `evidenceMode=enforce` and `languageMode=on` filters. Filters are repeatable and ANDed; an absent mode field counts as `off`.
4. Pass only when always-loaded bytes do not increase (the pinned limits are command ≤ 43 150 bytes and flow total ≤ 162 943 bytes), `tests/evidenceCheck.test.ts` is green, and median `fixRounds`, `ownerGates`, and `wallClockMinutes` are no worse than baseline.
