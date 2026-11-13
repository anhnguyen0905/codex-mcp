# Gate inventory

This Phase 0 inventory records gates that assume code, git, or tests, so the multiscope roadmap can measure which gates must move behind a profile; it belongs to the multiscope roadmap accepted on 2026-11-13; analysis kept in the local brainstorm record.

| Gate | File | Anchor | Phase | Assumes | Applies to non-code runs | Profile equivalent (proposed) |
| --- | --- | --- | --- | --- | --- | --- |
| Git cleanliness and baseline ref | skills/preflight/SKILL.md | `Git cleanliness + ref` | 0 | git | partly | Data profile: record input paths, hashes, and the starting repository ref. |
| Dirty-baseline patch | commands/codex-flow.md | `baseline-dirty.patch` | 0 | git | partly | Data profile: snapshot input files as the before-state; keep the patch for repository files. |
| Live logs ignored | commands/codex-flow.md | `so raw live-progress JSONL logs never land` | 0 | git | partly | Keep as-is for repository runs; exclude transient analysis logs from deliverables. |
| Known-red test baseline | skills/preflight/SKILL.md | `Record pre-existing failures as the` | 0 | test | yes | Data profile: snapshot input paths, sizes, row counts, and hashes as the before-state. |
| PROJECT.md commit | commands/codex-flow.md | `PROJECT.md is tracked, not run state` | 0 | git | partly | Keep as-is for repository context; record the analysis brief beside non-code outputs. |
| AGENTS.md commit | commands/codex-flow.md | `commit every AGENTS.md creation/update` | 2 | git | partly | Keep as-is for repository guidance; non-code profiles use their approved rubric. |
| Fast-path eligibility | skills/fast-path/SKILL.md | `the task must fit ONE of these lanes` | fast-path | code, git | partly | Profile router: classify analysis, design, planning, and content requests before execution. |
| Small-change scope trip-wire | skills/fast-path/SKILL.md | `ANY extra changed file` | fast-path | code, git | no | Profile scope trip-wire: stop when output files exceed the declared deliverable set. |
| Verify command | src/server.ts | `Acceptance command the server runs in cwd AFTER the Codex run settles` | 4 | test | no | Profile checker: re-run every query in the evidence manifest and compare the numbers. |
| Verification controls acceptance | src/server.ts | `success AND (no verifyCommand OR it passed)` | 4 | test | no | Profile checker must pass and preserve the manifest's reproducible evidence. |
| Parallel wave computation | skills/parallel-execution/SKILL.md | `Always run the wave tool below during Phase 4` | 4 | code, git | partly | Profile dependency planner: parallelize only independent evidence and artifact work. |
| Clean tracked-baseline worktrees | skills/parallel-execution/SKILL.md | `its tracked baseline is clean` | 4 | git | partly | Keep for files in git; use isolated workspaces for concurrent deliverable work. |
| Worktree branch point | skills/parallel-execution/SKILL.md | `branch from the CURRENT integration branch HEAD` | 4 | git | partly | Keep for files in git; branch deliverable work from the current approved baseline. |
| Checkpoint task commits | skills/parallel-execution/SKILL.md | `MUST commit its task changes on the worktree branch` | 4 | git | partly | Keep for files in git; skip when the deliverable lives outside the repository. |
| Scope-check trip-wire | commands/codex-flow.md | `Scope trip-wire (mechanical, not judgment)` | 5 | code, git | no | Profile scope check: compare every produced file with the declared deliverable list. |
| Codex review git diff | src/server.ts | `for committed changes AND` | 5 | git | partly | Review the deliverable files and the manifest, not a code diff. |
| Full-suite final review | commands/codex-flow.md | `Run the full test suite, AND verify the feature end-to-end` | 5 | test | yes | Re-run the manifest checker on the whole deliverable plus rubric review. |
| Squash offer | skills/parallel-execution/SKILL.md | `Offer to squash the per-task/per-wave commits` | 5 | git | partly | Keep as-is for repository artifacts; package external deliverables separately. |
| Small-change lane test run | skills/fast-path/SKILL.md | `first run the project's test command once` | fast-path | test | no | Run the profile's relevant checker once and record pre-existing findings. |
| Conformance scope check | skills/review-conformance/SKILL.md | `Check scope both ways` | 5 | code, git, test | partly | Profile review checks requirements, declared outputs, sources, and rubric coverage. |
| Review test quality | skills/review-quality/SKILL.md | `Tests assert behavior, not implementation` | 5 | code, test | no | Profile review checks reproducibility, source quality, edge cases, and useful evidence. |
| Task-local tests | skills/plan-backlog/SKILL.md | `Tests live inside the task` | 3 | code, test | no | Profile checker evidence lives with the task that produces the deliverable. |
| Context-slice anchor check | skills/context-discipline/SKILL.md | `Check the generation anchor recorded in each slice header` | 4 | code, git | partly | Profile evidence sources must be re-checked when the source anchor changes. |
| Brainstorm HEAD provenance | commands/brainstorm.md | `and provenance: project root,` | brainstorm | git | yes | Keep as-is: record HEAD plus input file hashes for analysis topics. |

## How to read this

“Applies to non-code runs” means the current flow executes the gate for a non-code deliverable, not that the gate is necessarily appropriate for it. Every profile proposal is unimplemented in Phase 1 and later phases.

Considered and left out: Fast-path analysis exemption (an exemption, not a gate); executor fallback boundary (availability routing, not a code/git/test gate); review report append (durability bookkeeping, not a code/git/test gate); brainstorm read-only sandbox (execution policy, not a code/git/test gate).

## Baseline procedure

1. Pick a real analysis request, such as an AppsFlyer export question, and run it through the current flow from start to finish.
2. At the end, let the flow append the ledger line. If needed, append it manually with `node scripts/run-ledger.mjs append --lane full --project <abs-path> --run-id <id> --profile data --domain <text> --request-file <path> --fix-rounds <n> --started <ISO> --owner-gates <n> --outcome <outcome>`; use `--lane fast-path-analysis` when that lane was used.
3. Inspect the baseline with `node scripts/run-ledger.mjs summary` and `node scripts/run-ledger.mjs summary --json`.
4. In Phase 1 compare `fixRounds`, `codexTokens`, `wallClockMinutes`, `ownerGates`, `bypasses`, and verification findings.
