# codex-mcp

[![CI](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml)

MCP server bridging **Claude Code** and **OpenAI Codex CLI** for a plan → execute → review workflow:

1. **Interview** — Claude clarifies requirements with you
2. **Design & Planning** — Claude explores the codebase and writes `.codex-flow/PLAN.md`
3. **Execution** — Codex implements the plan (`codex_execute`)
4. **Review** — Claude reviews the diff and sends findings back into the same Codex session (`codex_continue`)

## Architecture

```
Claude Code ──(MCP stdio)──▶ codex-mcp (this server)
                                 │ spawns
                                 ▼
                            codex exec --json  (OpenAI Codex CLI)
```

The server spawns `codex exec` non-interactively, parses its JSONL event stream, and returns structured results: `sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`, `errors`.

## Tools

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `codex_execute` | Start a new Codex session executing a task/plan | `prompt`, `cwd`, `sandbox`, `model?`, `timeoutMs?`, `terminal?` |
| `codex_continue` | Resume a session with follow-up (e.g. review feedback) | `sessionId`, `prompt`, `cwd`, `sandbox`, `timeoutMs?`, `terminal?` |
| `codex_review` | Read-only review of uncommitted workspace changes | `cwd`, `focus?`, `model?`, `timeoutMs?`, `terminal?` |
| `codex_health` | Check Codex CLI version and login status | — |

Sandbox modes: `read-only`, `workspace-write` (default), `danger-full-access`.
`codex_review` always runs read-only and never modifies files.
Default execution timeout: 30 minutes (`timeoutMs` caps at 2 hours).

### Result payload

Every run tool returns structured JSON: `sessionId`, `agentMessage`, `fileChanges`, `commands`,
token `usage`, `errors`, plus:

- `diff` — the workspace's `git status --porcelain` and `git diff HEAD` after the run (patch capped
  at 64 KB, `truncated` flag set when cut), so the caller can review changes without re-reading files.
  `null` when the cwd is not a git repo.
- `aborted` — `true` when the run was cancelled from the client (e.g. Esc in Claude Code). The
  server forwards MCP cancellation to Codex (SIGTERM, then SIGKILL after 5 s). On macOS/Linux the
  signal goes to Codex's whole process group, so subprocesses it spawned die too; on Windows only
  the CLI process itself is killed.
- `liveLog` — path to the raw JSONL event log when the live terminal view was enabled.

### Progress streaming

Clients that send an MCP `progressToken` (Claude Code does) receive `notifications/progress` for
every meaningful Codex event — session start, file changes, command runs, turn completion — so
progress is visible in-session on every platform, even without the terminal window below.

### Concurrency

Runs are serialized per workspace: a second `codex_execute`/`codex_continue`/`codex_review` into
the same `cwd` while one is active fails fast with a clear error instead of racing on files and
git state. Different workspaces run in parallel fine.

### Live progress in a Terminal window

Long Codex runs are otherwise invisible (the MCP call only returns when Codex finishes). Set
`terminal: true` on `codex_execute` / `codex_continue` — or export `CODEX_MCP_TERMINAL=1` — and the
server streams Codex's event stream to `<cwd>/.codex-flow/live/<timestamp>.jsonl` and opens a terminal
window that pretty-tails it — **Terminal.app** on macOS, a **PowerShell** window on Windows:

```
[17:23:22] ● session started: 019f4b…
[17:23:40] ✎ 3 file(s): src/fb_crawler/metrics.py, tests/test_metrics.py, pyproject.toml
[17:24:05] ▸ $ pytest  (exit 0)
[17:24:12] ✓ turn complete (in:27599 out:147)
```

The structured MCP result is unchanged; the terminal is a best-effort side view (a failed/unavailable
viewer never fails the run). The result payload always includes a `liveLog` path to the raw JSONL, so on
platforms without a supported terminal (e.g. Linux) you can tail it yourself.

## Platform support

Works on **macOS**, **Windows**, and **Linux**. The Codex run itself is fully cross-platform; the
live-progress **terminal window** is opened per-OS:

