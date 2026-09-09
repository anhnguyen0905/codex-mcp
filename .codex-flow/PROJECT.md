<!-- generated 2026-09-09T07:38:27.855Z from README.md, AGENTS.md, package.json -->

# Project context

## What it is

- Package: `@anhnguyen0905/codex-mcp` v0.26.0
- Manifest description: MCP server bridging Claude Code and OpenAI Codex CLI for plan-execute-review workflows

A Claude Code plugin and MCP server that runs a disciplined **plan → execute → review** loop:
Claude interviews you and designs the plan, Codex writes the code, then Claude reviews each task
and the final pass alongside a required Codex `codex_review`; findings are compared, fixes go back,
and non-blocking improvements wait for your decision — all from a single command.

<!-- owner-notes -->
<!-- /owner-notes -->

## Users

TODO — who runs this and in what environment

<!-- owner-notes -->
<!-- /owner-notes -->

## Layout

- Manifests: `package.json`
- Entry point: `dist/index.js`
- Published paths: `dist`, `scripts/tail-progress.mjs`, `scripts/doctor.mjs`, `scripts/build-skills-index.mjs`, `scripts/sync-awesome-skills.mjs`, `scripts/skill-match.mjs`, `scripts/skill-eval.mjs`, `scripts/task-waves.mjs` (+14 more)

<!-- owner-notes -->
<!-- /owner-notes -->

## Constraints

- **Command mirror**: `commands/codex-flow.md` has a **byte-identical** mirror at
  `.claude/commands/codex-flow.md`. Every edit to one must be `cp`-copied to the other.
  Gates: `scripts/check-command-sync.mjs` + `tests/flowDocs.test.ts`.
- **Skill files**: `skills/<name>/SKILL.md`. Frontmatter is exactly two unquoted fields:
  `name:` and a one-line `description:`. Body follows the existing skills — `# <Title>
  (embed into Codex prompts)`, then `## Standards block` with a fenced ``` block whose contents
  are what gets embedded into a Codex prompt (label line + terse `- Key: value` bullets).
  Match `skills/exec-deliverable/SKILL.md`.
- **Skill reachability**: every `codex-flow:<token>` referenced in `commands/codex-flow.md` must
  resolve to an existing `skills/<token>/SKILL.md` (`tests/flowDocs.test.ts`). Add the token and
  the SKILL.md together. Skill tokens named in the command must sit inside a
  `**Load skills first...**:` line to be recognized.
- **Release consistency**: on a version bump, the version must agree across `package.json`,
  `package-lock.json` (2 spots), `server.json` (2 spots), `.claude-plugin/plugin.json`, the
  `.mcp.json` npx pin, and a `## [<version>]`… (truncated)

_Source: AGENTS.md_

<!-- owner-notes -->
<!-- /owner-notes -->

## Quality mechanisms

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

_Source: README.md_

<!-- owner-notes -->
<!-- /owner-notes -->

## Known limitations

TODO — known gaps, caveats and measured weak spots

<!-- owner-notes -->
<!-- /owner-notes -->

## Direction

TODO — what the owner wants next

<!-- owner-notes -->
<!-- /owner-notes -->
