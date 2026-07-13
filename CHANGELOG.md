# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

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
