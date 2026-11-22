# MCP tools reference

This page is for people who call the codex MCP server directly or inspect the tool results it returns.

[← Back to README](../README.md)

## Tools

| Tool | Purpose |
|------|---------|
| `codex_execute` | Start a new Codex session to execute a task or plan in a workspace. |
| `codex_continue` | Resume a session with a follow-up prompt, typically review feedback. |
| `codex_review` | Review uncommitted workspace changes in a read-only sandbox. |
| `codex_batch` | Run up to 50 tasks in parallel across distinct workspaces (worktrees). |
| `codex_sessions` | List prior Codex sessions from `~/.codex/sessions/`, optionally filtered by `cwd`. |
| `codex_metrics` | Aggregate token, duration, and failure metrics from the local run log. |
| `codex_health` | Check the Codex CLI version and login status. |

`codex_execute`, `codex_continue`, and `codex_review` accept `writeNotes: true` to persist a Markdown run summary at `<cwd>/.codex-flow/notes/<sessionId>.md`.

## Result payload and live progress

Every run tool returns `sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`, and `errors`.

- `diff` contains `git status --porcelain` plus `git diff HEAD` after the run. It has a 64 KB cap and a `truncated` flag; it is `null` outside a Git repository.
- `aborted: true` means the client cancelled the run. Cancellation is forwarded to Codex as SIGTERM, then SIGKILL after 5 seconds.
- `attempts` is the total attempt count. `resumeReasons` lists automatic-resume reasons in order. Each `codex_batch` task result carries these fields too.
- `liveLog` is the path to the raw JSONL event log when live terminal viewing is enabled: `~/.codex-mcp/live/<workspace>-<hash>/<run>.jsonl`, or the corresponding path under `CODEX_MCP_LIVE_DIR`.

Clients that send an MCP `progressToken` (including Claude Code) receive `notifications/progress` for every meaningful Codex event. Set `terminal: true` or `CODEX_MCP_TERMINAL=1` to open a live-tailing window: Terminal.app on macOS, PowerShell on Windows, or the first available emulator on Linux. On macOS, the window closes about four seconds after a successful run and stays open after a failed or interrupted run. The delay defaults to 4000 ms; `0` closes immediately, and values above 60000 are clamped. Windows and Linux windows already close with their process. If no window opens, the run still succeeds; use `liveLog` or in-session progress.

## Delivery verdict (`accepted`)

Every `codex_execute`, `codex_continue`, and `codex_review` payload carries `accepted: boolean`. It is fail-closed: `status === "success"` and the acceptance evidence must hold. For execute and continue, `verifyCommand` must pass when supplied. For review, the findings block must parse with no dropped entries. `accepted` never changes `status` or `isError`; inspect it before trusting `agentMessage`.

Reviews are never auto-resumed. A timed-out or partial review is reported after one attempt.

## Review findings (`reviewFindings`)

`codex_review` asks Codex to end its message with one fenced JSON block and parses it fail-closed as `reviewFindings: { parsed, findings[], improvements[], dropped, droppedReasons, parseError? }`. Severity is one of `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`. Malformed entries are counted in `dropped` and are never coerced.

`droppedReasons: string[]` has one entry per dropped item and names the field that failed validation, such as `findings[0].line`, or the bare locator `findings[0]` when the whole entry is invalid. Therefore `dropped` always equals `droppedReasons.length`. Any `dropped > 0` makes `accepted` false for `codex_review`. The prose `agentMessage` is still returned when `parsed: false`.

## Review scope

`codex_review` accepts `scope: { files: string[]; contract?: string }`. `files` must be non-empty and contain at most 200 entries; `contract` may contain at most 4000 characters. The server appends both to the reviewer prompt, stamps each parsed finding with `inScope: boolean`, and adds `reviewFindings.outOfScopeCount` for findings outside the declared files.

