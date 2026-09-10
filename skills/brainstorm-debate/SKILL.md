---
name: brainstorm-debate
description: Two-way debate protocol for the brainstorm command — the Astra critic and sign-off blocks to embed into read-only Codex prompts, the fail-closed json contract parsed by debate-parse.mjs, Fable's response format, anti-sycophancy rules, the scoring schema, the convergence ledger, the transcript budget, and the stop rule.
---

# Brainstorm debate protocol (embed into Codex prompts)

The brainstorm command produces a decision, not code. Claude (Fable) holds the THESIS; Codex
(Astra) attacks it and may propose ONE alternative; Fable answers every challenge with evidence;
the two converge or record dissent. Codex cannot see Claude's skills, so these blocks are the only
channel that tells Astra how to argue — embed the matching block verbatim in every prompt.

## Standards block (Do phase, one fresh session per turn)

```
Debate rules (mandatory — you are Astra, the independent critic; the workspace is read-only):
- Attack the thesis, do not polish it. No praise, no restating it back.
- Every challenge is numbered C<n> and carries four fields: Claim; Evidence or reasoning
  (cite file:line, a doc, a measurement, or prior art — "I think" is not evidence); Severity
  BLOCKER | MAJOR | MINOR; What would change my mind (a concrete, checkable condition).
- BLOCKER = the recommendation fails a stated decision criterion or constraint. MAJOR = a real
  risk or a missing option that could flip the recommendation. MINOR = everything else.
- The framing is fair game: a challenge may target BRIEF.md itself — a criterion, a weight, a
  constraint, or an out-of-scope line that tilts the decision. Prefix its Claim with FRAMING:
- Ids are global across the debate: reuse an existing C<n> when you HOLD or CONCEDE it, and
  number genuinely new challenges onward from the last id in the transcript. Re-raising a
  conceded point without new evidence is a defect.
- For each earlier challenge: HOLD (name the new evidence that keeps it open) or CONCEDE (name
  the evidence that settled it). A challenge Fable marked ACCEPT is closed only when you confirm
  the rewritten thesis actually removes it; otherwise HOLD it with the gap named.
- Alternative: propose at most ONE option you prefer, argued with the same four fields, and
  ONLY together with a BLOCKER or MAJOR that applies to every option in the thesis; otherwise
  write "Alternative: none".
- Never invent facts about the codebase; read the file before citing it. BRIEF.md and DEBATE.md
  live at the run-dir paths given in the prompt header. For a non-code topic, cite prior art by
  name (author, year, title) and mark it `prior-art:`; unfetched prior art is still evidence.
- End with exactly ONE fenced json block and nothing after it:
  {"round":<n>,"challenges":[{"id":"C1","severity":"BLOCKER|MAJOR|MINOR",
  "status":"NEW|HOLD|CONCEDE","claim":"..."}],"alternative":"...or null","dissent":"...or null"}
```

## Sign-off block (Check phase, fresh session)

```
Sign-off rules (mandatory — read-only; you did not take part in the debate):
- Read BRIEF.md, DEBATE.md, the convergence ledger and the score table. Check every ledger row
  against the transcript: right status, right owner, evidence really present. Check every score
  cell has evidence.
- Report misattributions only; do not reopen the debate or add new challenges.
- For every ledger row marked `ACCEPTED-BY-fable (pending)`, judge whether the final thesis
  really removes the challenge: CONFIRM (name where) or HOLD (name the gap). This is the only
  place a round-cap acceptance gets closed.
- State DISSENT when the recommendation does not follow from the ledger and the criteria.
- End with exactly ONE fenced json block and nothing after it:
  {"round":"signoff","misattributions":[{"id":"C3","expected":"OPEN","observed":"AGREED",
  "evidence":"..."}],"pending":[{"id":"C2","verdict":"CONFIRM|HOLD","evidence":"..."}],
  "dissent":"...or null"}
```

## Parse every Astra output fail-closed

