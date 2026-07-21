# Benchmarks & Soak Harness

Reproducible local benchmarks with SLO thresholds for the runtime's hot paths. No real `codex`
CLI (and no network) is involved: the runner bench writes a small fake codex node script to a
temp dir and injects it through the runner's `CODEX_BIN` env override
(`resolveCodexBinary` in `src/codexRunner.ts`), so the real spawn / process-group / streaming /
kill machinery is exercised end to end against a deterministic child process.

## How to run

```bash
npm run build              # benches import the compiled dist/ modules
node scripts/bench-runner.mjs
node scripts/bench-metrics.mjs
```

Each script prints a `metric → measured → SLO → PASS/FAIL` table, exits `1` on any FAIL, and
cleans up its temp dirs in a `finally`. Node builtins only — no extra dependencies.

Options:

- `BENCH_MAX_CONCURRENT=<n>` — worker-pool width for the batch scenario (default 10, matching
  `DEFAULT_BATCH_CONCURRENCY`).

These benches are intended to be run **manually / pre-release** (e.g. before cutting a version or
after touching the runner, batch, metrics, or session-store code). They are deliberately **not**
part of the default CI pipeline: they measure wall-clock and RSS on real spawned processes, which
is too machine-sensitive for a shared-runner gate. The SLOs below are generous local bounds tuned
~3x above the actuals measured on this machine so laptop/CI variance doesn't flake them.

## `scripts/bench-runner.mjs` — runner hot paths

| Scenario | SLO | What it proves |
| --- | --- | --- |
| Large-output run: fake codex streams **50MB** of JSONL events | peak RSS delta **< 150MB**; wall **< 3s**; `parsed.sawCompletion` true, exit 0 | The streaming tail design is O(1) memory: the incremental parser sees the full stream while raw stdout keeps only a 1MB tail (`RAW_STDOUT_TAIL_BYTES`), so a multi-GB run can't OOM the server. |
| Batch of **50 tasks** (~100ms each) through `runBatch` at 10 workers | wall **< 2.5s** and strictly **< serial estimate (5s)**; all tasks succeed; active handles back to baseline; **0** leftover/zombie children (POSIX `ps` check) | The worker pool actually parallelizes (not serial), and a completed batch leaks neither libuv handles nor child processes. |
| Cancellation: abort a hung fake run that spawned a `sleep` grandchild | abort → settle **< 500ms**; outcome flagged `aborted`; grandchild dead within 300ms | Cancellation settles promptly (releasing the cwd lock / concurrency slot) and the process-group SIGTERM reaches descendants, not just the direct child. |

## `scripts/bench-metrics.mjs` — metrics log & session store scale

Both read paths have injectable roots, so the bench times the real exported functions from
`dist/` against synthetic data: `metricsLog` takes a `logPath` option and `sessionStore.listSessions`
takes a `codexHome` option (no pure-function fallback was needed).

| Scenario | SLO | What it proves |
| --- | --- | --- |
| `readMetrics` + `aggregate()` (with pricing) over **5,000** `MetricEntry` lines split across the active file and its rotated `.1` back-file | **< 500ms** | Metrics aggregation stays interactive at 10MB-rotation scale, including the rotated-file merge. |
| `listSessions` over **2,000** synthetic rollout files in a `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` layout (default limit + `limit=500`) | **< 1s** combined | Session discovery (walk + stat + head-read of the newest `limit` files) scales to a busy history without reading whole rollout files. |

## Current measured numbers (this machine)

Measured 2026-07-21 on Apple Silicon macOS (Darwin 27.0.0), Node 20+, APFS, repo on OneDrive-synced
storage. Expect different absolute numbers elsewhere; the SLOs absorb that.

| Metric | Measured | SLO |
| --- | --- | --- |
| large-run: peak RSS delta (50MB stream) | ~29MB | < 150MB |
| large-run: wall time | 220–463ms | < 3,000ms |
| batch: wall time (50×100ms @ 10 workers) | ~710ms | < 2,500ms (serial ≈ 5,000ms) |
| batch: active handles / leftover children after completion | baseline / 0 | baseline / 0 |
| cancel: abort → settle latency | ~1ms | < 500ms |
| cancel: grandchild reaped | yes (< 300ms) | < 300ms |
| metrics: read + aggregate 5,000 entries (+ rotated `.1`) | ~5ms | < 500ms |
| sessions: list 2,000 rollouts (default + limit 500) | ~75ms | < 1,000ms |

## Notes & findings

- No leaks observed: after the 50-task batch, `process._getActiveHandles()` returned to its
  warmed-up baseline and `ps` showed zero surviving or zombie children.
- Cancellation is effectively instant (~1ms to settle) because the fake child dies on the first
  process-group SIGTERM; the 500ms SLO leaves room for slower real-world teardown.
- The 50MB stream held peak RSS growth to ~29MB — consistent with the 1MB raw-stdout tail plus
  transient pipe buffering — confirming `parsed` stays lossless while raw retention is capped.
- Helper unit tests for the shared bench utilities live in `tests/benchHarness.test.ts`
  (`scripts/bench-lib.mjs` is the shared module: table printing, temp-dir lifecycle, fake codex writer).
