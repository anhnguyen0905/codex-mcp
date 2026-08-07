<div align="center">

# codex-mcp

**Plan with Claude · Execute with OpenAI Codex · Review with Claude**

A Claude Code plugin and MCP server that runs a disciplined **plan → execute → review** loop:
Claude interviews you and designs the plan, Codex writes the code, then Claude reviews each task
and the final pass alongside a required Codex `codex_review`; findings are compared, fixes go back,
and non-blocking improvements wait for your decision — all from a single command.

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
# from npm (recommended — ships a prebuilt dist, nothing to compile)
claude mcp add --scope user codex -- npx -y @anhnguyen0905/codex-mcp
# or straight from this repo, which builds from source on first run
claude mcp add --scope user codex -- npx -y github:anhnguyen0905/codex-mcp
```

`claude mcp list` should then show `codex … ✔ Connected`. Copy
[`commands/codex-flow.md`](commands/codex-flow.md) to `~/.claude/commands/` for the workflow
command, or just use the plugin install above which bundles both.
</details>

### Optional: flint-chart-mcp

codex-flow routes chart and graph tasks to flint-chart (Microsoft Research) via the
`codex-flow:exec-visualization` skill, rendering polished PNG/SVG charts instead of using ad-hoc
Python plotting.

Register the server with the Codex CLI in `~/.codex/config.toml`:

```toml
[mcp_servers.flint-chart]
command = "npx"
args = ["-y", "flint-chart-mcp"]
```

Register it with Claude:

```bash
claude mcp add flint-chart -- npx -y flint-chart-mcp
```

This setup is optional; when the server is not present, the `exec-visualization` skill degrades to
a fallback.

<details>
<summary>Troubleshooting: <code>Failed to reconnect to Plugin:codex-flow:codex: -32000</code></summary>

The plugin is distributed as a git clone and `dist/` is gitignored, so up to v0.14.0 a freshly
installed plugin had no build and its `node dist/index.js` launcher exited immediately.

Since v0.15.1 the bundled `.mcp.json` runs the published npm tarball
(`npx -y @anhnguyen0905/codex-mcp@<version>`), which ships a prebuilt `dist/` — nothing is compiled
at install time. Updating the plugin is the fix:

```
/plugin update codex-flow@codex-mcp
```

If you are pinned to an older version, patch that install once instead:

```bash
cd ~/.claude/plugins/cache/codex-mcp/codex-flow/<version>
npm install --no-audit --no-fund && npm run build
```

Then restart Claude Code and confirm with `claude mcp list` (or call `codex_health`).
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
| **5 · Review** | Claude + Codex | Dual-review each task and the final pass via Claude + required `codex_review`; compare findings, loop fixes back, and collect non-blocking improvements for a user decision gate. |

The bundled `session-report` skill writes a per-session bundle to `.codex-flow/reports/<YYYYMMDD-HHMMSS>/` with planning, allocation, task, cost, and summary reports plus explicit `claude` / `codex` / `both` PIC attribution.

The server spawns `codex exec` non-interactively, parses its JSONL event stream, and returns a
structured result (`sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`, `diff`).

---

## Highlights

### Index-based skill selection

Instead of blind-loading whole skill collections, `/codex-flow` selects only the skills a task
needs from a **local index**: it classifies the request's role facets (engineering, data,
marketing, growth, research, design…) and loads every relevant skill that fits a context budget
(~3% of the window), embedding distilled rule blocks into the Codex prompts. Skills on disk cost
zero context until selected; third-party skills are vetted once before first use.

The index covers `~/.claude/skills`, `~/claude-skill-library`, **and the `skills/` dir of every
installed plugin** (newest version per plugin) — so selection knows about skills the machine
already has instead of reporting a gap. And a domain facet never ends with zero skills: when
nothing indexed fits, Step 7 re-indexes, vets, searches (`gh`/catalog/web), and — failing all of
that — **authors the missing `SKILL.md` before execution**, so the library grows toward the work.

```bash
node scripts/sync-awesome-skills.mjs --clone   # build a local library from awesome-claude-skills
node scripts/build-skills-index.mjs            # → ~/.claude/skill-library/INDEX.md
```

Besides the phase skills, the plugin ships 17 domain skills authored through Step 7 — paid media,
unit economics, media planning, warehouse modeling, event taxonomy, attribution, causal inference,
survey design, ASO, localisation, OKRs, creative briefs, influencer strategy, SOPs and data-quality
checks, and agent context persistence — so they are indexed and selectable out of the box. Their
numeric thresholds are labelled *derived, unverified*: replace them with your own account history
before treating any of them as a target.

Verified by a 32-scenario scope eval (`npm run skills:eval`) — latest **32/32** — plus a
100-request non-engineering scope run (data analysis, marketing planning, performance marketing,
market research, content, product): **99/100** covered by an existing skill, at precision@1 84/99,
with the remaining case queued for Step 7 acquisition/authoring. Full procedure:
[`skills/skill-selection/SKILL.md`](skills/skill-selection/SKILL.md).

### Context persistence on large projects

`scripts/context-slice.mjs` generates budgeted derived slices from `.codex-flow/PLAN.md` and
`.codex-flow/TASKS.md`: per-task `.codex-flow/CONTEXT-T<n>.md` files (≤ **4000 estimated tokens**
using the chars/4 heuristic) and `.codex-flow/RESUME.md` on resume (≤ **8000 estimated tokens**
using the chars/4 heuristic). Decision-log blocks carry a git-SHA `Anchor:`, and slices stamp each
block `[fresh]` or `[verify]`; anything unverifiable — including a missing or invalid anchor or a
git failure — degrades to `[verify]`.

Mandatory task text and task statuses are never dropped. Lower-priority content is dropped whole
when necessary, with a restorable
`(+N lower-priority items omitted — read .codex-flow/PLAN.md …)` pointer. Full
`.codex-flow/PLAN.md` remains the on-disk source of truth. Standalone installs without the helper
fall back to reading PLAN.md directly.

### Run-state & requirements fidelity

- `.codex-flow/REQUIREMENTS.md` records confirmed acceptance criteria verbatim with atomic
  `R<n>.<m>` IDs. Mid-run changes append confirmed `ADDED`/`MODIFIED`/`REMOVED` Deltas instead of
  rewriting history, and reset affected downstream approvals.
- `.codex-flow/STATE.md` is the resume authority instead of file existence. Its 10-key run state
  tracks the phase, three approvals, immutable `runBaselineRef` / known-red / dirty-baseline values,
  checkpoint choice, execution mode, and a separate `resumeHead`.
- `scripts/requirements-coverage.mjs` rejects uncited or unknown criterion IDs at the Phase 3 gate;
  final review then walks every ID and records met/not-met with evidence.
- TASKS.md records session lineage and an append-only status-transition log. Resume reconciles
  orphaned in-progress work, while wave scheduling seeds dependencies from done tasks, waits on
  in-progress tasks, and blocks dependents of failed or unknown states.
- In parallel mode, one coordinator writes `.codex-flow/*`; workers return structured handoffs with
  touched files, checks, findings, decision-log proposals, and session IDs.
- Context slices always carry a stamped contracts index, compact known-red failures, and rank
  decision blocks by explicit `Applies to:` scope before recency; the execution prompt carries the
  run-position recitation header.

### Parallel execution for large backlogs

codex-mcp serializes runs per workspace but parallelizes across workspaces, so independent tasks
can run **concurrently** — each in its own git worktree driven by a Claude subagent, then merged
and integration-reviewed per wave.

```bash
npm run waves                                  # compute execution waves from .codex-flow/TASKS.md
```

Waves batch tasks whose dependencies are met and whose files are disjoint, capped at **10
concurrent subagents** (`--max <n>` to lower). Parallel is the default when `task-waves` reports
width > 1: waves of ≤3 run automatically, while wider waves ask first; parallel execution costs
N× simultaneous quota. Playbook:
[`skills/parallel-execution/SKILL.md`](skills/parallel-execution/SKILL.md).

---

## Tools

| Tool | Purpose |
|------|---------|
| `codex_execute` | Start a new Codex session executing a task/plan |
| `codex_continue` | Resume a session with follow-up (e.g. review feedback) |
| `codex_review` | Read-only review of uncommitted workspace changes |
| `codex_batch` | Run up to 50 tasks in parallel across distinct workspaces (worktrees) |
| `codex_sessions` | List prior Codex sessions (from `~/.codex/sessions/`), filterable by cwd |
| `codex_metrics` | Aggregate token/duration/failure metrics from the local run log |
| `codex_health` | Check Codex CLI version and login status |

`codex_execute` / `codex_continue` / `codex_review` accept `writeNotes: true` to persist a markdown
summary of the run to `<cwd>/.codex-flow/notes/<sessionId>.md`.

`codex_execute` / `codex_continue` / `codex_review` and each `codex_batch` task accept
`reasoningEffort: minimal | low | medium | high | xhigh`, passed to Codex as
`-c model_reasoning_effort="<value>"`.

Sandbox modes: `read-only`, `workspace-write` (default), `danger-full-access`. Default execution
timeout is 60 min (`timeoutMs` caps at 2 h). Runs into the same `cwd` are serialized; different
workspaces run in parallel.

By default, the server automatically resumes the same session after a transient turn failure
(at most 2 resumes), timeout (at most 1), or `partial` result caused by a missing completion marker
or parse errors (at most 1, reported as `no-completion-marker`), with 2 s then 8 s backoff (8 s
for any later resume). Set `CODEX_MCP_AUTO_RESUME=0` to opt out.

<details>
<summary>Result payload &amp; live progress</summary>

Every run tool returns `sessionId`, `agentMessage`, `fileChanges`, `commands`, token `usage`,
`errors`, plus:

- **`diff`** — `git status --porcelain` + `git diff HEAD` after the run (64 KB cap, `truncated`
  flag; `null` outside a git repo) so the caller can review without re-reading files.
- **`aborted`** — `true` when cancelled from the client (Esc in Claude Code); the server forwards
  cancellation to Codex (SIGTERM → SIGKILL after 5 s).
- **`attempts` / `resumeReasons`** — total attempts and the ordered reasons for automatic resumes;
  each `codex_batch` task result carries the same fields.
- **`liveLog`** — path to the raw JSONL event log when the live terminal view is enabled.

Clients that send an MCP `progressToken` (Claude Code does) get `notifications/progress` for every
meaningful Codex event. Set `terminal: true` (or `CODEX_MCP_TERMINAL=1`) to also open a live-tailing
window — Terminal.app on macOS, PowerShell on Windows, the first available emulator on Linux. On
macOS, the window closes itself about 4 seconds after a successful run; it stays open after a failed
or interrupted run. The delay defaults to 4000 ms; `0` closes immediately, and values above `60000`
are clamped. Windows and Linux windows already close with their process. If no window can open, the
run still succeeds; follow the `liveLog` or the in-session progress instead.
</details>

---

## Configuration

| Variable | Effect |
|----------|--------|
| `OPENAI_API_KEY` | Auth for Codex CLI (alternative to `codex login`). |
| `CODEX_BIN` | Override the Codex binary path/name (e.g. `C:\tools\codex.exe`). |
| `CODEX_MCP_TERMINAL=1` | Open the live-progress window by default. |
| `CODEX_MCP_TERMINAL_KEEP_OPEN=1` | Never auto-close the live-progress window (the value must be exactly `1`). |
| `CODEX_MCP_TERMINAL_CLOSE_DELAY_MS` | Set the close delay in ms; negative, non-integer, or unparseable input uses `4000`. |
| `CODEX_MCP_AUTO_RESUME=0` | Disable bounded server-side session auto-resume. |
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
`skill-match.mjs` · `skill-eval.mjs` · `task-waves.mjs` · `session-cost.mjs` · `tail-progress.mjs`.
</details>

---

<div align="center">
<sub>MIT · <a href="CHANGELOG.md">Changelog</a></sub>
</div>