Out-of-scope findings are non-blocking by default. `/codex-flow` routes them to the improvements ledger and blocks only when the reviewer verifies that they affect task acceptance.

## Acceptance command (`verifyCommand`)

`codex_execute` and `codex_continue` accept `verifyCommand` and optional `verifyTimeoutMs`. The default verification timeout is 10 minutes and the cap is 30 minutes. After the Codex run settles, the server runs the command in `cwd` while holding the workspace lock and returns `verification: { command, exitCode, timedOut, durationMs, outputTail, passed, skipped? }`.

Verification is deterministic evidence that the command ran independently of Codex's claim. It is skipped as `skipped: "run-failed"` when the run failed or was aborted, and it never changes `status` or `isError`. Termination is bounded: SIGTERM, then tree SIGKILL, then forced settle, so a hung check cannot hold the workspace lock. The command uses the server environment, and its output tail receives the same redaction pass as other returned text. Treat that output with the same trust as Codex's own output.

## Reasoning effort

`codex_execute`, `codex_continue`, `codex_review`, and each `codex_batch` task accept `reasoningEffort: minimal | low | medium | high | xhigh`. The server passes it to Codex as `-c model_reasoning_effort="<value>"`.

## Auth mode and the model guard

`codex_health` always returns `authMode: "chatgpt" | "apikey" | "unknown"`, derived from Codex CLI login output. Under ChatGPT authentication, a `model` override is refused before anything is spawned. The execute, continue, and review tools return an error; a batch task fails with `model override is not allowed under ChatGPT auth; steer with reasoningEffort`. The ChatGPT-auth backend rejects arbitrary model IDs. So pass `model` only when `authMode` is `apikey`; otherwise omit it and steer with `reasoningEffort`.

`/codex-flow` Phase 4 follows the same rule, and a flowDocs guard checks that wording.

## Secret redaction

Every returned or persisted text is redacted before it leaves the server: `agentMessage`, `stderr`, `errors`, `verification.outputTail`, live-progress notifications, the raw JSONL live log, and `writeNotes` run notes. Known OpenAI, GitHub, AWS, Slack, and Google keys, bearer tokens, JWTs, PEM private keys, and `SECRET`/`TOKEN`/`KEY`-style environment assignments are replaced by `[REDACTED:<kind>]`.

The execute, continue, and review tools report `redactions: <n>` when the count is above zero. Each batch task result reports its own `redactions`, and the batch payload reports `redactionsTotal`. These fields are omitted when the count is zero. Redaction is idempotent and never changes `status`, `isError`, `accepted`, or `verification.passed`.

## Metrics history and completeness

`codex_metrics` accepts `includeHistory: true` to aggregate archived `history/*.jsonl` back-files with the live and rotated log. The default is `false`; when archives exist, the result reports `historyFiles` and `historyExcluded`.

Every aggregate carries `completeness: { complete, unpricedRuns, missingUsage, readErrors, historyExcluded }`, making incomplete roll-ups visible. The shipped `COST_TABLE` is empty, and `CODEX_MCP_PRICING` does not fill it. Therefore any run that reported usage counts as unpriced, and `completeness.complete` is never `true` for usage-bearing entries in this release.

The local metrics record keeps the head of the first Codex error message, capped at 200 characters.

## Sandbox, timeouts and auto-resume

Sandbox modes are `read-only`, `workspace-write` (default), and `danger-full-access`. The default execution timeout is 60 minutes; `timeoutMs` is capped at 2 hours. Runs using the same `cwd` are serialized, while runs in different workspaces can run in parallel.

By default, the server resumes the same session after a transient turn failure at most 2 times, a timeout at most 1 time, or a `partial` result caused by a missing completion marker or parse errors at most 1 time; the latter is reported as `no-completion-marker`. Backoff is 2 seconds, then 8 seconds, with 8 seconds for any later resume. Set `CODEX_MCP_AUTO_RESUME=0` to opt out.
