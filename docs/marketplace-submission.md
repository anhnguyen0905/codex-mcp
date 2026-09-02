# Claude plugin directory submission — codex-flow

Submit at https://clau.de/plugin-directory-submission (Anthropic's community pipeline; PRs against
`anthropics/claude-plugins-community` are auto-closed). The official `claude-plugins-official`
marketplace is curated by Anthropic with no public form.

## Pre-submission gates (all must pass on the commit you submit)

```bash
claude plugin validate . --strict
node scripts/check-release-consistency.mjs
node scripts/check-command-sync.mjs
npm test
```

## Form fields (copy-paste)

- **Plugin name**: `codex-flow`
- **Display name**: Codex Flow
- **Repository**: https://github.com/anhnguyen0905/codex-mcp
- **Version**: 0.23.1 (pinned in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`)
- **License**: MIT
- **Category**: development-workflows
- **Keywords**: codex, openai-codex, mcp, workflow, plan-execute-review, multi-agent, code-review
- **Short description** (≤ 140 chars):
  Plan with Claude, execute with OpenAI Codex, review with both — a six-phase workflow plus the codex MCP server.
- **Long description**:
  `/codex-flow` turns a feature request into a governed pipeline: preflight (Codex health, git
  baseline, known-red tests), a requirements interview with verifiable acceptance criteria,
  architecture + backlog planning with per-task context slices, Codex execution per task (parallel
  git worktrees when tasks are file-disjoint), and a dual Claude + Codex review with structured
  findings, server-run acceptance verification, and a 3-round fix loop. State lives in
  `.codex-flow/` so runs resume after compaction; when Codex is logged out or unavailable, an
  explicit executor fallback lets Claude execute under the same contract. Ships the `codex` MCP
  server (execute, continue, review, batch, sessions, metrics, health) and ~60 domain skills.
- **Prerequisites**: Node ≥ 20; Codex CLI (`npm i -g @openai/codex`) logged in via ChatGPT
  Plus/Pro/Team or `OPENAI_API_KEY`.
- **Network / data**: the server makes no network calls of its own; all model traffic is the Codex
  CLI's under the user's OpenAI account. Metrics stay local in `~/.codex-mcp/metrics.jsonl`.
- **Permissions used**: spawns `codex` and `git`; writes `.codex-flow/` in the project (gitignored)
  and `~/.codex-mcp/`. Optional macOS Terminal window for live progress (`CODEX_MCP_TERMINAL=1`).
- **Security contact**: see SECURITY.md.

## After approval

The pipeline pins the reviewed commit SHA; bump `version` in both manifests on every release so
listed users receive updates (`scripts/check-release-consistency.mjs` enforces agreement).
