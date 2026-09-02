# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Structured review findings** — `codex_review` now instructs Codex to end with one fenced json
  block and returns it parsed fail-closed as `reviewFindings: { parsed, findings[], improvements[],
  dropped, parseError? }` (new `src/reviewFindings.ts`). Severities are restricted to
  CRITICAL/HIGH/MEDIUM/LOW; malformed entries are dropped and counted, never coerced. Phase 5 and
  `review-dual` read this field instead of re-deriving severities from prose.

### Changed

- **Concurrent dual review** — Phase 5 launches `codex_review` in a background subagent BEFORE
  Claude's own conformance/quality/security pass and collects it afterwards, instead of running the
  two reviews in series (sequential fallback when the Agent tool is unavailable).

## [0.22.0] - 2026-09-02

### Added

- **Executor fallback in `/codex-flow`** — when `codex_health` fails, the server is missing, Codex
  is logged out, or a run dies mid-backlog with an unhealthy re-check, the flow offers one explicit
  AskUserQuestion: fix Codex and re-check, or continue with Claude as executor. Under fallback Claude
  implements each task from the same context slice under the same embedded standards blocks, runs
  the acceptance command itself (`- Verification:` line), and an independent subagent review replaces
  `codex_review` so Claude never grades its own homework alone. The switch is recorded in a new
  STATE.md key `executor` (`codex` | `claude (fallback: <reason> <ISO>)` | `codex (restored <ISO>)`),
  happens only at a task boundary, and reverses at any boundary once Codex is healthy again. The
  analysis lane still needs no decision; the small-change lane may run under fallback. Preflight and
  session-report skills carry the new key and PIC value; `tests/flowDocs.test.ts` guards the contract.

- **Server-side acceptance verification** — `codex_execute` / `codex_continue` accept
  `verifyCommand` (+ `verifyTimeoutMs`, default 10 min, cap 30). After the logical run settles
  (post auto-resume, still inside the cwd lock) the server runs the command in `cwd` and attaches
  `verification: { command, exitCode, timedOut, durationMs, outputTail, passed, skipped? }` to the
  payload and `structuredContent`. Skipped with `skipped: "run-failed"` when the run failed/aborted;
  never alters `status`/`isError`. Phase 4 passes the task's acceptance command; Phase 5 reads the
  field instead of trusting Codex's account. New module `src/verification.ts`.
- **`errorMessage` on metric entries** — the first Codex-emitted error message (head, 200 chars) is
  recorded next to `errorKind`, so turn-failed runs can be classified offline (quota vs sandbox vs
  model).

### Fixed

- **Test runs no longer pollute the operator's metrics log** — `tests/setup.ts` redirects
  `CODEX_MCP_METRICS_LOG` to a per-worker temp file, and `appendMetric` refuses to write to the
  default `~/.codex-mcp/metrics.jsonl` when running under vitest without an explicit destination
  (`isMetricsWriteSuppressed`). Before this, ~97% of the lines in a developer's real log were
  fixture runs (`/repo`, `/w/1`, …), making `codex_metrics` and `session-cost.mjs` untrustworthy.
  `appendMetric` now returns whether a line was written.

## [0.21.1] - 2026-08-22

### Fixed

- **Analysis lane no longer blocked by Codex login** — the Fast-path gate's analysis lane needs
  no Codex session, so a failed `codex_health` check or missing login no longer stops
  analysis-only requests; the small-change lane and the full flow still require `loggedIn: true`.

### Added

- **Mechanical scope trip-wire for the small-change lane** — after each fast-path
  `codex_execute`/`codex_continue`, the actual changed files are diffed against the ≤ 2 files the
  lane was entered with; any extra file (excluding generated lockfiles) triggers escalation to the
  full flow automatically instead of relying on judgment.
- **Small-change lane known-red baseline** — the lane runs the project's test command once before
  executing and only counts failures absent from that list against the change.
- **Fast-path log** — every fast-path run appends one durable line to
  `.codex-flow/notes/fastpath.log` (lane, task, sessionId, outcome), preserving the session
  lineage for `codex_continue` fix rounds and leaving an audit trail even on escalation.
- **Measure-before-choosing rule** — the Data tooling block and Phase 4 now require measuring
  input sizes (`du -h`) before selecting tooling instead of guessing against the ~50 MB threshold.
- **Guard tests** — `tests/flowDocs.test.ts` now locks the Fast-path gate contract (lanes,
  health-gate exemption, trip-wire, known-red, log) and the data-processing tooling rules in
  Phase 4 and `exec-deliverable`.

## [0.21.0] - 2026-08-22

### Added

- **Fast-path gate in `/codex-flow`** — a new section between Phase 0 and Phase 1 routes small
  and analysis-only tasks around the full six-phase machinery. Two lanes: an *analysis lane*
  (answer/report/readout with no tracked-file changes — Claude works directly, no control files,
  no Codex session required) and a *small-change lane* (≤ 2 well-specified files — one
  `codex_execute` with the usual embedded blocks plus one Claude review pass, skipping backlog,
  dual review, reports, and the improvement gate). Security-sensitive or multi-component work is
  always excluded, and an escalation rule restarts at Phase 1 the moment a task outgrows its
  lane. This removes the fixed multi-phase overhead that made simple-to-medium requests slow.
- **Data tooling block in `exec-deliverable`** — mandatory rules embedded into Codex prompts for
  any task processing datasets beyond ~50 MB: ingest raw exports once into columnar form (DuckDB/
  Parquet) and query that, never write row-by-row scan scripts over large raw files regardless of
  the repo's language, develop on a sample and run the full pass exactly once, build shared
  intermediate tables instead of per-report full scans, copy inputs out of cloud-synced folders,
  and aggregate incrementally instead of accumulating per-row objects in RAM.
- **Phase 4 data-processing tooling rule** — the project-language skill now explicitly governs
  only code that lands in the repo; ad-hoc data processing follows the Data tooling block, so a
  TypeScript project no longer causes Codex to scan an 800 MB CSV with Node readline scripts.

