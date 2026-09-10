---
description: "PDCA brainstorm: Claude frames a thesis, Codex attacks it in read-only debate rounds, both converge on a ratified decision record — no code is written"
argument-hint: "<question, decision, or idea to brainstorm>"
---

# Codex Brainstorm — Plan, Do, Check, Act with two-way debate

Topic: $ARGUMENTS

This is a thinking workflow, not a shipping workflow. Claude (Fable) owns the THESIS and the
decision record; Codex (Astra) is the independent critic. Nobody writes implementation code, every
Codex call runs `sandbox: read-only`, and none of the full flow's control files
(`.codex-flow/STATE.md`, `TASKS.md`, slices, reports, ledgers) are created or touched. The
deliverable is `DECISION.md`; the user ratifies it before anything is handed off.

**Load skills first**: `codex-flow:brainstorm-debate` (Astra prompt blocks, fail-closed json
contract, response format, scoring schema, ledger, stop rule). If it cannot be loaded, STOP and
tell the user to reinstall the codex-flow plugin; never improvise the protocol from memory.

**Run dir**: `.codex-flow/brainstorm/<YYYYMMDD-HHMMSS>/` from the session-start local time.
Create it without `-p` on the leaf; when it already exists, append `-2`, `-3`, … and never reuse a
directory. This run writes ONLY `BRIEF.md`, `DEBATE.md` (append-only), and `DECISION.md` in that
dir plus one line in `.codex-flow/notes/brainstorm.log`. Nothing else in the workspace changes.

## Plan — frame the question (Claude)

1. **Health gate, once**: call `mcp__codex__codex_health` with `{ deep: true }`. Keep
   `authMode` for the `model` rule below; when the field is absent, treat it as `chatgpt`. When the call fails, `loggedIn` is false, or
   `execProbe` is `quota | model | error`, quote the message and use AskUserQuestion once:
   **Fix Codex and re-check**, or **single-model brainstorm** — a fresh independent Claude
   subagent (Agent tool, general-purpose) plays Astra with the same prompt blocks, and every
   artifact, the log line, and the delivery summary are labelled `single-model`. Never degrade
   silently, and never present a single-model run as a two-model debate.
2. **Frame** with at most 3 AskUserQuestion questions, skipping any the topic already answers:
   what kind of decision this is, the hard constraints, and what "decided" looks like. Read the
   tail of `.codex-flow/notes/brainstorm.log` when it exists and report the recent median
   `rounds=` so the user can pick a round cap (1–3, default 3).
3. **Write `BRIEF.md`**: `## Question`, `## Context` (for code topics, gather paths and line
   anchors through an Explore subagent — conclusions with `path:line`, no raw file dumps),
   `## Constraints`, `## Decision criteria` (`K1..K5`, integer weights summing to 100, per the
   skill's scoring schema), `## Out of scope`, and `## Provenance` (project root,
   `git rev-parse HEAD`, the full `git status --porcelain` output or "not a git repo",
   session-start ISO 8601, round cap, `mode: two-model | single-model`).
4. **Write the THESIS** as `## Thesis` in `DEBATE.md`: 2–3 candidate options, one preliminary
   recommendation tied to the criteria, and the 3 strongest objections you can already see
   against your own recommendation. Objections are the hypothesis the Do phase tests. Astra
   is not consulted here: it gets BRIEF.md, the thesis, and read access in Do, and may attack
   the framing itself there (FRAMING challenges), so the frame stays independent of the critic.

## Do — test the thesis under attack (Codex ⇄ Claude, 1–3 rounds)

Each round is one Astra turn plus one Fable response. Start a **fresh** session per Astra turn so
the critic never defends its own earlier wording; `mcp__codex__codex_continue` is used only for
the json re-obtain step in `codex-flow:brainstorm-debate`.

1. **Astra turn** — `mcp__codex__codex_execute` with:
   - `prompt`: header `Run position: brainstorm — round <n> of <cap>` plus the absolute paths of
     the run dir's BRIEF.md and DEBATE.md (so Astra reads them instead of guessing), then BRIEF.md, the
     current THESIS, the normalized transcript within the skill's transcript budget, and the
     skill's **Standards block** verbatim. Round 1 additionally asks Astra to read the files
     BRIEF.md cites before challenging them.
   - `cwd`: absolute project root; `sandbox`: `read-only`; `reasoningEffort`: `high`;
     `model`: only when `authMode` is `apikey`, otherwise omit it; `timeoutMs`: 20 minutes per
     attempt (the server may add bounded auto-resume attempts); `terminal`: `true`; no
     `verifyCommand`.
2. **Read `status` first**. `success` → continue. `partial`, `failed`, `aborted`, a timeout, or
   quota/model signatures in `errors`/`stderr` → read `attempts` and `resumeReasons`, never
   retry on your own, and use AskUserQuestion once per outage: **retry this turn once** (one
   extra `codex_execute` after auto-resume is exhausted; offered only for the first outage of the
   run), **continue single-model** for the remaining turns (label everything from here on), or
   **stop and decide from the completed rounds**. Record the outcome in DEBATE.md.
