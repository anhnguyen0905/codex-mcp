---
name: exec-self-testing
description: Self-testing requirements to embed into Codex execution prompts — test-first workflow, what to test, and the never-finish-red rule.
---

# Self-Testing (embed into Codex prompts)

A senior developer proves their own work. Include this block in every `codex_execute` prompt:

```
Testing requirements (mandatory):
- Every new behavior gets a test in the same task: happy path + at least one failure/edge case
  (empty input, boundary value, error propagation).
- Write the test alongside or before the implementation; use the project's existing test
  framework, file layout, and naming style.
- Tests assert behavior (inputs → outputs, state changes), not implementation details.
- Use Arrange-Act-Assert structure with descriptive names ("returns empty list when no match").
- Before finishing: run the FULL test suite and the build/typecheck — not just your new tests.
- NEVER finish with failing tests or a broken build. If a pre-existing test fails for reasons
  outside this task, stop and report it instead of "fixing" the test to pass.
- Fix the implementation, not the test — unless the test itself is provably wrong, and say so.
```

## Claude's verification duty

Trust but verify: the review phase re-runs the suite itself. Codex's claim that "tests pass" is input, not evidence — the tool result's `commands` list shows what was actually run and its exit codes; check them.
