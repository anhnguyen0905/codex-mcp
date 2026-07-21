# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

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