3. **Parse fail-closed** per the skill: save `agentMessage` verbatim under `## Round <n>` in
   `DEBATE.md` with the `sessionId`, run `debate-parse.mjs --kind round --round <n>` on it, and
   follow the skill's exit-code routing (one re-obtain, then `UNVERIFIED`). Then verify every
   claim Astra makes about the codebase by reading the cited file or running a read-only
   command before it can enter the ledger; list the commands you ran in the round section.
4. **Fable response** in the skill's format: one `ACCEPT | REBUT | REFINE` line per open
   challenge (reclassifying as FRAMING any challenge aimed at BRIEF.md, prefixed or not), the
   critique of Astra's alternative, the admission or merge decision, any BRIEF.md
   amendment from an accepted FRAMING challenge, the rewritten `## Thesis`, and
   `Changed this round:`. Append it to the same round section.
5. **Convergence check** per the skill's stop rule. Converged, or round `<cap>` done → Check.
   Otherwise start the next round with the updated thesis and transcript.

## Check — reconcile and sign off (Claude, then a fresh Codex session)

1. Write the **ledger** table per the skill into DEBATE.md under `## Ledger`; every row's
   evidence is a `path:line`, a command, or a document, never a recollection.
2. Write the **score table** per the skill's scoring schema under `## Scores`: every surviving
   option on every criterion, one evidence reference per cell, weighted totals.
3. **Sign-off** — one `mcp__codex__codex_execute` in a fresh session with the skill's
   **Sign-off block**, BRIEF.md, DEBATE.md and the two tables, same payload rules as a Do turn.
   Apply the Do step-2 outage procedure if it fails. Parse with
   `debate-parse.mjs --kind signoff` under the same exit-code routing. Fix every verified
   misattribution in the ledger and the scores; apply `pending[]` verdicts per the skill's stop
   rule (CONFIRM closes a round-cap acceptance, HOLD reopens it); copy `dissent` verbatim. In
   single-model mode the fresh Claude subagent signs off.
4. **No-code integrity check** (mechanical): run `git status --porcelain` and compare it with
   the snapshot in BRIEF.md `## Provenance`. Any changed tracked path or new untracked path other
   than this run dir and `.codex-flow/notes/brainstorm.log` is a blocker: report the paths, do
   not enter Act until the user has reverted or explained them, and record the outcome in
   DEBATE.md. Outside a git repo, state that the check was unavailable.

## Act — ratify, hand off, feed back (Claude)

1. Write `DECISION.md` with `Status: PROPOSED` and these sections: `## Recommendation`,
   `## Rationale` (tied to criteria and ledger ids), `## Rejected options` (the challenge that
   killed each), `## Unresolved` (OPEN, UNVERIFIED and pending rows with the evidence that would
   settle them, or "none"), `## Astra dissent` (verbatim, or "none"), `## Handoff` (chosen
   option, verifiable requirement bullets, affected paths and components, contracts touched,
   acceptance checks, assumptions, risks with settling evidence, rollout and rollback notes,
   owner, provenance copied from BRIEF.md), and `## Mode` (`two-model` or `single-model`).
2. AskUserQuestion once: **accept** (or **accept with the listed unresolved risks** when
   `## Unresolved` is not "none"), **amend**, **reject**, or **one more round** (only while the
   cap allows). Accept or reject sets `Status:` to `ACCEPTED` or `REJECTED`. **One more round**
   returns to Do and then re-runs Check in full — new ledger, scores, and a fresh sign-off — before
   DECISION.md is rewritten. **Amend** that changes the recommendation, an option, or a ledger
   status reopens Check the same way; a wording-only amend is applied and the question re-asked.
   Nothing is handed off while `PROPOSED`.
3. On accept, offer the next step without executing it: run
   `/codex-flow <topic> — start from <run dir>/DECISION.md ## Handoff` for feature work, its
   small-change lane for a ≤ 2-file change, or park the decision. The user runs the handoff.
4. **Feed back**: append one line to `.codex-flow/notes/brainstorm.log`:
   `<ISO 8601> <one-line topic> rounds=<n> flips=<n> blockers=<n> mode=<two-model|single-model> status=<accepted|rejected|parked> dir=<run dir>`.
   `flips` counts recommendation changes; the Plan step of later runs reads this log to size the
   round cap. Then deliver a summary: the decision, the ledger counts per status, the dissent,
   the integrity-check result, and the run dir.

Rules:
- Never write, edit, or generate implementation code in this workflow; the only files written are
  the three run-dir files and the log line, and the Check integrity step proves it.
- Never pass a `model` override under ChatGPT auth; steer with `reasoningEffort`.
- Never re-grade a severity, reconstruct a dropped challenge from prose, or soften a dissent.
- Never switch to single-model mode silently or mid-turn; one AskUserQuestion per outage.
- Never run more than one manual retry per run, and never a fourth debate round.
