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
- While iterating: run only the test file or pattern for the current task using the project's
  targeted command (for example, `npx vitest run tests/<file>.test.ts`); never repeatedly run the
  full suite mid-task.
- Full-suite limit: run the FULL test suite at most ONCE, as the final verification step before
  finishing.
- Environment failure: if the full suite fails with a sandbox or environment error (EMFILE, EPERM,
  out-of-memory, or file-watcher limits), STOP and report the verbatim error in the final summary;
  do NOT re-run the full suite hoping it passes.
- Long test commands: name every test command expected to take more than two minutes in the final
  summary and explain why it was needed.
- NEVER finish with failing tests or a broken build. If a pre-existing test fails for reasons
  outside this task, stop and report it instead of "fixing" the test to pass.
- Fix the implementation, not the test — unless the test itself is provably wrong, and say so.
```

## Claude's verification duty

Trust but verify: pass the task's acceptance command as `verifyCommand` so the server runs it after
the Codex run settles and returns `verification` (`exitCode`, `passed`, `outputTail`) — that field
is evidence, Codex's "tests pass" is not. The review phase still re-runs the full suite itself; the
tool result's `commands` list shows what Codex actually ran and its exit codes.
