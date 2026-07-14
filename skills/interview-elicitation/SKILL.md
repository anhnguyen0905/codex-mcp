---
name: interview-elicitation
description: Requirements elicitation framework for the Interview phase — six question domains, verifiable acceptance criteria, and the stop condition for when requirements are complete.
---

# Requirements Elicitation

Goal: leave the interview with requirements so unambiguous that a different engineer could implement them without asking anything.

## Six domains to cover (minimum one confirmed answer each)

1. **Goal & success criteria** — What does "done" look like? What user-visible behavior changes? How will we measure success?
2. **Scope boundaries** — What is explicitly IN? What is explicitly OUT? What must not change?
3. **Technical constraints** — Required stack/libraries, patterns to follow, files/areas not to touch, compatibility targets (OS, browsers, versions).
4. **Edge cases & failure behavior** — What happens on invalid input, empty state, concurrency, timeouts, partial failure? What should the user see when things go wrong?
5. **Non-functional requirements** — Performance targets, security/privacy expectations, i18n, accessibility, observability.
6. **Testing expectations** — What proof is required: unit/integration/E2E, coverage bar, manual verification steps.

## Rules

- Ask with AskUserQuestion; batch related questions (max 4 per round) instead of one long interrogation.
- Offer concrete options with a recommended default — users answer choices faster than open questions.
- Convert every vague answer into a verifiable statement and read it back ("So: uploads over 10 MB are rejected with a visible error — correct?").
- Write each acceptance criterion **atomic and independently testable** — one behavior per criterion. These become the per-task `Acceptance` lines in the backlog, so a criterion that bundles three behaviors forces an oversized, hard-to-review task later.
- Record assumptions you had to make as explicit "Assumed:" lines the user can veto.

## Stop condition

Stop interviewing when every acceptance criterion is **verifiable** (testable pass/fail) and the user has confirmed a written summary:

```markdown
## Requirements Summary
- Goal: …
- In scope: … / Out of scope: …
- Constraints: …
- Edge cases: …
- Non-functional: …
- Acceptance criteria: 1. … 2. … (each testable)
- Assumed: …
```
