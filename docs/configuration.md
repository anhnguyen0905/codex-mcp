# Configuration

Use this page when setting up or tuning the codex-flow plugin and its standalone MCP server.

[← Back to README](../README.md)

## Environment variables

Set these variables in the environment that launches Claude Code, the MCP server, or the relevant helper script. Defaults below are taken from the source files named in the table.

| Variable | Effect | Default |
|---|---|---|
| `OPENAI_API_KEY` | Authenticates the Codex CLI as an alternative to `codex login`. | Unset — authenticate with `codex login` instead. |
| `CODEX_BIN` | Overrides the Codex binary path or name, for example `C:\tools\codex.exe`. | `codex`, or `codex.cmd` on Windows (`src/codexRunner.ts:21-27`). |
| `CODEX_MCP_TERMINAL=1` | Opens the live-progress window by default. A per-call `terminal` argument overrides this setting. | Unset/off; only the exact value `1` enables it (`src/server.ts:139`). |
| `CODEX_MCP_TERMINAL_KEEP_OPEN=1` | Never auto-closes the live-progress window; the value must be exactly `1`. | Unset: auto-close remains enabled when supported. |
| `CODEX_MCP_TERMINAL_CLOSE_DELAY_MS` | Sets the close delay in milliseconds. Negative, non-integer, or unparseable input uses `4000`; valid values are clamped to `60000`. | `4000` (`src/terminalCloser.ts`) |
| `CODEX_MCP_AUTO_RESUME=0` | Disables bounded server-side session auto-resume. | Enabled unless the value is exactly `0` (`src/server.ts:558`). |
| `CODEX_FLOW_SKILLS_INDEX` | Overrides the skill index path. | `~/.claude/skill-library/INDEX.md` (`scripts/skill-shortlist.mjs:41-42`). |
| `MCP_TOOL_TIMEOUT` | Read by Claude Code (the MCP client); raises Claude Code's MCP tool timeout, in milliseconds, for long runs. | See Claude Code's MCP client configuration. |
| `CODEX_HOME` | Overrides the Codex configuration and session root used for session discovery. | `~/.codex` (`src/sessionStore.ts`) |
| `CODEX_MCP_METRICS_LOG` | Overrides the local metrics log path. | `~/.codex-mcp/metrics.jsonl` (`src/metricsLog.ts`) |
| `CODEX_MCP_PRICING` | Supplies JSON pricing rates (`inputPer1M`, `cachedInputPer1M`, `outputPer1M`, `reasoningOutputPer1M`) so metrics can include `estCostUsd`. | See `src/metricsLog.ts`; the built-in cost table is empty. |
| `CODEX_MCP_MAX_CONCURRENT` | Sets the global cap on concurrent Codex runs. Values must be finite numbers of at least `1`; values are floored. Invalid or empty values use the default. | `16` (`src/concurrency.ts`) |
| `CODEX_MCP_LOCKS_DIR` | Overrides the directory for cross-process workspace lease files. | `~/.codex-mcp/locks` (`src/workspaceLease.ts`) |
| `CODEX_MCP_LIVE_DIR` | Overrides the live-progress log root. | `~/.codex-mcp/live` (`src/liveView.ts`); logs land in a per-workspace `<name>-<hash>` subdir outside the workspace so cloud-synced folders (OneDrive, iCloud, Dropbox) cannot freeze them. |
| `CODEX_MCP_RUN_LEDGER` | Overrides the run-ledger file path. | `~/.codex-mcp/run-ledger.jsonl` (`scripts/run-ledger.mjs:8,141`). |
| `CODEX_MCP_DATA_GUARD` | Overrides the data-guard denylist path. | `~/.codex-mcp/data-guard.json` (`scripts/data-guard.mjs:11,109`). |
| `CODEX_FLOW_PROFILE_MODE` | Selects profile routing behavior: `off`, `shadow`, or `enforce`. | `shadow` (`scripts/profile-router.mjs`) |
| `CODEX_FLOW_EVIDENCE` | Selects evidence behavior: `off`, `shadow`, or `enforce`. | `off` (`scripts/profile-router.mjs`) |
| `CODEX_FLOW_RUN_LANGUAGE` | Selects run-language detection: `off` or `on`. | `off` (`scripts/profile-router.mjs`) |
| `CODEX_FLOW_PACKS` | Selects pack routing: `off` or `on`; pack routing applies to data profiles. | `off` (`scripts/profile-router.mjs`) |
| `CODEX_FLOW_JEV_MODE` | Selects the optional Jev decision helper mode: `off`, `shadow`, or `enforce`. | `shadow` when `TYPESAFE_API_KEY` is set; otherwise `off` (`scripts/jev-client.mjs`) |
| `TYPESAFE_API_KEY` | Enables authentication for the optional TypeSafe Jev client. | Unset: Jev is unavailable; its mode defaults to `off` (`scripts/jev-client.mjs`). |

## Standalone MCP server

Install the server without the plugin from npm (recommended; it ships a prebuilt `dist/` and nothing needs compiling):

```bash
claude mcp add --scope user codex -- npx -y @anhnguyen0905/codex-mcp
```

Or install straight from the repository; it builds from source on first run:

```bash
claude mcp add --scope user codex -- npx -y github:anhnguyen0905/codex-mcp
```

Run `claude mcp list`. It should show `codex … ✔ Connected`. Copy [`commands/codex-flow.md`](../commands/codex-flow.md) to `~/.claude/commands/` for the workflow command, or use the plugin install, which bundles both.

## Optional: flint-chart

codex-flow routes chart and graph tasks to flint-chart (Microsoft Research) through the `codex-flow:exec-visualization` skill. It renders polished PNG/SVG charts instead of using ad-hoc Python plotting.

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

This setup is optional. When the server is absent, the `exec-visualization` skill degrades to a fallback.

## Troubleshooting

If Claude Code shows `Failed to reconnect to Plugin:codex-flow:codex: -32000`, the plugin may be an older git-clone distribution. Up to v0.14.0, `dist/` was gitignored, so a freshly installed plugin had no build and its `node dist/index.js` launcher exited immediately.

Since v0.15.1, the bundled `.mcp.json` runs the published npm tarball (`npx -y @anhnguyen0905/codex-mcp@<version>`), which ships a prebuilt `dist/`; nothing is compiled at install time. Update the plugin:

```text
/plugin update codex-flow@codex-mcp
```

If you are pinned to an older version, patch that install once:

```bash
cd ~/.claude/plugins/cache/codex-mcp/codex-flow/<version>
npm install --no-audit --no-fund && npm run build
```

Then restart Claude Code and confirm with `claude mcp list` or by calling `codex_health`. Run `npm run doctor` (`scripts/doctor.mjs`) to verify the setup.
