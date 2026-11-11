# AGENTS.md — codex-mcp / codex-flow

Source of the `codex-mcp` npm package and the `codex-flow` Claude Code plugin. The plugin's
behavior is defined in **markdown instruction files**, not runtime code.

## Build & test

- `npm test` — vitest (`tests/*.test.ts`, AAA style). Must stay green before any commit.
- `npm run build` — `tsc` to `dist/`.
- `node scripts/check-command-sync.mjs` — command-mirror gate (see below).
- `node scripts/check-release-consistency.mjs` — version-agreement gate (only on version bumps).
- In the Codex sandbox, if vitest fails with EPERM writing `node_modules/.vite-temp`, use
  `npx vitest run <file> --configLoader runner`; host-run results remain the source of truth.

## Hard conventions (CI-gated — violating these red-fails tests)

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
  `package-lock.json` (2 spots), `server.json` (2 spots), `.claude-plugin/plugin.json`, the
  `.mcp.json` npx pin, and a `## [<version>]` heading in `CHANGELOG.md`.

- **Run-state writes**: create STATE.md with `init`; change `phase` and the three approvals only
  through `approve`, `advance`, `requirement-delta`, `plan-drift`, `improvement-gate`, and `resume`;
  change other keys through `set`, task Status lines through `task`, and validate with `check` — the
  helper is required, never optional. It validates keys, phases, task stages, and status transitions. Never
  hand-edit those files in the flow, and never fall back to editing them when the helper is
  missing: a missing helper means the plugin install is broken, so the flow STOPS and the user is
  told to reinstall it; a helper that exits non-zero surfaces its error and STOPS.

- **Runtime scripts**: a new `scripts/*.mjs` helper the plugin invokes at runtime follows the
  `scripts/task-waves.mjs` idiom — Node stdlib only, pure named exports, CLI behind a
  `pathToFileURL` direct-run guard — and MUST be added to `package.json` `files[]` to reach the
  plugin cache. Tests import its exports with `// @ts-expect-error — plain .mjs script`.

- **Jev (TypeSafe.ai) decision helper**: `scripts/jev-client.mjs` wraps `POST
  https://api.typesafe.ai/v1/systemone` for optional fast-classification assists (fast-path
  routing, review-dual triage, skill-selection ranking). Reads `TYPESAFE_API_KEY` (never written
  to disk or logged) and `CODEX_FLOW_JEV_MODE` (`off|shadow|enforce`, default `shadow` when a key
  is set, else `off`). `off`/missing key is always a silent no-op — never a hard error. Shadow-mode
  comparisons land in `.codex-flow/notes/jev-shadow.log` (already covered by the `**/.codex-flow/`
  gitignore rule). The procedures live in the opt-in skill `skills/jev-assist`.

## Style

- Instruction prose: English, imperative, concise. Match the section style of neighboring skills
  (`##` headings, bullet rules, fenced templates).
- Prefer small additive edits over invasive rewrites; keep diffs reviewable.