| OS | How the window opens | Notes |
|----|----------------------|-------|
| macOS | `open -a Terminal <.command>` (LaunchServices) | Avoids the Apple Events / Automation (TCC) permission that silently blocks `osascript` from an MCP server. Verified. |
| Windows | `powershell.exe … Start-Process` | No TCC-style gate on Windows. Codex CLI installs as `codex.cmd` (auto-selected). *Mechanism implemented; validate on your Windows host.* |
| Linux | first installed emulator (`gnome-terminal`, `konsole`, `xterm`, `kitty`, `alacritty`, …) | Detected via `command -v`. If none is found (headless / SSH), no window opens. *Mechanism implemented; validate on your distro.* |

If a window can't open (headless, SSH, missing permission, unknown emulator), the run still succeeds —
follow progress via the `liveLog` path in the result **or** the in-session MCP progress notifications.

- `CODEX_BIN` overrides the Codex binary path/name on any OS (e.g. `CODEX_BIN=C:\tools\codex.exe`).
- `CODEX_MCP_TERMINAL=1` opens the window by default without passing `terminal: true` per call.

## Prerequisites

- Node.js ≥ 20
- OpenAI Codex CLI, authenticated:
  ```bash
  npm i -g @openai/codex
  codex login          # ChatGPT Plus/Pro/Team — or set OPENAI_API_KEY
  ```

**First-time check** (if you cloned the repo): run the doctor — it verifies Node, Codex CLI
install + login, and Claude Code CLI install, and prints the exact fix for anything missing:

```bash
npm run doctor
```

`/codex-flow` also re-checks Codex login at the start of every run (Phase 0) and stops with
instructions instead of burning a session when you're not logged in.

> **Security note:** this server never reads, stores, or transmits your credentials.
> Authentication is handled entirely by the Codex CLI itself (`~/.codex/`); the server
> just spawns the `codex` binary and inherits whatever session the CLI already has.

## Install as a Claude Code plugin (recommended for teams)

The repo doubles as a Claude Code plugin marketplace bundling the `/codex-flow` command
(interview → plan/architecture → backlog → Codex executes per task → Claude reviews) and the
`codex` MCP server (via `npx @anhnguyen0905/codex-mcp`). In Claude Code:

```
/plugin marketplace add anhnguyen0905/codex-mcp
/plugin install codex-flow@codex-mcp
```

Restart Claude Code when prompted, then run `/codex-flow <feature description>` in any project.
Prerequisite stays the same: Codex CLI installed and logged in (see below).

## Skill selection (local skill index)

Instead of blind-loading whole skill collections, `/codex-flow` selects only the skills a task
needs from a **local index** (Phase 2): it classifies the request's role facets (engineering,
data, marketing, product, design…), then loads every relevant skill that fits a context budget of
~3% of the window (no fixed count), and embeds distilled rule blocks into the Codex prompts —
re-selected per task.

**Setup** (once, then re-run to refresh):

```bash
node scripts/sync-awesome-skills.mjs --clone   # clone every awesome-claude-skills repo → ~/claude-skill-library/remote/
node scripts/build-skills-index.mjs            # scan skill dirs → ~/.claude/skill-library/INDEX.md
```

Pass extra directories to index your own collections (`build-skills-index.mjs ~/my-skills`).

**How it works:**

- **Index** — `INDEX.md` is one grep-friendly line per skill (`name | description | path`). Skills
  on disk cost **zero context** until selected; the library lives outside Claude's auto-discovered
  dirs, so only what a session loads enters it.
- **Trust** — third-party skills (under `remote/`) are **vetted once before first use** and
  recorded in `VETTED.md`. Non-GitHub entries stay as URL pointers until fetched.
- **Growth** — skills researched or created during a flow are registered back into the library +
  index. Re-run `--clone` to pull upstream updates.
- **Config** — override the index path with `--out <file>` or `CODEX_FLOW_SKILLS_INDEX`. No index?
  The flow still runs; it just skips domain skill selection.

