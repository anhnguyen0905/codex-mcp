# How codex-flow works

This reference is for plugin users who want to know what each phase does and what files a run leaves behind.

[← Back to README](../README.md)

## The six phases

`/codex-flow` keeps Claude as the planner and reviewer and Codex as the implementer.

| Phase | Owner | What happens | Artifact |
|---|---|---|---|
| **0 · Preflight** | Claude | Verify Codex login, establish the baseline git state and tests, and resume an interrupted run. | `.codex-flow/STATE.md` and the baseline recorded by the preflight flow |
| **1 · Interview** | Claude | Clarify requirements until every acceptance criterion is verifiable. | `.codex-flow/REQUIREMENTS.md` |
| **2 · Plan** | Claude | Explore the codebase, select relevant skills, and write the plan. | `.codex-flow/PLAN.md` |
| **3 · Backlog** | Claude | Decompose the plan into dependency-ordered tasks. | `.codex-flow/TASKS.md` |
| **4 · Execute** | Codex | Implement one task at a time, or several independent tasks in parallel. | Changed files and task handoffs |
| **5 · Review** | Claude + Codex | Dual-review each task and the final pass through Claude and required `codex_review`; compare findings, loop fixes back, and collect non-blocking improvements for a user decision gate. | Review findings, approvals, and the session report bundle |

