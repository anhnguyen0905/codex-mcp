---
name: plan-backlog
description: Backlog decomposition for the Planning phase — slicing rules, dependency ordering, and per-task acceptance criteria sized for single Codex runs.
---

# Backlog Breakdown

Decompose the approved plan into `.codex-flow/TASKS.md`. Each task is one Codex run and one review cycle.

## Task format

```markdown
## T1: <imperative title>
- Depends on: — | T<n>
- Files: <create/modify list>
- Steps: <concrete, file-level steps>
- Acceptance: <verifiable criteria for THIS task alone>
- Status: pending
```

## Slicing rules

- **Right-sized**: ~5–30 minutes of Codex work. Bigger → split; a task you can't describe in a few file-level steps is too big.
- **Independently verifiable**: each task's acceptance criteria must be checkable when only that task is done (its tests pass, build stays green) — never "works after T5 lands".
- **Vertical over horizontal** where possible: a thin end-to-end slice (one endpoint + its test) reviews better than "all models, then all controllers".
- **Dependency-ordered**: a task may only depend on earlier tasks; no cycles. Foundations (types, schemas, migrations) first; risky tasks (migrations, public API changes) isolated into their own task so a failed run has a small blast radius.
- **Tests live inside the task** that adds the behavior — never a trailing "write tests" task.

## Sanity checks before showing the user

- Union of all task acceptance criteria covers every plan acceptance criterion (no orphan requirements).
- No task touches files another incomplete task owns (avoids Codex-vs-Codex merge conflicts).
- First task is small — it validates the plan's assumptions cheaply before the expensive middle.
- Mirror tasks with TaskCreate so the user sees live progress during execution.
