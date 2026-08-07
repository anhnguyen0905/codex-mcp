# Context Persistence Research — 2026-08-06

Research inputs for the codex-flow context-persistence redesign ("Gói 4").
Two streams: external state-of-the-art (web, cited) and internal codebase audit.

## Stream 1 — External state of the art

### Context engineering (Anthropic, Manus, Cognition)
- Anthropic's three long-horizon techniques: compaction, structured note-taking outside the window (re-injected selectively), and sub-agent architectures where the orchestrator receives only distilled results. Tune compaction for recall first. — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Manus: "use the file system as the ultimate context"; compression must be *restorable* — drop content, keep the path so it can be re-read. Recitation: constantly rewrite `todo.md` to push the plan into recent attention. Keep the context prefix stable (KV-cache). — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Cognition: actions carry implicit decisions; parallel sub-agents are safe for read-only research, dangerous for parallel writes. — https://cognition.com/blog/dont-build-multi-agents

### Memory architectures
- MemGPT/Letta: the load-bearing primitive is the *labeled, size-bounded, self-edited memory block*; tiers = core (always in context) / recall (searchable) / archival (cold). — https://docs.letta.com/letta-memgpt
- Claude Code: manual compact at phase boundaries beats auto-compact; CLAUDE.md < 300 lines of "things the agent would get wrong otherwise". — https://vectorize.io/articles/claude-code-memory
- AGENTS.md is the cross-tool convention with hierarchical nearest-wins loading. — https://benjamincrozat.com/agents-md
- Codex CLI "memories": generated rolling-summary layer distinct from hand-curated AGENTS.md. — https://mem0.ai/blog/how-memory-works-in-codex-cli

### Repo-scale selective retrieval
- Aider repo-map: tree-sitter tags → PageRank → binary-search the ranked list to a hard token budget (`--map-tokens`); rebuilt per message so never stale. — https://aider.chat/2023/10/22/repomap.html
- Claude Code deliberately has no index: agentic grep/glob/read beat a vector DB and eliminated staleness/reindex problems. — https://vadim.blog/claude-code-no-indexing/
- Counter-argument: grep-only burns tokens in very large repos; hybrid (cheap index to aim greps) wins at scale — retrieval is a cost-curve problem. — https://harrisonsec.com/blog/agent-retrieval-cost-curve-claude-code-grep-vs-rag/
- Trade-off: embeddings = build cost + staleness + infra; tree-sitter graph = cheap, symbol-level only; pure grep = zero staleness, higher per-task token cost.

### Structured state files
- spec-kit: fixed artifact set (constitution/spec/plan/tasks) + a read-only `analyze` step cross-checking docs for conflicts before implementing. — https://github.com/github/spec-kit
- Append-only decision log + regenerated "current state" snapshot at checkpoints = event-sourcing → snapshot analogy. — https://martinfowler.com/eaaDev/EventSourcing.html
- planning-with-files: per-turn plan re-injection against context rot + deterministic completion gate on resume. — https://github.com/othmanadi/planning-with-files

### Drift prevention
- The "stale plan problem" is a named failure mode; mitigation: plan updates are part of each task's definition-of-done. — https://medium.com/@arijitdutta23/the-stale-plan-problem-in-coding-agents-cde2c741f8ab
- Anchor state to git HEAD SHA at write time (not mtimes); on read-back `git diff <anchor>..HEAD --stat` tells the agent which claims to distrust. Pair with a dirty-tree check. — https://github.com/NousResearch/hermes-agent/pull/19740
- Trust-but-verify resume: written state is hypothesis; filesystem + git are ground truth. — https://addyo.substack.com/p/long-running-agents
- Cite `path:line` + enclosing symbol, never pasted code, in durable notes.

### Token budgeting
- Progressive disclosure (Agent Skills): frontmatter (~80 tokens) → body on activation (~2k) → references on demand. — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Fixed-budget rendering: rank items, binary-search/cut to the budget — hard cap regardless of corpus size (Aider).
- Front-matter metadata is the cheapest routing signal for selective loading.

### Candidate patterns (external)
1. Tiered read-back: index → summary → detail, hard budget by rank-then-cut.
2. Git-SHA anchor stamp on every state write + diff-stat on read-back.
3. Append-only decision log + regenerated current-state snapshot at boundaries.
4. Recitation: rewrite/re-inject the live plan at phase starts.
5. Restorable compression: pointers (`path:line@SHA` + symbol), not payloads.
6. Plan-update-as-definition-of-done gate.
7. Never persist "what the code looks like"; persist "where to look", regenerate maps at read time.
8. Front-matter metadata on every state file for tens-of-tokens triage.

## Stream 2 — Internal audit (codebase, paths as of d281f4b)

- **Biggest cost**: `commands/codex-flow.md:183` makes Codex read ALL of PLAN.md per task; `commands:212` makes Claude re-read all of PLAN.md per review. Decision log is append-only (4-field blocks per task/event) → O(tasks²) read cost across a backlog. Archived PLAN.md files: 107 → 393 lines; TASKS.md 41 → 299 lines.
- **No slicing exists**: the only scoped read in the system is the `- Session start:` line extraction (`skills/session-report/SKILL.md:68`). Archived TASKS.md show authors hand-slicing by contract label ("Read PLAN.md contract C1") with no tooling support.
- **Unconnected building blocks already in-repo**:
  - `scripts/skill-match.mjs:267-294` — working token-budget engine (`fitToBudget`, `DEFAULT_TOKEN_BUDGET` 6000 = 3% of 200k, chars/4 estimator in `skill-eval.mjs:73-87`).
  - `tests/flowDocs.test.ts` `extractPhaseSection` — heading-to-next-`##` markdown slicer.
  - `scripts/task-waves.mjs` `parseTasks` — task-scoped TASKS.md parser; the structural template for any new `.codex-flow` CLI helper (pure exports + CLI + vitest).
  - `.codex-flow/SKILLS-T<n>.md` — the one existing "spill context to a file and point at it" precedent (`skill-selection` Step 6).
  - `scripts/session-cost.mjs` + `~/.codex-mcp/metrics.jsonl` — real token telemetry to validate budgets.
- **Resume today**: existence check on PLAN.md+TASKS.md → read statuses → jump to Phase 4; inherits the ENTIRE Decision log; never re-runs the known-red baseline; no staleness notion.
- **`.codex-flow/` is fully gitignored** — durable state is machine-local; parallel mode hand-copies PLAN/TASKS into worktrees.
- **Gói 3 (code graph)** was a one-line out-of-scope exclusion in the 0.17.0 plan; genuinely unstarted, no design artifacts.
- **CI gates on instruction wording**: `tests/flowDocs.test.ts` (phrase pins) + `scripts/check-command-sync.mjs` (byte-identical mirror) — any command/skill rewording must update both in the same commit.

## Verdict on Gói 3 (code graph)

Keep deferred. Rationale: codex-flow's code exploration is already delegated (Explore subagents in Phase 2; Codex explores its own workspace), and both Claude Code's no-index finding and pattern 7 above say a persisted code inventory is staleness source #1 on a large project. What codex-flow should persist is *where to look* (contracts, entry points, `path:line@SHA` pointers in the Decision log), regenerating any structural view at read time. Revisit only if telemetry shows exploration token cost dominating after the slice layer ships.
