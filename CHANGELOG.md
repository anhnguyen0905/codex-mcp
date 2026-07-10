# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

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
