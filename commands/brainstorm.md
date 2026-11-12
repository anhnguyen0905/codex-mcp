---
description: "Systems-thinking brainstorm: frame the question, map the system independently with Codex, reason through a two-way debate, check feasibility, deliver a ratified analysis — no code is written"
argument-hint: "<question, decision, or idea to brainstorm>"
---

# Codex Brainstorm — Frame, Map, Reason, Feasibility, Decide

Topic: $ARGUMENTS

This is a thinking workflow, not a shipping workflow. Claude (Fable) owns the analysis and Codex
(Astra) supplies independent maps, challenges, and feasibility checks. Nobody writes implementation
code. Every Codex call runs `sandbox: read-only`. The deliverable is `ANALYSIS.md`; the user
ratifies it before anything is handed off.

**Load skills first**: `codex-flow:brainstorm-debate`, `codex-flow:brainstorm-lenses`, and
`codex-flow:brainstorm-argumentation`. If any skill cannot be loaded, STOP and tell the user to
reinstall the codex-flow plugin; never improvise the protocol, lenses, or argumentation from memory.

**Run dir**: `.codex-flow/brainstorm/<YYYYMMDD-HHMMSS>/` from the session-start local time.
Create the parent directories `.codex-flow/brainstorm/` and `.codex-flow/notes/` when missing; create
the leaf without `-p` on the leaf. When it already exists, append `-2`, `-3`, … and never reuse a
directory. This run writes only `FRAME.md`, `MAP.md`, `REASON.md` (append-only), and `ANALYSIS.md`
in that dir plus one line in `.codex-flow/notes/brainstorm.log`. Nothing else in the workspace
changes.

## Frame — understand the question (Claude)

1. **Health gate, once**: call `mcp__codex__codex_health` with `{ deep: true }`. Keep `authMode`
   for the `model` rule below; when the field is absent, treat it as `chatgpt`. If the call fails,
   `loggedIn` is false, or `execProbe` is `quota | model | error`, quote the message and use
   AskUserQuestion once: **retry once** (first outage only), **continue single-model**, or **stop**.
   A single-model run uses a fresh independent Claude subagent
   with the same prompt blocks; label every artifact, log line, and summary `single-model`, and
   never present a single-model run as a two-model debate.
2. **Frame** with at most 3 AskUserQuestion questions, skipping any the topic already answers:
   identify the decision, hard constraints, and what "decided" means. Read the tail of
   `.codex-flow/notes/brainstorm.log` when it exists, suggest a round cap from recent `rounds=`
   values, and let the user choose 1–3 (default 3).
3. Apply the Frame lens from `codex-flow:brainstorm-lenses`. Write `FRAME.md` with SCQA and an
   empty Answer, the mess or problem, treatment (absolve, resolve, solve, or dissolve), CATWOE,
   the system boundary, constraints, and provenance: project root, `HEAD`, session start, round
   cap, and mode. `No option or recommendation is written in this phase.`

## Map — model the system independently (Claude, then Codex)

1. Apply the Map lens from `codex-flow:brainstorm-lenses`. Write `MAP.md` with `## Fable map`
   before the Astra call. Do not write an option or recommendation. The map names the system
   structure and its evidence, not an intervention.
2. Call `mcp__codex__codex_execute` in one fresh read-only Astra session with a prompt header
   `Run position: brainstorm — Map` and only the absolute path of the run dir's `FRAME.md`,
   followed by the Map turn block, the Map lens, and `FRAME.md`. The Map prompt names no run-dir
   file except FRAME.md. Parse the answer with `debate-parse.mjs --kind map --file <tmp path>` and
   follow the skill's fail-closed routing.
3. Append the raw Astra answer verbatim under `## Astra map` in `MAP.md`. If the turn remains
   unparsed after the one re-obtain, write `## Astra map` as `unparsed: <parseError>` with the raw
   answer, list dropped map entries by their `droppedReasons`, and mark every Divergence entry from
   Astra's side `UNVERIFIED`. Write `## Divergence` with agreed, only Fable, only Astra, and conflict
   entries. This divergence is the input of Reason.
4. After `## Divergence`, Fable writes `## Map critique` per the skill and carries every map conflict
   into the round-1 Reason prompt.
5. `No option or recommendation is written in this phase.`

## Reason — build and test the argument (Claude ⇄ Codex, 1–3 rounds)

1. Apply the Reason lens from `codex-flow:brainstorm-lenses`. Fable writes the pyramid thesis in
   `REASON.md`: one governing answer, MECE supports with evidence, 2–3 options, and second-order
   consequences. The thesis uses the Frame, Map, and Divergence records.
2. For each round, call `mcp__codex__codex_execute` in one fresh Astra session with a prompt header
   `Run position: brainstorm — Reason round <n> of <cap>` and the absolute paths of the run dir's
   `FRAME.md`, `MAP.md`, and `REASON.md`, followed by the Reason turn block and the Reason lens block;
   the Debate block is also embedded verbatim. In round 1, include every Map critique conflict in
   the prompt. Parse the answer with
   `debate-parse.mjs --kind round --round <n> --file <tmp path>`. Follow the skill's response
   format for Fable's answer and append the raw answer verbatim under the round in `REASON.md`.