Session report details are in [Session reports](#session-reports).

## Commands and profile presets

The five shipped command files define these entry points and descriptions:

| Command | Purpose |
|---|---|
| `/codex-flow` | Six-phase workflow: preflight, Claude interview and plan, backlog, Codex execution, and Claude + Codex review. |
| `/codex-flow:brainstorm` | Systems-thinking brainstorm; read-only, with no implementation code. |
| `/codex-flow:analyze` | Full flow with the `data` profile preset. |
| `/codex-flow:design` | Full flow with the `design` profile preset for game/product design docs. |
| `/codex-flow:plan` | Full flow with the `plan` profile preset. |

The preset commands invoke `codex-flow` with the same arguments, force the full-flow lane, and pass their profile at the Phase 0 Profile router. Phase 1 confirms the preset; profile, evidence, and run-language modes still come from `CODEX_FLOW_PROFILE_MODE`, `CODEX_FLOW_EVIDENCE`, and `CODEX_FLOW_RUN_LANGUAGE`. See [`docs/mcp-tools.md`](mcp-tools.md) for the MCP tool reference.

## Run state and requirements

`.codex-flow/REQUIREMENTS.md` records confirmed acceptance criteria verbatim with atomic `R<n>.<m>` IDs. Mid-run changes append confirmed `ADDED`, `MODIFIED`, or `REMOVED` deltas instead of rewriting history, and reset affected downstream approvals.

`.codex-flow/STATE.md` is the resume authority instead of file existence. It has 14 fixed run-state keys: `phase`, `requirementsApproved`, `planApproved`, `backlogApproved`, `runBaselineRef`, `resumeHead`, `knownRed`, `checkpointCommits`, `executionMode`, `dirtyBaseline`, `executor`, `currentTask`, `taskStage`, and `wave`. It also supports 6 optional profile keys: `profile`, `profileMode`, `evidenceMode`, `languageMode`, `runLanguage`, and `packs`. Phase and approval values change only through typed `flow-state` commands; the state also records immutable baseline, known-red, and dirty-baseline values, checkpoint choice, execution mode, and a separate `resumeHead`.

`scripts/requirements-coverage.mjs` rejects uncited or unknown criterion IDs at the Phase 3 gate. Final review walks every ID and records met/not-met with evidence. `TASKS.md` records session lineage and an append-only status-transition log. Resume reconciles orphaned in-progress work; wave scheduling seeds dependencies from done tasks, waits on in-progress tasks, and blocks dependents of failed or unknown states.

In parallel mode, one coordinator writes `.codex-flow/*`; workers return structured handoffs with touched files, checks, findings, decision-log proposals, and session IDs. Context slices always carry a stamped contracts index and compact known-red failures, and rank decision blocks by explicit `Applies to:` scope before recency; the execution prompt carries the run-position recitation header.

## Executor fallback

When Codex is not logged in or reachable, `/codex-flow` offers an explicit choice: fix Codex and re-check, or let Claude execute the backlog under the same plan/review contract with an independent subagent review replacing `codex_review`. The choice is recorded in `.codex-flow/STATE.md` as `executor:` and is never made silently or mid-task.

## Skill selection

Instead of blind-loading whole collections, `/codex-flow` selects only the skills a task needs from a local index. It classifies role facets such as engineering, data, marketing, growth, research, and design, then loads every relevant skill that fits a context budget of about 3% of the window and embeds distilled rule blocks into Codex prompts. Skills on disk cost zero context until selected; third-party skills are vetted once before first use.

The index covers `~/.claude/skills`, `~/claude-skill-library`, and the `skills/` directory of every installed plugin, using the newest version per plugin. A domain facet never ends with zero skills: when nothing indexed fits, Step 7 re-indexes, vets, searches (`gh`/catalog/web), and, if all of that fails, authors the missing `SKILL.md` before execution.

The plugin ships 76 skill files in `skills/` (`ls skills/*/SKILL.md | wc -l`), including 17 domain skills authored through Step 7: paid media, unit economics, media planning, warehouse modeling, event taxonomy, attribution, causal inference, survey design, ASO, localisation, OKRs, creative briefs, influencer strategy, SOPs and data-quality checks, and agent context persistence. They are indexed and selectable out of the box. Their numeric thresholds are labelled *derived, unverified*; replace them with your own account history before treating any of them as a target.

The last recorded results are a verified 32-scenario scope eval (`npm run skills:eval`, latest **32/32**) and a 100-request non-engineering scope run covering data analysis, marketing planning, performance marketing, market research, content, and product: **99/100** were covered by an existing skill, at precision@1 **84/99**, with the remaining case queued for Step 7 acquisition/authoring. See [`docs/skill-selection-eval-report.md`](skill-selection-eval-report.md) and [`docs/skill-selection-retrieval-2026-07-28.md`](skill-selection-retrieval-2026-07-28.md). The selection procedure is [`skills/skill-selection/SKILL.md`](../skills/skill-selection/SKILL.md).

```bash
node scripts/sync-awesome-skills.mjs --clone   # build a local library from awesome-claude-skills
node scripts/build-skills-index.mjs            # → ~/.claude/skill-library/INDEX.md
```

## Context persistence

`scripts/context-slice.mjs` generates budgeted derived slices from `.codex-flow/PLAN.md` and `.codex-flow/TASKS.md`: per-task `.codex-flow/CONTEXT-T<n>.md` files capped at 4,000 estimated tokens using the chars/4 heuristic, and `.codex-flow/RESUME.md` on resume capped at 8,000 estimated tokens by the same heuristic. Decision-log blocks carry a git-SHA `Anchor:`; slices stamp each block `[fresh]` or `[verify]`. A missing or invalid anchor, or a git failure, degrades the block to `[verify]`.

`scripts/project-context.mjs` writes `.codex-flow/PROJECT.md`, the durable project brief read on every task. `--generate` derives what the project is, its users, layout, constraints, quality mechanisms, known limitations, and direction; `--refresh` regenerates generated parts while preserving `<!-- owner-notes -->` blocks. Phase 0 generates it on a fresh run when absent and asks the user to confirm or edit it in the interview. Phase 2 reads it before exploring. Phase 5 proposes `--refresh`, showing the diff for confirmation, when a Decision-log block records a contract deviation or architecture change. It is a tracked project file, committed with the run and never archived with it; slices carry it as a `## Project context` item capped at 600 tokens.

Mandatory task text and task statuses are never dropped. Lower-priority content is dropped whole when necessary, with a restorable `(+N lower-priority items omitted — read .codex-flow/PLAN.md …)` pointer. The full `.codex-flow/PLAN.md` remains the on-disk source of truth. The slice helper is required: if missing or non-zero, the flow stops and asks for a plugin reinstall instead of degrading.

## Parallel execution

codex-mcp serializes runs per workspace but parallelizes across workspaces, so independent tasks can run concurrently in separate git worktrees driven by Claude subagents, then be merged and integration-reviewed per wave.

```bash
npm run waves                                  # compute execution waves from .codex-flow/TASKS.md
```

Waves batch tasks whose dependencies are met and whose files are disjoint, capped at 10 concurrent subagents (`--max <n>` lowers the cap). Parallel is the default when `task-waves` reports width greater than 1: waves of up to 3 run automatically, while wider waves ask first. Parallel execution costs N× simultaneous quota. See [`skills/parallel-execution/SKILL.md`](../skills/parallel-execution/SKILL.md).

## Session reports

Each session leaves planning, allocation, task, cost, and summary reports in `.codex-flow/reports/<YYYYMMDD-HHMMSS>/`, with explicit `claude`, `codex`, or `both` PIC attribution.

## Brainstorm

`/codex-flow:brainstorm <question>` is a read-only thinking workflow for questions that should not end in code. It frames the question, builds independent system maps, tests the reasoning, checks the surviving recommendation's feasibility, and delivers `ANALYSIS.md` for user ratification. It is grounded in Meadows, *Thinking in Systems*; Senge, *The Fifth Discipline*; Minto, *The Pyramid Principle*; Ackoff, *Redesigning the Future* and *Creating the Corporate Future*; and Checkland, *Systems Thinking, Systems Practice*.

| Phase | Who | What | Artifact |
|---|---|---|---|
| **Frame** | Claude | Clarify the decision, constraints, and meaning of decided; apply SCQA, CATWOE, treatment, and the system boundary without introducing an option. | `FRAME.md` |
| **Map** | Claude, then Codex | Build independent system maps with stocks, flows, feedback loops, delays, archetypes, and leverage points; record divergence without an option or recommendation. Fable critiques both maps. | `MAP.md` |
| **Reason** | Claude ⇄ Codex | Build and challenge a pyramid thesis through steelman → counter-thesis → Toulmin/Walton challenges, and 1–3 fresh read-only Astra rounds. | `REASON.md` |
| **Feasibility** | Codex | Assess only the surviving recommendation for effort, reversibility, dependencies, risks, conditions, first step, and one verdict; Fable critiques the verdict. Skip it when no recommendation survives Reason. | `REASON.md` (raw turn); `ANALYSIS.md` `## Feasibility` |
| **Decide** | Claude + user | Present the analysis for accept, amend, reject, or one more round; ratify it before offering the analysis as the starting point for a later flow. | `ANALYSIS.md` |

The run directory is `.codex-flow/brainstorm/<timestamp>/`. It contains `FRAME.md`, `MAP.md`, append-only `REASON.md`, and `ANALYSIS.md`, plus one `.codex-flow/notes/brainstorm.log` line. Astra JSON is parsed fail-closed by `scripts/debate-parse.mjs` with kinds `map`, `round`, and `feasibility`; malformed entries are reported and never reconstructed from prose. Reason records a standpoint ledger and assumption register. Its argumentation is grounded in Toulmin, *The Uses of Argument*; Walton, Reed & Macagno, *Argumentation Schemes*; van Eemeren & Grootendorst, *A Systematic Theory of Argumentation*; Rapoport's rules via Dennett, *Intuition Pumps*; and Mason & Mitroff, *Challenging Strategic Planning Assumptions*. The workflow writes no implementation code and does not touch the full flow's control files.

## Run ledger

The run ledger is append-only JSONL at `~/.codex-mcp/run-ledger.jsonl`; set `CODEX_MCP_RUN_LEDGER` to override the path. Each record captures the lane, project, run ID, profile, domain, language, request, selected skills, fix rounds, Codex tokens, wall-clock minutes, owner gates, bypasses, and outcome. Requests are redacted and capped at 4,000 characters. Ledger writes are best-effort: report a non-zero exit and continue. Inspect aggregates with `node scripts/run-ledger.mjs summary [--project <abs path>] [--json]`. The [`gate inventory`](gate-inventory.md) is Phase 0 of the multiscope roadmap accepted on 2026-11-13; analysis remains in the local brainstorm record.

## Profile pilot

The multiscope Phase 1 data-analysis pilot has independent `profile`, `evidence`, and run-language switches. Defaults preserve today's behaviour; shadow routing records its proposed gate replacements. See the [`profile pilot procedure`](profile-pilot.md) for the manifest, checker, and pass bar. Compare switch cohorts with `node scripts/run-ledger.mjs summary --filter key=value`.
