# Codex CLI protocol canary fixtures

Version-pinned captures of the raw JSONL stream that `codex exec --json` writes to stdout.
`tests/protocolFixtures.test.ts` replays every `codex-<version>.jsonl` file here through
`src/eventParser.ts` and asserts the protocol invariants the server depends on:

- zero parse errors, zero run errors (each fixture is a successful trivial run)
- a terminal `turn.completed`/`turn.failed` event is seen (`sawCompletion`)
- a non-empty `sessionId` is extracted from `thread.started`
- `unknownEvents` equals the `expectedUnknownEvents` pinned in the meta sidecar
- the incremental parser fed in 7-byte chunks matches the batch parse exactly

Purpose: a Codex CLI upgrade that changes the JSONL shape fails these tests loudly instead of
silently degrading (e.g. `sawCompletion` never becoming true would make every run report partial).

## Files

- `codex-<version>.jsonl` — raw stdout capture (home directory redacted to `~`)
- `codex-<version>.meta.json` — `{ codexVersion, capturedAt, prompt, synthetic, expectedUnknownEvents }`

## How to refresh

Requires a logged-in Codex CLI (`codex login status`). Then:

```sh
node scripts/refresh-protocol-fixtures.mjs
```

If `codex` on your PATH is a wrapper/shim that injects extra flags (it would pollute the capture
with environment-specific events), point the script at the real binary:

```sh
CODEX_BIN=/opt/homebrew/bin/codex node scripts/refresh-protocol-fixtures.mjs
```

The script runs a trivial read-only prompt in a temp dir with an isolated `CODEX_HOME` (seeded
only with your auth), so local config/hooks don't leak into the fixture.

## When to refresh

- After upgrading the Codex CLI (keep the old fixture — invariants should hold across versions;
  delete it only when a version is no longer supported).
- When the `unknownEvents` assertion fails: the CLI introduced new event types. Re-capture, then
  review `src/eventParser.ts` to decide whether the new events carry data worth extracting.

Known unknown events as of 0.144.6: `turn.started` (informational, intentionally unhandled).