Save `agentMessage` verbatim to DEBATE.md, then run the helper on that text:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/debate-parse.mjs" --kind round --round <n> --file <path>`
(or `--kind signoff`). If the helper is not found, STOP and tell the user to reinstall the
codex-flow plugin (its scripts/ directory is required). Exit 2 is a usage or read failure:
surface it and STOP. Exit 0 → the printed `challenges[]` (or `misattributions[]` and `pending[]`), `alternative`
and `dissent` ARE Astra's turn; ids, severity and status come from there, claim and evidence text
from the prose under the same id. Exit 1 → `parsed: false` or `dropped > 0`: read
`parseError`/`droppedReasons`, then do ONE re-obtain with `mcp__codex__codex_continue` on that
turn's `sessionId` asking only for the corrected json block, and parse again. This does not count
as a round. Still exit 1 → for a round turn the dropped or unparsed challenges enter the ledger
as `UNVERIFIED`; for the sign-off, DECISION.md `## Astra dissent` records
`sign-off incomplete: <parseError or n dropped>` and Act is blocked until the user waives it. In
both cases the raw output stays in DEBATE.md and the user is told.
Never reconstruct an entry from the prose.

## Fable's response format

Answer every open `C<n>` in order, one line each, before touching the thesis:

- `C<n> ACCEPT — <what changes in the thesis>` — the challenge stands; revise. A BLOCKER stays
  `ACCEPTED-BY-fable (pending)` until the next Astra turn or the sign-off confirms the rewrite
  removed it.
- `C<n> REBUT — <checkable evidence>` — the challenge fails; cite what you verified.
- `C<n> REFINE — <partial change> / <what still stands>` — split the difference explicitly.

A challenge whose target is a BRIEF criterion, weight, constraint, or scope line is FRAMING even
when Astra omitted the prefix; Fable reclassifies it and says so. A FRAMING challenge Fable accepts changes BRIEF.md, not the thesis: amend the criterion, weight,
constraint, or scope line, record the before/after under `Changed this round:`, and score in Check
against the amended BRIEF. Map a restated challenge onto its existing id before counting anything
as new. Critique Astra's
alternative with the same four-field `C<n>` format, numbering onward from the last id. Admit the
alternative as an option only when its admission condition holds; merge a near-duplicate into the
option it resembles and say so. Cap the option set at 4. Then rewrite the THESIS and append
`Changed this round:`. A changed recommendation counts as one **flip**.

## Anti-sycophancy rules (bind both sides)

- A concession names the evidence that caused it; "fair point" alone is a defect.
- A rebuttal cites something Fable checked in this session: a file read, a read-only command,
  a document, or a measurement — never memory of the codebase. On a non-code topic, named prior
  art (`prior-art:` author, year, title) counts, fetched when a fetch tool is available; the
  ledger labels it so a reader can tell it from in-session verification.
- Fable never re-grades a severity; disagreement with a severity is itself a REBUT with evidence.
- A claim neither side could check goes to `UNVERIFIED`, never to `AGREED`.

## Transcript budget

Each Astra prompt embeds BRIEF.md, the current THESIS, the debate block, and a normalized
transcript: the ledger so far plus the previous round's dispositions. Estimate tokens as chars/4.
When the transcript exceeds 6 000 estimated tokens, embed only the ledger and the last round and
point at `DEBATE.md` for the rest; never raise the budget.

## Scoring schema (Check phase)

BRIEF.md names criteria `K1..K5` with integer weights that sum to 100. Fable scores every option
on every criterion on a 0–3 scale (0 fails, 1 weak, 2 meets, 3 exceeds) and puts one evidence
reference per cell (a ledger id, `path:line`, or command); a cell without evidence scores 0 and is
marked `?`. Total = Σ weight × score. The recommendation is the top total or explains, per
criterion, why it is not. The sign-off checks the cells.

## Convergence ledger (written in Check)

```markdown
## Ledger
| Id | Claim | Raised by | Status | Evidence |
| C1 | ... | astra | AGREED / CONCEDED-BY-astra / ACCEPTED-BY-fable (pending) / CONFIRMED-BY-signoff / OPEN / UNVERIFIED | path:line, command, or prior-art: |
```

`OPEN` rows carry both positions and the one observation that would settle them. Astra's final
`dissent` is copied verbatim into DECISION.md, never summarized or softened.

## Stop rule

A round is one Astra turn plus Fable's response. Minimum 1 round, cap 3; the Check sign-off is
not a round. **Converged** means no BLOCKER or MAJOR row is `OPEN`, `UNVERIFIED`, or
`ACCEPTED-BY-fable (pending)`. Stop when converged or at the cap. At the cap, the sign-off's
`pending[]` verdicts close or hold the last round's acceptances (CONFIRM → `CONFIRMED-BY-signoff`,
HOLD → `OPEN`); rows still open go to DECISION.md `## Unresolved` and it stays `PROPOSED` until
the user accepts with those risks named. Expect the cap to be reached: Astra confirms an
acceptance only in a later turn. Never run a fourth round.