Full procedure (classify → evaluate loaded set → match → vet + budgeted load → embed per Codex
task → register back) lives in [`skills/skill-selection/SKILL.md`](skills/skill-selection/SKILL.md).

### Verifying selection (scope eval)

A 32-scenario eval checks selection across scopes (engineering, data, marketing, product, design,
security, bio, ML, documents, testing, game design, mobile, a multi-facet request, and an
uncovered-domain negative case). It runs the deterministic retrieval core against your built index
and asserts each scope surfaces the right skill within the token budget:

```bash
npm run skills:eval   # writes docs/skill-selection-eval-report.md
```

Latest: **32/32** against a 348-skill index ([report](docs/skill-selection-eval-report.md)).
Selection is budget-bounded, not count-bounded — a broad scope loads many skills (the Expo mobile
scenario loads 10, up to the ~6000-token ceiling), a narrow one loads a single skill. The eval
covers the mechanical match/rank/budget steps; role classification, per-facet selection, and
content vetting are LLM-judgment steps verified in review.

## Install (standalone, one command)

No clone, no build — `npx` fetches and builds it automatically. Same command on macOS, Windows, and Linux:

```bash
# from npm
claude mcp add --scope user codex -- npx -y @anhnguyen0905/codex-mcp

# or straight from this git repo
claude mcp add --scope user codex -- npx -y github:anhnguyen0905/codex-mcp
```

Verify: `claude mcp list` should show `codex … ✔ Connected`. To enable the live terminal by default,
export `CODEX_MCP_TERMINAL=1` in your shell profile.

For the full workflow command, copy [`commands/codex-flow.md`](commands/codex-flow.md) to
`~/.claude/commands/` — or skip both steps entirely and use the plugin install above, which
bundles the server and the command.

## Usage

In any Claude Code session:

```
/codex-flow implement dark mode toggle for the settings page
```

(The slash command lives at `~/.claude/commands/codex-flow.md`.)

Or call tools directly: ask Claude to "use codex_execute to ..." — remember to keep the returned `sessionId` for follow-ups.

> Note: long Codex runs can exceed Claude Code's MCP tool timeout. If a call is killed early, raise `MCP_TOOL_TIMEOUT` (env var, ms) when starting Claude Code.

## Development

```bash
npm test          # unit tests (vitest)
npm run coverage  # enforces 80% thresholds
npm run test:e2e  # real end-to-end smoke test (spawns real Codex, uses quota)
npm run build     # tsc → dist/
```

Source layout:

- `src/argsBuilder.ts` — validates input, builds `codex exec` / `codex exec resume` argv
- `src/codexRunner.ts` — spawns the CLI with timeout + kill handling
- `src/eventParser.ts` — folds the JSONL event stream into a `CodexResult`
- `src/server.ts` — MCP tool registration (`@modelcontextprotocol/sdk`), cwd lock, cancellation wiring
- `src/index.ts` — stdio entrypoint
- `src/terminal.ts` — cross-platform live-progress terminal launcher (macOS/Windows)
- `src/liveView.ts` — streams the event log to disk and opens the viewer
- `src/progressFormatter.ts` — turns JSONL events into human-readable lines
- `src/progressNotifier.ts` — line-buffers stdout into MCP `notifications/progress`
- `src/workspaceDiff.ts` — captures `git status` + `git diff HEAD` for the result payload
- `scripts/tail-progress.mjs` — the pretty-tail script the terminal window runs

Skill-selection scripts (`npm run skills:sync` / `skills:index` / `skills:eval`):

- `scripts/sync-awesome-skills.mjs` — sync/clone awesome-claude-skills into the local library
- `scripts/build-skills-index.mjs` — scan skill dirs → `INDEX.md` (merges remote pointers)
- `scripts/skill-match.mjs` — deterministic retrieval core (score → rank → token-budget fit)
- `scripts/skill-eval.mjs` — run the scope scenarios → `docs/skill-selection-eval-report.md`