## [0.20.0] - 2026-08-14

### Added

- **Per-event timestamps in live logs** — the live-view writer stamps every complete JSON event
  line with an ISO 8601 `at` field (receipt time); malformed lines pass through unchanged and the
  `live.run_finished` marker keeps its single `at`. `scripts/tail-progress.mjs` reads logs with or
  without `at` and prints a `… +Ns` annotation when the gap between events exceeds 30s, so long
  shell commands no longer render as unexplained dead air.
- **Partial-line carry cap** — both the live-log writer and the tail viewer bound their line
  buffers at 1 MiB (`MAX_CARRY_BYTES`); overflow is flushed as a raw unstamped line, so a producer
  that never emits newlines cannot grow memory unboundedly and no bytes are lost.
- **Targeted-testing rules in `exec-self-testing`** — Codex prompts now instruct: run only the
  current task's test file while iterating, run the full suite at most once as the final step, stop
  and report verbatim on sandbox/environment failures (EMFILE, EPERM, OOM) instead of re-running,
  and name any test command expected to exceed two minutes. `tests/flowDocs.test.ts` gates all four
  rules.
- **AGENTS.md sandbox note** — documents the Codex-sandbox vitest EPERM on
  `node_modules/.vite-temp` and the `npx vitest run <file> --configLoader runner` workaround.
- New export `captureStatusPorcelainZ` and optional `statusPorcelainZ` on
  `CaptureOptions`/`AttributeOptions` for sharing one post-run status read.

### Changed

- **Post-run diff + attribution run concurrently** and share a single
  `git status --porcelain -z` invocation (4 → 3 git spawns per attempt); public result shapes and
  never-throw semantics unchanged. Non-`-z` status output is reconstructed with git-compatible
  C-style path quoting (quotes, backslashes, control chars, non-ASCII octal escapes), keeping the
  payload byte-faithful for renames and exotic filenames.
- **`errorCount` no longer counts the hook-trust startup notice** — `isBenignCliNotice` matches the
  canonical `--dangerously-bypass-hook-trust` notice exactly (± backticks/trailing period) and
  fail-closed: any other message referencing the flag still counts as a real error. The
  `BENIGN_CLI_NOTICE_PATTERNS` export was replaced by `BENIGN_HOOK_TRUST_NOTICE`.

### Notes

- Motivated by a measured investigation (479 runs, 45.4h): execution slowness came from repeated
  full-suite test runs inside Codex turns (31% of wall time non-generation) and global
  `model_reasoning_effort = "high"`, not from server spawn/queue/resume overhead. Full report in
  `.codex-flow/reports/20260814-093855/analysis.md`.

## [0.19.1] - 2026-08-07

### Added

