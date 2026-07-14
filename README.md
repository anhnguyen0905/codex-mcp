<div align="center">

# codex-mcp

**Plan with Claude · Execute with OpenAI Codex · Review with Claude**

A Claude Code plugin and MCP server that runs a disciplined **plan → execute → review** loop:
Claude interviews you and designs the plan, Codex writes the code, Claude reviews the diff and
sends fixes back — all from a single command.

[![CI](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml)
&nbsp;·&nbsp; macOS · Windows · Linux &nbsp;·&nbsp; Node ≥ 20 &nbsp;·&nbsp; MIT

</div>

---

## Quick start

**1. Prerequisites** — Node ≥ 20 and the Codex CLI, authenticated:

```bash
npm i -g @openai/codex
codex login          # ChatGPT Plus/Pro/Team — or set OPENAI_API_KEY
```

**2. Install the plugin** (bundles the `/codex-flow` command + the `codex` MCP server):

```
/plugin marketplace add anhnguyen0905/codex-mcp
/plugin install codex-flow@codex-mcp
```

**3. Run it** in any project:

```
/codex-flow implement a dark-mode toggle on the settings page
```

<details>
<summary>Alternative: install the MCP server standalone (no plugin)</summary>

```bash
# from npm
claude mcp add --scope user codex -- npx -y @anhnguyen0905/codex-mcp
# or straight from this repo
claude mcp add --scope user codex -- npx -y github:anhnguyen0905/codex-mcp
```

`claude mcp list` should then show `codex … ✔ Connected`. Copy
[`commands/codex-flow.md`](commands/codex-flow.md) to `~/.claude/commands/` for the workflow
command, or just use the plugin install above which bundles both.
</details>

---

## How it works

```
Claude Code ──(MCP stdio)──▶ codex-mcp ──spawns──▶ codex exec --json
```

`/codex-flow` runs six phases, keeping Claude as the planner/reviewer and Codex as the implementer:

| Phase | Owner | What happens |
|-------|-------|--------------|
| **0 · Preflight** | Claude | Verify Codex login; baseline git + tests; resume an interrupted run. |
| **1 · Interview** | Claude | Clarify requirements until every acceptance criterion is verifiable. |
| **2 · Plan** | Claude | Explore the codebase, select relevant skills, write `.codex-flow/PLAN.md`. |
| **3 · Backlog** | Claude | Decompose into dependency-ordered tasks in `.codex-flow/TASKS.md`. |
| **4 · Execute** | Codex | Implement one task at a time — or several in parallel (see below). |
| **5 · Review** | Claude | Review each diff (conformance → quality → security); loop fixes back into the Codex session. |

The server spawns `codex exec` non-interactively, parses its JSONL event stream, and returns a
structured result (`sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`, `diff`).

---

## Highlights

### Index-based skill selection

Instead of blind-loading whole skill collections, `/codex-flow` selects only the skills a task
needs from a **local index**: it classifies the request's role facets (engineering, data,
marketing, design…) and loads every relevant skill that fits a context budget (~3% of the window),
embedding distilled rule blocks into the Codex prompts. Skills on disk cost zero context until
selected; third-party skills are vetted once before first use.

```bash
node scripts/sync-awesome-skills.mjs --clone   # build a local library from awesome-claude-skills
node scripts/build-skills-index.mjs            # → ~/.claude/skill-library/INDEX.md
```

Verified by a 32-scenario scope eval (`npm run skills:eval`) — latest **32/32**. Full procedure:
[`skills/skill-selection/SKILL.md`](skills/skill-selection/SKILL.md).

### Parallel execution for large backlogs

codex-mcp serializes runs per workspace but parallelizes across workspaces, so independent tasks
can run **concurrently** — each in its own git worktree driven by a Claude subagent, then merged
and integration-reviewed per wave.

```bash
npm run waves                                  # compute execution waves from .codex-flow/TASKS.md
```

Waves batch tasks whose dependencies are met and whose files are disjoint, capped at **10
concurrent subagents** (`--max <n>` to lower). Opt-in; costs N× simultaneous quota. Playbook:
[`skills/parallel-execution/SKILL.md`](skills/parallel-execution/SKILL.md).

---

## Tools

| Tool | Purpose |
|------|---------|
| `codex_execute` | Start a new Codex session executing a task/plan |
| `codex_continue` | Resume a session with follow-up (e.g. review feedback) |
| `codex_review` | Read-only review of uncommitted workspace changes |
| `codex_health` | Check Codex CLI version and login status |

Sandbox modes: `read-only`, `workspace-write` (default), `danger-full-access`. Default execution
timeout is 30 min (`timeoutMs` caps at 2 h). Runs into the same `cwd` are serialized; different
workspaces run in parallel.

<details>
<summary>Result payload &amp; live progress</summary>

Every run tool returns `sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`,
`errors`, plus:

- **`diff`** — `git status --porcelain` + `git diff HEAD` after the run (64 KB cap, `truncated`
  flag; `null` outside a git repo) so the caller can review without re-reading files.
- **`aborted`** — `true` when cancelled from the client (Esc in Claude Code); the server forwards
  cancellation to Codex (SIGTERM → SIGKILL after 5 s).
- **`liveLog`** — path to the raw JSONL event log when the live terminal view is enabled.

Clients that send an MCP `progressToken` (Claude Code does) get `notifications/progress` for every
meaningful Codex event. Set `terminal: true` (or `CODEX_MCP_TERMINAL=1`) to also open a live-tailing
window — Terminal.app on macOS, PowerShell on Windows, the first available emulator on Linux. If no
window can open, the run still succeeds; follow the `liveLog` or the in-session progress instead.
</details>

---

## Configuration

| Variable | Effect |
|----------|--------|
| `OPENAI_API_KEY` | Auth for Codex CLI (alternative to `codex login`). |
| `CODEX_BIN` | Override the Codex binary path/name (e.g. `C:\tools\codex.exe`). |
| `CODEX_MCP_TERMINAL=1` | Open the live-progress window by default. |
| `CODEX_FLOW_SKILLS_INDEX` | Override the skill index path. |
| `MCP_TOOL_TIMEOUT` | Raise Claude Code's MCP tool timeout (ms) for long runs. |

> **Security:** the server never reads, stores, or transmits your credentials — auth is handled
> entirely by the Codex CLI (`~/.codex/`). Run `npm run doctor` to verify your setup.

---

## Development

```bash
npm test          # unit tests (vitest)
npm run coverage  # enforces 80% thresholds
npm run build     # tsc → dist/
npm run test:e2e  # real end-to-end smoke test (spawns Codex, uses quota)
```

<details>
<summary>Source layout</summary>

**Server** (`src/`): `index.ts` (stdio entry) · `server.ts` (MCP tools, cwd lock, cancellation) ·
`argsBuilder.ts` (argv) · `codexRunner.ts` (spawn + timeout/kill) · `eventParser.ts` (JSONL →
result) · `workspaceDiff.ts` (git diff) · `terminal.ts` / `liveView.ts` / `progressFormatter.ts` /
`progressNotifier.ts` (live progress).

**Skill & workflow scripts** (`scripts/`): `sync-awesome-skills.mjs` · `build-skills-index.mjs` ·
`skill-match.mjs` · `skill-eval.mjs` · `task-waves.mjs` · `tail-progress.mjs`.
</details>

---

<div align="center">
<sub>MIT · <a href="CHANGELOG.md">Changelog</a></sub>
</div>
