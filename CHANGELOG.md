# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

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
