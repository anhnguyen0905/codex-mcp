<!-- generated 2026-11-22T15:04:11.441Z from README.md, AGENTS.md, package.json -->

# Project context

## What it is

- Package: `@anhnguyen0905/codex-mcp` v0.38.2
- Manifest description: MCP server bridging Claude Code and OpenAI Codex CLI for plan-execute-review workflows

A Claude Code plugin and MCP server for a repeatable plan → execute → review workflow.

<!-- owner-notes -->
<!-- /owner-notes -->

## Users

TODO — who runs this and in what environment

<!-- owner-notes -->
<!-- /owner-notes -->

## Layout

- Manifests: `package.json`
- Entry point: `dist/index.js`
- Published paths: `dist`, `scripts/evidence-scan.mjs`, `scripts/tail-progress.mjs`, `scripts/doctor.mjs`, `scripts/startup-probe.mjs`, `scripts/npm-smoke.mjs`, `scripts/build-skills-index.mjs`, `scripts/sync-awesome-skills.mjs` (+37 more)

<!-- owner-notes -->
<!-- /owner-notes -->

## Constraints

- **Command mirror**: every `commands/<name>.md` (`codex-flow.md`, `brainstorm.md`) has a
  **byte-identical** mirror at `.claude/commands/<name>.md`. Every edit to one must be `cp`-copied
  to the other. Gates: `scripts/check-command-sync.mjs` (`SYNC_PAIRS`) + `tests/flowDocs.test.ts`.
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
  `package-lock.json` (2 spots), `server.json` (2 spots), `.claude-plugin/plugin.json`, th… (truncated)

_Source: AGENTS.md_

<!-- owner-notes -->
<!-- /owner-notes -->

## Quality mechanisms

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
| Workflow | `scripts/task-waves.mjs` | compute… (truncated)

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
