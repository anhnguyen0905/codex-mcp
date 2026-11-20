<div align="center">

# codex-mcp

**Plan with Claude · Execute with OpenAI Codex · Review with Claude + Codex**

A Claude Code plugin and MCP server for a repeatable plan → execute → review workflow.

[![CI](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anhnguyen0905/codex-mcp/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@anhnguyen0905/codex-mcp)](https://www.npmjs.com/package/@anhnguyen0905/codex-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/anhnguyen0905/codex-mcp/blob/main/LICENSE) ![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

macOS · Windows · Linux

</div>

## What it is

Claude interviews you and turns the request into an acceptance-tested plan. Codex implements the planned tasks, while Claude and Codex review each task and the final result. That split matters because the model that writes the code is not the only one judging it: Claude plans and reviews, and a fresh read-only Codex session reviews too, all from a single command. Findings loop back into fixes, and non-blocking improvements wait for your decision. The MCP server runs the local Codex CLI and returns structured results for the workflow to use.

- Six phases take a request from preflight through interview, plan, backlog, execution, and review.
- 76 skills are indexed and selected for the task instead of loading every skill into context.
- Independent tasks can run in parallel in separate git worktrees.
- Session reports record planning, allocation, task, cost, and summary files with PIC attribution.

## Quick start

1. **Prerequisites.** Install Node ≥ 20 and the Codex CLI, then authenticate with ChatGPT Plus/Pro/Team or an API key:

   ```bash
   npm i -g @openai/codex
   codex login
   # Or set OPENAI_API_KEY instead of using codex login.
   ```

2. **Install the plugin.** It bundles five commands, 76 skills, and the `codex` MCP server:

   ```text
   /plugin marketplace add anhnguyen0905/codex-mcp
   /plugin install codex-flow@codex-mcp
   ```

   The community-directory alternative is:

   ```text
   claude plugin marketplace add anthropics/claude-plugins-community
   claude plugin install codex-flow@claude-community
   ```

3. **First run.** In a project, start with:

   ```text
   /codex-flow implement a dark-mode toggle on the settings page
   ```

For a standalone MCP server, see [Standalone MCP server](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/configuration.md#standalone-mcp-server).

**Auth mode.** `codex_health` reports `authMode: "chatgpt" | "apikey" | "unknown"`. The ChatGPT-auth backend rejects arbitrary model ids, so pass `model` only when `authMode` is `apikey`; otherwise omit it and steer with `reasoningEffort`. `/codex-flow` follows the same rule, and a flowDocs guard checks that wording.

## Commands

| Command | Purpose |
|---|---|
| `/codex-flow <task>` | Run the six-phase workflow from preflight to Claude + Codex review. |
| `/codex-flow:brainstorm <question>` | Frame, map, challenge, and ratify a read-only systems-thinking analysis. |
| `/codex-flow:analyze <task>` | Run the full flow with the `data` profile preset. |
| `/codex-flow:design <task>` | Run the full flow with the `design` profile preset for game/product design docs. |
| `/codex-flow:plan <task>` | Run the full flow with the `plan` profile preset. |

## How it works

```text
Claude Code ──(MCP stdio)──▶ codex-mcp ──spawns──▶ codex exec --json
```

| Phase | Owner | What happens |
|---|---|---|
| 0 · Preflight | Claude | Verify Codex, baseline the workspace, and resume interrupted work. |
| 1 · Interview | Claude | Clarify requirements until acceptance criteria are verifiable. |
| 2 · Plan | Claude | Explore the codebase, select skills, and write the plan. |
| 3 · Backlog | Claude | Decompose the plan into dependency-ordered tasks. |
| 4 · Execute | Codex | Implement tasks serially or in parallel when independent. |
| 5 · Review | Claude + Codex | Compare reviews, fix findings, and gate non-blocking improvements. |

The server parses Codex’s JSONL event stream and returns a structured result through `codex_execute`, `codex_continue`, `codex_review`, `codex_batch`, `codex_sessions`, `codex_metrics`, and `codex_health`; see the [MCP tools reference](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/mcp-tools.md).

## Highlights

- **Dual review and improvements gate.** Claude and required `codex_review` findings are compared; non-blocking improvements wait for a user decision. [Workflow reference](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#the-six-phases)
- **Index-based skill selection.** A local index selects relevant skills within a context budget, and third-party skills are vetted before use. [Skill selection](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#skill-selection)
- **Context persistence for large projects.** Budgeted task slices and resume context carry anchored decisions and preserve mandatory task text. [Context persistence](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#context-persistence)
- **Parallel execution in git worktrees.** Independent tasks run across workspaces, then merge and receive integration review by wave. [Parallel execution](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#parallel-execution)
- **Executor fallback.** When Codex is unavailable, the flow offers an explicit choice to repair Codex or let Claude execute under the same plan/review contract. [Executor fallback](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#executor-fallback)
- **Per-session reports with PIC attribution.** Each session leaves planning, allocation, task, cost, and summary reports marked `claude`, `codex`, or `both`. [Session reports](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md#session-reports)

## Documentation

| Document | Use it for |
|---|---|
| [Workflow](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/workflow.md) | Phases, commands, state, skill selection, context, and reports. |
| [MCP tools](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/mcp-tools.md) | Tool inputs, results, review behavior, redaction, and execution controls. |
| [Configuration](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/configuration.md) | Environment variables, standalone setup, optional flint-chart, and troubleshooting. |
| [CHANGELOG](https://github.com/anhnguyen0905/codex-mcp/blob/main/CHANGELOG.md) | Release history. |
| [SECURITY](https://github.com/anhnguyen0905/codex-mcp/blob/main/SECURITY.md) | Vulnerability reporting. |

## Security & privacy

- **No credentials handled.** The server never reads, stores, or transmits credentials; authentication is handled entirely by the Codex CLI (`~/.codex/`); run `npm run doctor` to verify setup.
- **No network calls of its own.** The server spawns local `codex` and `git`; model traffic is Codex's, under your OpenAI account and its data policies.
- **Local-only telemetry.** Run metrics (tokens, durations, exit codes, and a 200-character error head) are appended to `~/.codex-mcp/metrics.jsonl` on your machine and never uploaded; logs and notes stay under gitignored `.codex-flow/`.
- **Sandboxed writes.** `workspace-write` is the default, `codex_review` is always `read-only`, `danger-full-access` is never used unless needed and disclosed, and per-cwd locks serialize runs.
- **Caller-defined `verifyCommand`.** Its redacted output tail is shell output and should be treated as such; third-party skills load only after a content-pinned vet.
- **Vulnerability reports.** Follow [SECURITY.md](https://github.com/anhnguyen0905/codex-mcp/blob/main/SECURITY.md).
- **Secret-redacted results.** Returned text is redacted before it leaves the server; see [Secret redaction](https://github.com/anhnguyen0905/codex-mcp/blob/main/docs/mcp-tools.md#secret-redaction).

## Development

```bash
npm test          # unit tests
npm run coverage  # enforces 80% thresholds
npm run build     # tsc → dist/
npm run test:e2e  # spawns Codex and uses quota
npm run data:guard # scans for real data before a commit
```

Key files:

<details>
<summary>Source layout</summary>

| Area | File | Role |
|---|---|---|
| Server | `src/index.ts` | stdio entry |
| Server | `src/server.ts` | MCP tools, cwd lock, cancellation |
| Server | `src/argsBuilder.ts` | Codex argv |
| Server | `src/codexRunner.ts` | spawn, timeout, and kill |
| Server | `src/eventParser.ts` | JSONL → result |
| Server | `src/workspaceDiff.ts` | git diff |
| Server | `src/terminal.ts`, `src/liveView.ts`, `src/progressFormatter.ts`, `src/progressNotifier.ts` | live progress |
| Server | `src/redaction.ts` | secret redaction |
| Server | `src/reviewFindings.ts` | review findings |
| Server | `src/verification.ts` | acceptance verification |
| Workflow | `scripts/sync-awesome-skills.mjs` | sync skill library |
| Workflow | `scripts/build-skills-index.mjs` | build skill index |
| Workflow | `scripts/skill-match.mjs`, `scripts/skill-eval.mjs` | match and evaluate skills |
| Workflow | `scripts/task-waves.mjs` | compute execution waves |
| Workflow | `scripts/session-cost.mjs` | session cost reporting |
| Workflow | `scripts/tail-progress.mjs` | live progress tail |
| Workflow | `scripts/flow-state.mjs` | validate run state |
| Workflow | `scripts/context-slice.mjs` | generate context slices |

</details>

<div align="center">
<sub><a href="https://github.com/anhnguyen0905/codex-mcp/blob/main/LICENSE">MIT</a> · <a href="https://github.com/anhnguyen0905/codex-mcp/blob/main/CHANGELOG.md">Changelog</a></sub>
</div>