- **Context-grounded skill authoring** — when local skills cannot serve a plan facet (missing OR
  loaded-but-insufficient), the flow now authors a skill grounded in the run's own context instead
  of a generic one:
  - **Sufficiency verdict** — a facet whose loaded skills do not cover its requirements records a
    machine-checkable `INSUFFICIENT → AUTHOR (gap: R<n>.<m>, …)` (or `→ VET`) qualifier in PLAN.md's
    Skills plan (skill-selection Step 5 sufficiency check; command Phases 2 and 3) and escalates to
    Step 7 for the missing part only.
  - **`scripts/skill-brief.mjs`** — generates `.codex-flow/SKILL-BRIEF-<facet>.md` from
    REQUIREMENTS.md + PLAN.md (`--facet`/`--rids` carry the verdict's gap R-IDs; 2000-token budget
    with whole-item drops and a restorable pointer; degraded inputs warn at exit 0; symlink-rejecting
    atomic writes).
  - **Brief-first Step 7d with a fixed order** — brief → author (staged in
    `<library>/quarantine/authored/`, never indexed) → lint → one batched AskUserQuestion approval →
    promote → index/load. Rejected skills stay quarantined and are never loaded.
  - **`scripts/skill-lint.mjs`** — mechanical gate for authored skills: frontmatter (single-line
    literal description, no YAML block scalars), a `Serves: <facet> — R<n>.<m>` line, required
    sections (Core method / Failure modes / Reviewer checklist / Provenance), per-section provenance
    labels (`Source:` or `derived, unverified`), fence-aware parsing (``` and ~~~).
  - Both scripts ship in `files[]`; `tests/flowDocs.test.ts` guards the new contract wording with
    section-scoped full-literal assertions. Suite grows 884 → 939 tests.

## [0.19.0] - 2026-08-07

### Added

- **Budgeted context-persistence slices** — `scripts/context-slice.mjs` derives per-task
  `.codex-flow/CONTEXT-T<n>.md` (≤ 4000 tokens) and resume `.codex-flow/RESUME.md` (≤ 8000 tokens)
  views from PLAN.md and TASKS.md, preserves mandatory task text and statuses, and drops only whole
  lower-priority items with restorable PLAN.md pointers.
- **Git-anchored decision read-back** — Decision-log blocks record `Anchor:` SHAs, and derived
  slices stamp them `[fresh]` or `[verify]`; missing or invalid anchors and git failures degrade to
  `[verify]` while full PLAN.md remains authoritative and standalone installs retain a direct-read
  fallback.
- **Durable requirements with criterion-level coverage** — `.codex-flow/REQUIREMENTS.md` records
  confirmed criteria verbatim as atomic `R<n>.<m>` IDs; append-only confirmed Deltas preserve
  mid-run changes and reset affected downstream approvals. `scripts/requirements-coverage.mjs`
  rejects uncited and unknown IDs at the Phase 3 gate, and final review reports every ID met/not-met
  with evidence.
- **Authoritative 10-key run state** — `.codex-flow/STATE.md` replaces file-existence inference with
  the current phase, three approval records, immutable `runBaselineRef` / known-red / dirty-baseline
  values, checkpoint choice, execution mode, and a separate `resumeHead`.
- **Session lineage and status-aware recovery** — TASKS.md gains session metadata plus an append-only
  transition log; resume reconciles orphaned in-progress work. Wave scheduling uses done tasks to
  satisfy dependencies, waits on in-progress tasks, and blocks dependents of failed or unknown
  states.
- **Single-writer parallel coordination** — one coordinator owns every `.codex-flow/*` write while
  workers return structured handoffs covering touched files, checks, findings, proposed decision-log
  data, and session IDs.
- **Stronger context slices** — task slices always include a stamped contracts index, compact the
  known-red baseline, and rank decision blocks by explicit `Applies to:` scope before recency; the
  execution prompt carries the run-position recitation header.

## [0.18.0] - 2026-08-04

### Added

- **New `exec-visualization` skill** — routes chart/graph tasks to [microsoft/flint-chart](https://github.com/microsoft/flint-chart) (rendering PNG/SVG) via a capability ladder (flint-chart MCP tools → `npx flint-chart` CLI → Python matplotlib as a last resort), instead of ad-hoc Python plotting. The token is wired into Phase 4 of the command (with a byte-identical `.claude` mirror) so chart-producing tasks load it, and the README documents optional `flint-chart-mcp` setup for the Codex CLI and Claude.

## [0.17.0] - 2026-07-31

### Added

- **New `context-discipline` skill** — enforces orchestrator no-raw-read thresholds, phase-boundary compaction, and tiered additive-only `AGENTS.md` generation.
- **Handoff-grade Decision log schema** — replaces one-line entries with four required fields: Decision, Why, Constraint for later tasks, and Contracts touched.
- **Command integration across Phases 2, 4, and 5** — loads context discipline throughout planning, execution, and review, including explicit sequential-vs-parallel boundary rules.
- **`tests/flowDocs.test.ts` structure guard** — validates the command and skill documentation contracts and keeps the command mirror byte-identical.

## [0.16.0] - 2026-07-30

### Added

- **15 new domain skills** shipped with the plugin (`skills/`): accounting-bookkeeping, financial-audit, personal-finance, sme-operations, hr-recruiting, sales-pipeline-crm, customer-support-ops, ecommerce-operations, legal-contract-basics, training-curriculum-design, real-estate-analysis, ux-research-wireframing, manufacturing-ops-planning, warehouse-operations, json-data-wrangling. Measured by ablation on the new 500-case scope suite: removing them drops the pass rate from 500/500 to 274/500 — these domains previously had zero retrievable coverage.
- **500-case scope suite** (`tests/fixtures/scenarios-500.json`, `npm run skills:eval:scope`) extending the original 100 cases with 16 groups across SME ops, personal finance, accounting, financial audit, project management, UI/UX, HR, sales/CRM, customer support, e-commerce, legal, education, real estate, logistics, manufacturing, and cross-domain requests (~30% Vietnamese). Ambiguous-request cases encode the Step-2 contract (`terms: []` — classifier routes to ask-back instead of deriving terms).
- **Frozen independent holdout** (`tests/fixtures/scenarios-holdout.json`, 100 cases authored by a separate agent that never saw the tuned suite; assertions are frozen). First measurement: 100/100, Hit@1 99.0%, MRR 0.995.
- **Honest eval metrics** (dual-review IMP-3/IMP-4): reports now include MRR, per-scope recall, expectNone false-positive rate, and the sha256 of the exact index measured; `build-skills-index` warns about duplicate skill names across roots.
- Step-2 facet table in `skills/skill-selection/SKILL.md` gains 9 facets (accounting/audit, personal finance, SME/ops, sales/support/CRM, HR, legal/compliance, education, real estate, logistics) so the runtime classifier has vocabulary for non-engineering requests.
- **`.github/workflows/publish.yml`** — pushing a `v*` tag now publishes to npm automatically. Since 0.15.1 pins `.mcp.json` to a published version, a tagged release that was never published would point every plugin install at a package that does not exist, so publishing can no longer be a manual step someone forgets. The job re-checks that the tag matches `package.json`, runs the release-consistency gate against the tag tree, builds and tests, then publishes with `--provenance`. Auth is OIDC trusted publishing — no token is stored in the repo or in CI; a `NPM_TOKEN` secret is read only as a fallback if trusted publishing is not configured.

### Fixed

- **Six real matcher defects in `scripts/skill-match.mjs`**, each with a unit test — three found while building the suite, three found by an independent Codex review round: (1) `depluralize` over-stripped e-final plurals (`cycles→cycl` never met `cycle`; now sibilant-only 'es' stripping incl. `-oes`); (2) the same generic word in a skill NAME earned stacked credit across several query terms, letting ten `*-review` code skills bury `hr-recruiting` — word credit is now deduplicated per (field, word) and order-independent; (3) the ≥2-hit relevance floor blocked single hits on ultra-diagnostic terms (`Incoterms`, `AOV`, `NPS`) — a single description hit now qualifies when the matched word is rare both by IDF (≥2.2) and by document frequency (≤0.2% of the index, so index growth alone cannot relax the floor); (4) duplicate index names could be selected twice (`xlsx, xlsx`) — selection keeps the strongest entry per name; (5) a semantically wrong precision-guard rule was removed; (6) `financial-audit`'s control-deviation rule was softened to standard practice.
- Suite results after the dual-review fixes: 500-case suite 500/500 with Hit@1 91.6%, MRR 0.946, expectNone FP 0/26; original 100-case suite 100/100 (regression-clean); full test suite 717 passing. Full reconciled evaluation: `.codex-flow/skill-selection-test/EVALUATION-FINAL.md` (local, untracked).

## [0.15.1] - 2026-07-27

### Changed

- **The plugin now launches the published npm tarball instead of building at install time.** 0.15.0 fixed the `-32000` failure by having `.mcp.json` install deps and run `tsc` on first start, which works but makes the very first connection depend on npm and the network at exactly the moment the client is waiting for a handshake. `.mcp.json` now runs `npx -y @anhnguyen0905/codex-mcp@0.15.1`, and the npm tarball ships a prebuilt `dist/` (already covered by `files[]`), so there is no clone-time build at all. The version is pinned rather than `@latest` so a plugin release cannot drift onto a server build it was never tested against.
- **`scripts/check-release-consistency.mjs` now also checks the `.mcp.json` npx pin**, since pinning adds one more place a release can forget to bump. `extractMcpPinnedVersion` returns `undefined` for a non-pinned launcher, so switching back to a local-build config does not fail the gate.
- README's standalone-install section leads with npm again, and the `-32000` troubleshooting note reflects the npx launcher.

## [0.15.0] - 2026-07-27

### Added

- **Constituent-word fallback in the matcher** — a multi-word term whose exact phrase misses now falls back to its component words at `PARTIAL_FACTOR` (0.6) instead of contributing zero. This was the defect behind most of the scope-suite misses: `"competitor benchmark"` scored exactly 0.0 against `benchmark-methodology`, so the expected skill was absent from the shortlist rather than mis-ranked. A one-axis sweep (`scripts/tune-sweep.mjs`, verdict recorded in `tests/fixtures/SWEEP.md`) confirms 0.6 sits inside a plateau, not on a spike; grid cells scoring 100/100 were deliberately not adopted because they win by rescuing a coverage gap at the cost of roughly one extra noisy skill per request.
- **`formatShortlist` with a hard 4000-char ceiling** plus trust/provenance metadata, and `matchedTerms` on results — `selectSkills` is now explicitly a *shortlist producer*, not a final answer. Precision is restored downstream by a mechanical rank-1 guard and a prompt-level prune.
- **Negative-rule guard in the eval harness** — `parseNegatives`/`checkNegatives` and a `--negatives` flag; `checkNegatives` throws when a rule names a skill absent from the catalog, so a typo cannot leave the guard green-but-decorative.
- **precision@1 and average-selection-size reporting** next to the pass rate, so a recall win paid for with noise can no longer hide behind a single number.
- **Tracked eval fixtures** — the 100-case and multifacet suites, `NEGATIVES.md` and `SWEEP.md` are now in git, making the measured numbers reproducible from a clean checkout.

Measured on a ~656-entry index: scope suite 87/100 → **99/100**, precision@1 78/99 → **84/99**, average selection size 2.59 → 8.01, 32-scenario suite 32/32 (unchanged), multifacet 4/4 (unchanged), full test suite 671 → 700 tests.

### Removed

- **The IDF-aware relevance-floor clause** (`RARE_DESC_IDF`, `rareDescHit`) — a two-factor ablation run independently twice with matching results showed it contributed zero marginal passes over the phrase fallback alone, at +0.56 average selection size, including across the 17 scenarios whose term lists are entirely single-word (its only principled justification). Dropped as dominated.

### Fixed

- **Plugin install failed with `Failed to reconnect to Plugin:codex-flow:codex: -32000`** — the bundled `.mcp.json` launched `node dist/index.js`, but the plugin ships as a git clone and `dist/` is gitignored, so a freshly installed plugin had no build (and no `node_modules`) and the server exited immediately on every start. The launcher is now `sh -c` based: it `cd`s to `${CLAUDE_PLUGIN_ROOT}` (falling back to `$PWD` for dev sessions in this repo, where the token is not substituted), installs deps and builds if `dist/index.js` is missing, then execs the server. First start after install is slower; subsequent starts are unchanged. Verified by a stdio `initialize` handshake in both modes.

### Changed

- **`skills/skill-selection/SKILL.md`** now documents the shortlist → prune → `LOAD`/`VET`/`AUTHOR` contract, with the explicit rule that *a reranker cannot rescue an absent candidate* — an expected skill missing from the shortlist is a recall/coverage problem for Step 7 acquire-or-author, not a ranking problem.
- README now leads the standalone install with the `github:` source and marks the npm registry as lagging behind GitHub releases, and documents the `-32000` symptom with a one-shot patch for installs older than 0.15.0.

### Known gaps

Tracked in `.codex-flow/IMPROVEMENTS.md`: the eval suites are not yet CI-gated (the harness reads a machine-specific index and the scope suite exits non-zero on the accepted A09 miss); `buildIndex` still overwrites the index with a partial scan when a skill root is unreadable; 11 duplicate skill names remain in the index, deflating IDF and wasting shortlist budget.

## [0.14.0] - 2026-07-28

### Added

- **Plugin skills in the index** — `build-skills-index` now also scans `~/.claude/plugins/cache/<marketplace>/<plugin>/[<version>/]skills` (newest version per plugin, `compareVersionDirs`) and treats those skills as trusted. On a real machine the index went 362 → 640 entries (43 → 294 trusted), making installed marketing/research/data skills selectable instead of invisible.
- **IDF term weighting** — `buildDocFrequency` + `idfWeight` score a term by rarity across the index (clamped to 0.5–3×), so a diagnostic term ("incrementality", "gacha") outweighs one half the index uses ("data", "analysis"). Measured effect: reorders 16 of 100 scenario selections, flips no verdict — ranking was not the binding constraint, library coverage is. Kept because the shortlist order is what a future LLM reranker sees.
- **Per-facet selection** — `selectSkills(entries, [{ name, terms }])` gives each role facet its own share of the token budget, with a remainder pass so the budget stays a ceiling. This closes a doc↔code mismatch: `skill-selection` Step 2 has always required per-facet selection, but the matcher only accepted one flat term list, letting a strong facet crowd a weak one out (the eval's documented S31 limitation). Demonstrable at a tight budget: at 1200–1800 tokens a flat list drops `dashboard-builder` entirely from "build the dashboard and write the launch post"; per-facet keeps it. Flat term lists still work unchanged.
- **Morphological folding in the matcher** — `skill-match.stem()` folds a small, deliberately conservative set of variants (management/manager, analytics/analysis, visualization/visualisation, plurals) so "project management" reaches `project-manager`.

- **Fifteen Step-7d authored skills** — all written through the Step 7 acquire-or-author path and shipped under `skills/`: `performance-marketing`, `unit-economics`, `media-planning`, `warehouse-modeling`, `event-taxonomy`, `marketing-attribution`, `causal-inference`, `survey-design`, `aso`, `localization-copy`, `okr-planning`, `creative-brief`, `influencer-strategy`, `sop-authoring`, `data-quality-checks`. The 100-request scope run went 23/100 → **87/100**; every numeric threshold is labelled *derived, unverified*.
- **First three Step-7d authored skills** — `performance-marketing`, `unit-economics`, and `media-planning` were written into the skill library through the Step 7 acquire-or-author path (gap analysis → no adoptable skill found → author with provenance labels → reindex). The 100-request scope run went 62/100 → **70/100**; the 32-scenario eval stayed 32/32. They now ship with the plugin under `skills/`, so every install gets them indexed as trusted plugin skills.

### Changed

- **`skill-selection` Step 7 is now acquire-or-author** — a domain facet may no longer end with zero skills. The ladder is: re-index and re-grep (including the plugin skill dirs) → vet an unvetted on-disk candidate → search for an existing skill (bounded to 2 rounds) → author the missing `SKILL.md` **before execution**, with provenance and "derived, unverified" labels, then rebuild the index and load it. Step 5 must report skills blocked by the vet gate instead of falling through to the gap path; Step 2's facet table grew from 5 to 11 facets (data engineering, visualization/reporting, growth/paid media, research, finance/bizops, localization) with real vocabulary; Step 4 anchors short terms and warns that a name match is not a domain match.
- **`/codex-flow` Phase 2** — 0 index matches is a valid *matching* result but never a *selection* result; a domain task must not reach Phase 4 with an empty `Skills:` field.

## [0.13.0] - 2026-07-24

### Added

- **Bounded server-side auto-resume** — `retryPolicy` + `runRecovery` resume the same Codex session after transient turn failures (at most 2 resumes), timeouts (at most 1), or `partial` results caused by a missing completion marker or parse errors (at most 1, reported as `no-completion-marker`), with a 2 s then 8 s backoff (8 s reused thereafter). Set `CODEX_MCP_AUTO_RESUME=0` to opt out.
- **Recovery metadata** — final run payloads report `attempts` and ordered `resumeReasons`; `codex_batch` exposes the same fields on every per-task result.
- **Reasoning-effort control** — `codex_execute`, `codex_continue`, `codex_review`, and each `codex_batch` task accept `reasoningEffort: minimal | low | medium | high | xhigh`, mapped to `-c model_reasoning_effort="<value>"`.

### Changed

- Default execution timeout increased from 30 to 60 minutes; `timeoutMs` remains capped at 2 hours.
- codex-flow now defaults to parallel execution when `task-waves` reports width > 1, proceeds automatically at widths ≤3, and asks before running a wave wider than 3.
- Phase 3 emphasizes file-disjoint task slicing, and Phase 4 maps `reasoningEffort` to task complexity (`low` for mechanical work, the CLI default for standard work, and `high` for architectural, cross-cutting, or subtle logic).

## [0.12.0] - 2026-07-24

### Added

- **Per-session report bundles** — every codex-flow run writes `.codex-flow/reports/<YYYYMMDD-HHMMSS>/` with `planning.md`, `allocation.md`, `tasks.md`, `cost.md`, and `SUMMARY.md`, each carrying explicit PIC attribution (`claude`, `codex`, or `both`).
- **Self-contained `scripts/session-cost.mjs`** — aggregates Codex cost from `metrics.jsonl`; requires `--since`, supports `--until`, `--cwd`, `--log`, and `--json`, and uses `CODEX_MCP_PRICING` when configured.
- **`session-report` plugin skill and command hooks** — centralizes report templates and writes them at the Phase 0/2/3/5 gates.

## [0.11.0] - 2026-07-23

### Added

- **Dual review in Phase 5** — every task and the final pass require a Codex-side review via `codex_review`; the per-task focus block is scoped to the task's `Files:`, and the final pass supplies `baselineRef`.
- **Evidence-based comparison protocol** — classifies findings as agreed, unique-to-one, or conflicting, with user arbitration only for unverifiable CRITICAL/HIGH findings or mutually exclusive fixes.
- **Non-blocking improvements ledger** — appends `IMP-n` suggestions to `.codex-flow/IMPROVEMENTS.md`; the user decision gate turns approved improvements into new `TASKS.md` tasks.
- **`review-dual` skill** — defines the dual-review workflow.
- **Skills plan in Phase 2** — PLAN.md now records both *Skills to use* (selected from the index) and *Skills to create* (gaps, with the needed rules inline so Phase 4 can embed them; before-execution skills get a real `SKILL.md` + index rebuild before Phase 4, retro-timed ones stay inline). Explicit `—` empty states keep the two-part structure present.

## [0.10.0] - 2026-07-21

Production-hardening release: every P0/P1/P2 finding from the 2026-07-21 full pipeline review is closed (see `docs/full-pipeline-review-2026-07-21.md` and `docs/execution-plan-2026-07-21.md`).

### Added

- **Run status model** — payloads carry `schemaVersion: 1` and `status: success | partial | failed | aborted`; a run missing its completion marker (e.g. empty stdout with exit 0) is `partial`, never a clean success. `parseErrors`, `unknownEvents`, `sawCompletion`, `warnings`, `turnCount` are surfaced.
- **Structured tool contract** — every tool emits `structuredContent` with a Zod `outputSchema`; the text block stays byte-identical for backward compatibility.
- **Run attribution** — before/after workspace snapshots classify `changedByRun` vs `preExisting` by content hash, include bounded untracked-file content, survive timeout/abort, and thread a `runId` through payloads, metrics, and notes.
- **Baseline-range review** — `codex_review` accepts `baselineRef` and reviews `baselineRef..HEAD` plus uncommitted changes, so checkpoint commits are never invisible to a final review.
- **Cross-process workspace lease** — per-cwd locking now also holds a lease file under `~/.codex-mcp/locks` (outside cloud-synced workspaces) with stale dead-pid reclaim.
- **Skill supply-chain controls** — remote skill clones land in an unindexed quarantine; vetting pins commit + content sha256 in `vetted.json` and any drift flips the entry back to unvetted; symlinked `SKILL.md` files are rejected.
- **Telemetry** — metrics gain `model`, `taskId`, `queueMs`, `timeToFirstProgressMs`, `errorCount`/`errorKind`, a per-model breakdown, and opt-in cost estimation that never prices unknown models.
- **Protocol canary** — a real codex-cli 0.144.6 JSONL fixture pins the protocol; CLI upgrades that change event shapes fail tests loudly with refresh instructions (`scripts/refresh-protocol-fixtures.mjs`).
- **Release/packaging gates** — CI enforces version consistency across package/lock/server/plugin/changelog/tag, byte-equality of the `/codex-flow` command mirror, coverage thresholds, and a packed-tarball install smoke that asserts the installed server answers JSON-RPC initialize.
- **Benchmark harness** — SLO-asserted local benchmarks (`scripts/bench-*.mjs`, `docs/benchmarks.md`) covering 50MB streams, 50-task batches, cancellation latency, and metrics/session scale.
- **Live-log completion marker** — the live view appends a `live.run_finished` marker on settle and `tail-progress` exits automatically when it appears.
- **`fb-video-crawler` promoted** to a tracked deliverable with its own CI (Python 3.11–3.13): label-aware metric parsing (never positional), og:url video-ID cross-check, honest partial-comment results (`has_more`/`truncated`/`stop_reason`), HTML void-element parsing, CSV formula-injection escaping, atomic writes, and a hardened HTTP boundary (5MB cap, validated HTTPS-only redirects, accurate final retry errors).

### Changed

- Prompts are delivered to the Codex CLI via stdin (`-- -`) with a 5MB cap instead of riding argv.
- The JSONL stream is parsed incrementally and losslessly; raw stdout retention drops to a 1MB rotating tail.
- Progress notifications coalesce to at most one per 250ms with an immediate final flush.
- `codex_batch` with `failFast: false` reports per-task status plus a summary instead of flagging the whole tool as an error; batch progress is attributed per task.
- Session listing filters by canonical cwd and orders by real last activity; `codex_health` distinguishes probe timeout/failure from a clean not-logged-in.
- Descendant processes are killed before locks release; the child's real exit code is preserved.
- Notes writes are atomic and refuse symlinked note files; output caps truncate at exact byte boundaries.
- `.mcp.json` runs the local build instead of `@latest`.

## [0.9.0] - 2026-07-16

### Added

- **`design-fundamentals` skill** — design skills set for non-code (design) tasks, imported from [bergside/typeui](https://github.com/bergside/typeui) (MIT). One SKILL.md plus five reference modules: `ui-principles.md` (visual hierarchy, layout rhythm, color, depth), `spacing-principles.md` (4-point grid, proximity, spacing tiers), `ux-principles.md` (30 UX laws, control state contracts, touch targets), `typography-principles.md` (type scales, readability, responsive type), and `accessibility.md` (WCAG 2.1/2.2). Intended as a *reference* to consult on design requests — not the sole authority; agents should still apply their own design judgment and research.

## [0.8.0] - 2026-07-16

### Added

- **`codex_batch` tool** (PR #3) — fan out up to 50 tasks across distinct cwds (typically git worktrees) in parallel, with a bounded worker pool (`maxConcurrency`, default 10), optional `failFast` cancellation, per-cwd locks, and duplicate-cwd rejection at input validation. Returns one `codex_execute`-shaped result per task in input order. Internals: the run pipeline was refactored into a shared `runOnce` so batch reuses the exact same execution/diff/metrics path as the single-task tools.
- **Opt-in `writeNotes` option** (PR #5) on `codex_execute` / `codex_continue` / `codex_review` — persists a markdown summary of the run (task, agent message, files touched, commands run) to `<cwd>/.codex-flow/notes/<sessionId>.md`. `continue` appends a continuation block. Symlink-refusal on both dirs, `0o600` file mode, session-id allowlist, best-effort (a failed write never fails the run). Payload gains `notesPath`.
- **Passive metrics log + `codex_metrics` tool** (PR #6) — every completed run appends one JSONL line (tool, cwd, sessionId, duration, token usage, exit/timeout/abort/truncation flags) to `~/.codex-mcp/metrics.jsonl` (override via `CODEX_MCP_METRICS_LOG`; 10MB rotation, `0o600`). `codex_metrics` aggregates with `since`/`until`/`tool`/`cwd`/`sessionId` filters; `estCostUsd` is computed only when `CODEX_MCP_PRICING` (JSON per-1M-token rates) is set. Batch tasks are attributed as `tool: "codex_batch"`.

### Fixed (integration hardening during merge)

- **Batch respects the server-wide concurrency cap**: each batch task passes through the global `CODEX_MCP_MAX_CONCURRENT` gate, and the batch worker pool is clamped to that cap — the global gate is fail-fast, so an unclamped pool (up to 32) over the global default (16) would have made excess tasks error out instead of queue.
- **Batch tasks no longer share the caller's MCP `progressToken`**: N parallel notifiers racing one token produced a non-monotonic, unattributable progress stream; batch now runs without a per-task progress sink (live logs remain available per workspace).
- **Metrics record `truncated`**: `appendMetric` now persists the output-truncation flag that `MetricEntry` already modeled, so `codex_metrics` can surface truncation frequency.

## [0.7.0] - 2026-07-14

### Added

- **Six new language execution skills** so Phase 4 embeds real idioms for more stacks instead of falling back to the language-agnostic standards block: `codex-flow:exec-rust`, `exec-csharp` (C#/.NET), `exec-php`, `exec-ruby`, `exec-swift`, and `exec-cpp` (C/C++). Joins the existing TypeScript/Python/Go/JVM set.
- **`codex-flow:exec-deliverable`** — a non-code execution skill (deliverable standards + a verification block that mirrors self-testing) for tasks that produce content rather than code (data analysis, marketing copy, docs, research, plans). Phase 4 now loads it *instead of* `exec-coding-standards` + `exec-self-testing` + the language skill for non-code tasks, so a multi-domain backlog gets the right execution bar per task.
- **`codex-flow:preflight`** — Phase 0 (health gate, resume check, workspace baseline) extracted into its own skill carrying the detailed checklist, matching every other phase having a named skill.

### Changed

- **Architecture planning is now contract-first**: `codex-flow:plan-architecture` gains a step to pin down the seams between components (signatures, data shapes, API/event contracts) and a **component → files map** *before* slicing, plus PLAN.md sections for both. Fixed contracts make tasks independent and reviews deterministic; the file map is what the backlog slices along (and what lets `task-waves` parallelize). Added "design for the diff" (localized, sub-64 KB changes) and "design for independence" principles.
- **Backlog sizing now targets execution *and* review**: `codex-flow:plan-backlog` reframes sizing around one reviewable concern per task and a bounded blast radius (≤ ~5 files / a few hundred lines, under the 64 KB diff cap), requires each task to be self-sufficient for a fresh Codex session, puts contracts/foundations first, requires acceptance to name the exact verification command, and keeps independent tasks file-disjoint for parallel waves. Phase 2/3 of `/codex-flow` updated to match.

### Changed

- **Process synchronized end to end** so the new contract-first / non-code concepts flow through every phase: `review-conformance` now checks the implementation against PLAN.md's **Contracts** (a silently changed signature/shape is a finding) and gains a non-code deliverable pass (acceptance + format/voice + spot-checked reproducibility); `review-security` adds a trigger for deliverables that could embed secrets/PII/internal data; `interview-elicitation` requires atomic, independently testable acceptance criteria (they become the per-task `Acceptance` lines); `plan-research-first` records new dependencies under Risk & blast radius and reused patterns under Contracts/Component→files; `parallel-execution` notes that wave quality depends on accurate `Files:` metadata and fixed contracts.

### Fixed

- **Skill/command drift**: `codex-flow:plan-architecture` PLAN.md template now includes all the sections the flow executes against (adds Risk & blast radius, Skills used, Known-red baseline, Decision log — previously it taught a 5-section template the reviewer would find incomplete). `codex-flow:plan-backlog` task format now includes the `Skills:` field that Phase 3 and `task-waves.mjs` rely on, plus the "map skills once here" slicing rule.
- `/codex-flow` command drift: description/intro now say **6 phases (0–5)** instead of 5 (Phase 0 preflight was uncounted); the Phase 5 retro now references `skill-selection` **Step 8** (Register back), not Step 7 (Gap fallback).
- `server.json` version synced to the package version (was stale at 0.3.2).

## [0.6.1] - 2026-07-14

### Changed

- Parallel execution caps at **10 concurrent subagents** per wave by default (`computeWaves` `maxConcurrency`, `task-waves.mjs --max <n>`): a wider ready set is split across consecutive ≤10 waves instead of spawning everything at once.

## [0.6.0] - 2026-07-14

### Added

- **Parallel execution mode** for large backlogs: run independent tasks concurrently, each in its own git worktree (codex-mcp serializes per `cwd` but parallelizes across `cwd`s), driven by a Claude subagent, then merged + integration-reviewed per wave.
  - `scripts/task-waves.mjs` (`npm run waves`) computes execution **waves** from `TASKS.md` — a wave batches tasks whose dependencies are satisfied and whose `Files:` sets are disjoint; tasks with no declared files run alone. Throws on dependency cycles / unknown deps.
  - `codex-flow:parallel-execution` skill — the playbook (when to use, worktree-per-task, per-wave merge + mandatory integration review, quota cap, failure handling).
  - Phase 4 gains an opt-in parallel branch: compute waves, and if width > 1 and the user agrees, fan out; otherwise stay sequential. Off by default.

### Notes

- Execution speed levers already in the flow: model-by-complexity (0.5.0), small well-specified tasks, lean prompts with distilled skill blocks, same-domain session reuse, and fewer review round-trips.

## [0.5.0] - 2026-07-14

### Added

- **Resume/idempotency**: Phase 0 detects an existing `.codex-flow/PLAN.md` + `TASKS.md` and offers to resume from the first not-done task (skipping interview/plan/backlog) or restart (archiving the old files) — instead of silently clobbering an interrupted run.
- **Per-task `Skills:` field** in `TASKS.md`: the skill→task mapping is decided once at slicing time (Phase 3) from the Phase 2 selection, so Phase 4 embeds a consistent, user-reviewable set per task instead of re-guessing each run.
- **Model selection by complexity**: Phase 4 picks the Codex `model` per task — a stronger model for architectural/cross-cutting/subtle tasks, a faster/cheaper one for small mechanical tasks — recorded in the Decision log.
- **Sandbox-mode guidance**: `workspace-write` by default, `read-only` for investigation-only tasks, `danger-full-access` only when network/global install is genuinely needed (with user notice).

### Changed

- Phase 0 ensures `.codex-flow/live/` is in the project `.gitignore` so raw live-progress JSONL logs never land in checkpoint or final commits; warns when the cwd is not a git repo.
- Phase 1 interview depth now scales to task complexity (short summary + quick confirm for small changes; full elicitation for large/ambiguous ones).
- Phase 5 offers to squash the `wip(codex-flow)` checkpoint commits into one clean commit at the end, and requires re-running acceptance checks after any hand-fix.

## [0.4.2] - 2026-07-14

### Changed

- `/codex-flow` Phase 5 now re-reads `.codex-flow/PLAN.md` and the task's `TASKS.md` entry before reviewing, treating the on-disk files as the source of truth for acceptance criteria, architecture, `Files:` scope, and the known-red baseline — so reviews stay correct even when session memory has been compacted across a long backlog.

## [0.4.1] - 2026-07-13

### Fixed

- CI: the skill-selection scripts no longer carry a `#!/usr/bin/env node` shebang, which Vite failed to strip on Windows when the test suite imports them (`SyntaxError: Invalid or unexpected token`). They still run via `node scripts/<file>.mjs`.
- CI: `tests/skillEval.test.ts` no longer reads the built index at collection time, so the real-index suite is cleanly skipped (not errored) on machines without `~/.claude/skill-library/INDEX.md`.

## [0.4.0] - 2026-07-13

### Added

- **Skill selection from a local index**: new `codex-flow:skill-selection` skill + `scripts/build-skills-index.mjs` (scans skill dirs for `SKILL.md` frontmatter → grep-friendly `~/.claude/skill-library/INDEX.md`). Phase 2 classifies the request's role facets (engineering, data, marketing, product, design…), evaluates already-loaded skills, then selects at most 3 domain skills from the index and embeds distilled rule blocks into Codex prompts — re-selected per task — instead of blind-loading collections; a retro step registers newly learned skills back into the index.
- **Local-first foundation collection**: `scripts/sync-awesome-skills.mjs --clone` shallow-clones every GitHub repo in [awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) into `~/claude-skill-library/remote/` (re-run to pull updates); the index builder scans them for real `SKILL.md` frontmatter, giving far richer matching than the list's one-liners. Non-GitHub entries stay as URL pointers via `REMOTE.md` (locally scanned skills shadow pointers by name). Skills on disk cost zero context until selected. Third-party skills (under `remote/`) are security-vetted once before first use and recorded in `VETTED.md` — never embedded unvetted into Codex prompts.
- **Codex session hygiene**: reuse a Codex session only while consecutive tasks share a domain; domain shifts start a fresh `codex_execute` with the new task's skill blocks.
- **Context-budget skill selection (no fixed count)**: selection loads every relevant skill that fits ~3% of the context window (≈6000 tokens; `DEFAULT_TOKEN_BUDGET`), highest-relevance first, sizing each skill by its distilled ≤30-line block (capped at `DISTILL_TOKENS_CAP` ≈600) rather than the whole SKILL.md — so one large skill can't blow the budget or crowd out more relevant ones. Replaces the earlier hard cap of 3 skills.
- **Skill-selection scope eval**: deterministic retrieval core (`scripts/skill-match.mjs`: score → rank → relevance floor → token-budget fit, with specificity-weighted phrase matching), a 32-scenario fixture spanning engineering/data/marketing/product/design/security/bio/ML/docs/testing/game/mobile + multi-facet + uncovered-domain cases, and `scripts/skill-eval.mjs` (run via `npm run skills:eval`) that writes `docs/skill-selection-eval-report.md`. Latest: 32/32. Building the eval surfaced and fixed three issues — hyphen/phrase normalization (`test-driven` vs `test driven`), generic single-word false positives leaking into uncovered domains, and large-skill budget starvation (fixed via the distilled-block cost model).
- Phase 0 workspace baseline: git cleanliness check + baseline ref, and a pre-flight test run recorded as the **known-red baseline** so review only counts new failures against Codex.
- PLAN.md gains **Risk & blast radius**, **Skills used**, **Known-red baseline**, and an append-only **Decision log** updated after every passed task.
- Plan-drift loopback: review findings caused by a wrong plan return to Phase 2 (amend + re-slice) instead of burning `codex_continue` rounds.
- Opt-in per-task checkpoint commits (asked once at backlog approval) and a final end-to-end verification of the changed behavior on top of the full test suite.

## [0.3.0] - 2026-07-10

### Added

- Claude Code plugin packaging: install the `/codex-flow` command + `codex` MCP server with `/plugin marketplace add anhnguyen0905/codex-mcp` → `/plugin install codex-flow@codex-mcp`.
- `/codex-flow` upgraded to 5 phases: interview → plan/architecture → backlog (TASKS.md) → per-task Codex execution → per-task + final review, with a Phase 0 preflight login gate.
- 15 per-phase skill packs: interview (elicitation, ask-back), planning (research-first, architecture, backlog), execution standards embedded into Codex prompts (coding standards, self-testing, TypeScript/Python/Go/JVM idioms), review (conformance, quality, security, feedback process).
- `npm run doctor`: first-time setup check for Node, Codex CLI install + login, Claude Code CLI.
- One-command install via `npx` from npm or directly from the git URL.

## [0.2.0] - 2026-07-10

### Added

- `codex_review` tool: read-only Codex review of uncommitted workspace changes, with optional `focus`. Returns findings by severity and a `sessionId` usable with `codex_continue`.
- Cancellation support: MCP request cancellation (e.g. Esc in Claude Code) now terminates the Codex process (SIGTERM, SIGKILL after 5 s grace). Results carry an `aborted` flag.
- Per-workspace concurrency guard: a second run into the same `cwd` while one is active fails fast instead of racing on files and git state.
- `diff` in run results: `git status --porcelain` + `git diff HEAD` after the run (64 KB cap with `truncated` flag; `null` outside git repos).
- MCP progress notifications: clients that send a `progressToken` receive `notifications/progress` for each meaningful Codex event.
- GitHub Actions CI: build + tests on macOS, Windows, and Linux × Node 20/22.
- MCP registry manifest (`server.json`).

### Changed

- `package.json` metadata for npm publishing (repository, homepage, keywords).

## [0.1.0] - 2026-07-10

### Added

- Initial release: `codex_execute`, `codex_continue`, `codex_health` tools.
- Cross-platform Codex CLI spawning (macOS/Windows/Linux, `CODEX_BIN` override).
- Live-progress terminal window (macOS Terminal.app, Windows PowerShell) with JSONL event log.
- JSONL event parsing into structured results (sessionId, agentMessage, fileChanges, commands, usage, errors).