3. For Fable's answer, update the standpoint ledger and assumption register each round, and stop per
   the skill's stop rule. Before a codebase claim enters
   the standpoint ledger or assumption register, verify it by reading the cited file or running a
   read-only command. Record the evidence and the check. Record remaining standpoints and evidence
   gaps under Open questions.

## Feasibility — can it be done (Codex, one turn)

1. If a recommendation survives Reason, make `exactly one Astra turn` on `only the surviving
   recommendation`: call `mcp__codex__codex_execute` in a fresh session with a prompt header
   `Run position: brainstorm — Feasibility` and the absolute paths of the run dir's `FRAME.md`,
   `MAP.md`, and `REASON.md`, followed by the Feasibility turn block and the Feasibility lens block.
   Parse the answer with `debate-parse.mjs --kind feasibility --file <tmp path>`, following the
   skill's fail-closed routing. If the turn remains unparsed after the one re-obtain, record the
   verdict as `UNVERIFIED` in `ANALYSIS.md` `## Feasibility` and log `feasibility=unverified`. After
   the Astra turn, Fable writes `## Feasibility critique` per the skill and puts remaining
   disagreements in `## Open questions`.
2. A NOT-FEASIBLE verdict returns to Reason at most once. That return uses one Reason round within
   the cap, then re-runs Feasibility and Decide. When the cap is already spent, Fable revises the
   thesis without a new Astra turn and records that under Open questions. When no recommendation
   survives Reason, skip the Astra turn and record that fact under Open questions.

## Decide — ratify the analysis (Claude)

1. Use the standpoint ledger and assumption register per the skill, then write `ANALYSIS.md` with first line `Status:
   PROPOSED` and these sections in order: `## Reframed question`, `## System map`, `## Reasoning`,
   `## Agreements and disagreements`, `## Recommendation`, `## Feasibility`, `## Open questions`,
   `## Sources`. Build `## Agreements and disagreements` from the standpoint ledger and assumption
   register; include each `UNRESOLVED` standpoint's Crux and list high-importance low-certainty
   assumptions first; copy Astra's last non-null `dissent` verbatim and never soften it. `## Open
   questions` lists UNRESOLVED standpoints with their Crux, UNVERIFIED entries recorded per the skill,
   and high-importance low-certainty assumptions first, with the evidence that would settle each.
   `## Sources` lists every `file:line`, command, and `prior-art:` reference cited.
2. Use one AskUserQuestion with **accept / amend / reject / one more round**.
   1. One more round is offered only while the Reason round cap leaves room (never a fourth
      round); it returns to Reason for one round, then re-runs Feasibility and Decide.
   2. Amend that changes the recommendation re-runs Feasibility then Decide; a wording-only
      amend is applied and the question is re-asked.
   3. Reject sets `REJECTED`.
   4. Accept sets `ACCEPTED`, then offers, without executing it, `/codex-flow <topic> — start
      from <run dir>/ANALYSIS.md` or parking the analysis. The log `status=` is `accepted`,
      `rejected`, or `parked` accordingly.
   Nothing is handed off while `PROPOSED`.
3. Append this line to `.codex-flow/notes/brainstorm.log` verbatim:
   `<ISO 8601> <one-line topic> rounds=<n> flips=<n> blockers=<n> feasibility=<verdict> mode=<two-model|single-model> status=<accepted|rejected|parked> dir=<run dir>`.
   Set `rounds` to Reason rounds run, `flips` to recommendation changes, `blockers` to BLOCKER
   claims raised, and `feasibility` to the verdict or `skipped`. Then deliver a summary of the
   analysis, claims, feasibility, open questions, mode, and run dir.

Rules:
- Never write, edit, or generate implementation code in this workflow; write only the four run-dir
  artifacts and the log line.
- For every Astra turn, save the raw answer verbatim to a temporary file outside the workspace
  created with `mktemp`; parse it with `debate-parse.mjs --kind <kind> … --file <tmp path>` per
  the skill, append the raw answer verbatim to the phase file (`MAP.md` under `## Astra map`,
  `REASON.md` under the round or Feasibility turn), then delete the temporary file.
- Embed the matching turn block and lens block verbatim in every Astra prompt; Codex cannot read Claude's skills.
- For every Codex call, use `cwd`: the absolute project root; `sandbox`: `read-only`;
  `reasoningEffort`: `high`; `model`: only when `authMode` is `apikey`, otherwise omit it;
  `timeoutMs`: 20 minutes per attempt; and `terminal`: `true`. Use no verify command.
- Read `status` first on every Astra result. For `partial`, `failed`, `aborted`, timeout, or
  quota/model errors, read `attempts` and `resumeReasons`; use one AskUserQuestion per outage:
  retry once (first outage only), continue single-model, or stop and decide from completed turns.
  Record it.
- Start a **fresh** session per Astra turn. `mcp__codex__codex_continue` is used only for the json
  re-obtain step. Never pass a `model` override under ChatGPT auth.
- Never reconstruct a dropped entry from prose, re-grade severity, or present a single-model run as
  a two-model debate. Never run more than one manual retry per run or a fourth Reason round.
