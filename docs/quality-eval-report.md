# Quality evaluation report

This report measures deliverable quality per profile and language before any Phase 3 change
lands. It contains aggregates only. The real holdout cases live outside this repository
(`~/.codex-mcp/quality-holdout/`), and the repository holds only their hash manifest
(`tests/fixtures/quality/holdout-manifest.json`).

## Baseline — 2026-11-14 (multiscope Phase 3, T7)

- Harness: `scripts/quality-eval.mjs` and `scripts/quality-grade.mjs` at `7ad1077`; rubric `schemaVersion` 1.
- Holdout: 22 real cases (18 data, 2 design, 2 plan; 11 vi, 11 en). The owner approved the set,
  and it is frozen by hash.
- Dev: 32 synthetic cases (`tests/fixtures/quality/dev-cases.json`). The owner approved the set.
- Graders:
  - layer 1 is the mechanical grader;
  - layer 2 is the blind Codex grader, which uses opaque item keys and seed = case index. It ran
    as one batch session per split. Its verdicts fill only the items that layer 1 leaves `n/a`;
  - layer 3 is owner calibration.

### Holdout — profile × language

| Profile | Language | n | Rubric % (mechanical) | Rubric % (mechanical + Codex) | Evidence pass % | Language pass % |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| data | vi | 9 | 0.0% | 80.0% | n/a | 0.0% |
| data | en | 9 | 88.9% | 97.8% | n/a | 88.9% |
| design | en | 1 | 16.7% | 28.6% | n/a | n/a |
| design | vi | 1 | 33.3% | 42.9% | n/a | n/a |
| plan | vi | 1 | 50.0% | 50.0% | n/a | n/a |
| plan | en | 1 | 0.0% | 0.0% | n/a | n/a |

### Dev — profile × language

| Profile | Language | n | Rubric % (mechanical) | Rubric % (mechanical + Codex) | Evidence pass % | Language pass % |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| data | en | 7 | 85.7% | 80.0% | n/a | 85.7% |
| data | vi | 7 | 57.1% | 85.7% | n/a | 57.1% |
| design | en | 3 | 100.0% | 100.0% | n/a | n/a |
| design | vi | 3 | 100.0% | 100.0% | n/a | n/a |
| plan | en | 3 | 100.0% | 100.0% | n/a | n/a |
| plan | vi | 3 | 100.0% | 100.0% | n/a | n/a |
| content | en | 3 | 100.0% | 100.0% | n/a | n/a |
| content | vi | 3 | 91.7% | 91.7% | n/a | n/a |

The combined dev column uses 31 of 32 Codex verdicts. One verdict was unparsable and was
excluded (see below).

### Grader accuracy

Accuracy is reported per class (fail recall, pass agreement, balanced accuracy). Raw accuracy is
not used: most labels are `pass`, so a grader that passes everything would score about 0.94.

| Grader | Set | Items compared | Fail recall | Pass agreement | Balanced accuracy |
| --- | --- | ---: | ---: | ---: | ---: |
| Mechanical | dev | 98 | 0.417 | 1.000 | 0.708 (constant-pass: 0.500) |
| Codex (blind) | dev, judgment items | 62 | 0.800 | 1.000 | 0.900 |
| Codex (blind) | dev, all items | 156 | 0.714 | 0.941 | 0.828 |

- Codex on dev:
  - 1 of 32 verdicts was unparsable (a line break inside a quote), and the fail-closed parser
    rejected it;
  - every quote occurs verbatim in its deliverable;
  - it missed 3 of 4 seeded language-mixing defects and passed the placeholder-risk trap.
- Codex on the holdout:
  - all 22 verdicts parsed;
  - it marked every data item `pass` on all 18 data cases;
  - 16 of 112 quotes (14%) do not occur verbatim in the deliverable, because the batch session
    read long deliverables only partly;
  - on the language item it agrees with the mechanical check on 22 of 38 items. Codex passes
    the 9 Vietnamese analytics reports that the mechanical check fails.
- Owner calibration (R1.5):
  - sample: 3 seeded-sample data cases × 4 judgment items = 12 items;
  - owner–Codex agreement 12/12 = 100%, so the status is **calibrated**;
  - caveat: every sampled item was `pass` on both sides, so this sample cannot show whether the
    grader fails a weak real report.

### Reading the baseline

- On real Vietnamese analytics reports, the language check is the dominant failing signal
  (0 of 9 pass). The reports keep standard analytics jargon (for example payer, cohort,
  retention) untranslated.
  - The game-analytics pack glossary must move this cell.
  - The pack gate must read the language pass % per cell, not only the rubric %.
- The blind Codex grader separates synthetic defects but passes every real data report. On
  real data the gate should rest on mechanical checks and owner-graded pairs, not on the Codex
  rubric % alone.
- Each design and plan cell has n = 1, which is too small for any claim.

### Unchecked

- Holdout `data.reproducible` and `data.sourced` have no evidence manifests, so only the Codex
  grader judged them.
- Holdout requests were reconstructed from each report's scope, because the original requests
  were not recorded. The owner approved them as reconstructed.
- Codex grades come from one batch session per split, not from isolated per-case runs.
- The holdout has no content-profile cases.

## Re-baseline under the first-use gloss rule — 2026-11-15 (multiscope Phase 4, T10)

- Method: the same harness was run twice on the same 22-case holdout and 32-case dev set with the same Codex verdicts (holdout: one batch of 22 verdicts; dev: 31 verdicts; seed = case index): once with the language checker at `0dd47a6` (every bare English term is a finding) and once with the Phase 4 checker (first-use gloss: bare uses after a `<Vietnamese term> (<English term>)` gloss are accepted). The old run reproduces the 2026-11-14 baseline tables exactly, cell for cell.
- Owner calibration was not repeated.

### Holdout — profile × language

| Profile | Language | n | Rubric % mechanical old → new | Rubric % mechanical + Codex old → new | Language pass % old → new |
| --- | --- | ---: | ---: | ---: | ---: |
| data | vi | 9 | 0.0% → 0.0% | 80.0% → 80.0% | 0.0% → 0.0% |
| data | en | 9 | 88.9% → 88.9% | 97.8% → 97.8% | 88.9% → 88.9% |
| design | en | 1 | 16.7% → 16.7% | 28.6% → 28.6% | n/a |
| design | vi | 1 | 33.3% → 33.3% | 42.9% → 42.9% | n/a |
| plan | vi | 1 | 50.0% → 50.0% | 50.0% → 50.0% | n/a |
| plan | en | 1 | 0.0% → 0.0% | 0.0% → 0.0% | n/a |

### Dev — profile × language

| Profile | Language | n | Rubric % mechanical old → new | Rubric % mechanical + Codex old → new | Language pass % old → new |
| --- | --- | ---: | ---: | ---: | ---: |
| data | en | 7 | 85.7% → 85.7% | 80.0% → 80.0% | 85.7% → 85.7% |
| data | vi | 7 | 57.1% → 57.1% | 85.7% → 85.7% | 57.1% → 57.1% |
| design | en | 3 | 100.0% → 100.0% | 100.0% → 100.0% | n/a |
| design | vi | 3 | 100.0% → 100.0% | 100.0% → 100.0% | n/a |
| plan | en | 3 | 100.0% → 100.0% | 100.0% → 100.0% | n/a |
| plan | vi | 3 | 100.0% → 100.0% | 100.0% → 100.0% | n/a |
| content | en | 3 | 100.0% → 100.0% | 100.0% → 100.0% | n/a |
| content | vi | 3 | 91.7% → 91.7% | 91.7% → 91.7% | n/a |

### Reading

- No cell moved.
- On the 9 Vietnamese data holdout deliverables the number of language findings is identical before and after, and none of them writes any listed English term inside parentheses (0 glosses), so the first-use rule had nothing to accept — these deliverables were produced without the gloss instruction.
- The rule's effect can only show on deliverables that gloss, which is what the Phase 4 gate (pack v0.2) measures.
- The baseline numbers therefore stand unchanged for the gate's pack-off comparison.

### Quote provenance

- Re-checking the stored Codex verdicts with `verifyQuotes`, 16 of 112 holdout quotes (14.3%) were not found in the deliverable after whitespace normalisation; dev: 0 unverified.
- Those 16 verdicts' evidence is unverified, which supports treating the Codex grader as uncalibrated on real data.

## Pack gate — game-analytics 0.1.0 (2026-11-14, multiscope Phase 3, T12)

**Decision: FAIL. `PACKS_DEFAULT` stays `'off'`** (`scripts/profile-router.mjs`).

### Method

- Eligible cases were analytics holdout cases whose result tables total ≤ 1 MB, which gave 6 vi and 4 en.
- A seeded, stratified sample picked 4 cases: 2 vi, 2 en.
- For each case, Codex rewrote the deliverable twice from the same result tables (CSV/JSON only, never the original report):
  - pack off: the exec-deliverable standards block;
  - pack on: the same prompt plus the pack standards block.
- That makes 8 runs, within the cap of 6 per branch. Every run used an isolated directory outside the repository, labelled with a random id.
- Grading:
  - mechanical grader first;
  - the blind Codex grader filled the items that were `n/a`. It ran as one batch session. Two verdicts were rejected fail-closed because a quote exceeded 200 characters, and were re-graded blind with a shorter quote limit;
  - the owner graded 3 sampled pairs. Pair 1 was no longer blind when graded; pairs 2 and 3 were blind.

### Result

| Case | Language | Rubric % off | Rubric % on | Items down | Language pass off → on |
| --- | --- | ---: | ---: | ---: | --- |
| c1 | vi | 80.0% | 80.0% | 0 | fail → fail |
| c2 | vi | 80.0% | 80.0% | 0 | fail → fail |
| c3 | en | 100.0% | 100.0% | 0 | pass → pass |
| c4 | en | 60.0% | 80.0% | 0 | pass → pass |
| **Mean (n = 4)** |  | **80.0%** | **85.0%** | **max 0** | **2/4 → 2/4** |

| Gate criterion | Required | Observed | Met |
| --- | --- | --- | --- |
| Rubric mean on − off | ≥ +10 pp | +5.0 pp | no |
| No case down more than 1 item | ≤ 1 | 0 | yes |
| Evidence pass not lower | not lower | n/a (no evidence manifests) | n/a |
| Language pass not lower | not lower | 2/4 → 2/4 | yes |
| Grader calibrated | owner agreement ≥ 80% | owner–Codex direction agreement 0/3 pairs | no |
| Usable cases | ≥ 3 | 4 | yes |

### Reasons

- **Rubric gain below threshold.** The only gain is one English case (+20 pp). Both Vietnamese cases are unchanged.
- **The language cell did not move.** With the pack, untranslated-jargon findings in the two Vietnamese reports dropped by about half, but neither report reached zero findings, so the binary language item stays `fail`.
  - The pack says "gloss on first use", while `language-check` flags every bare occurrence, including later ones. The two rules conflict and must be reconciled before a pack v0.2.
- **The owner preferred the pack-off report in both blind pairs.**
  - In one, the pack version stated the requested cohort window in its summary but used the tables' different window, mentioning the mismatch only at the end.
  - In the other, the pack-off version had a more actionable test plan.
- In the non-blind pair, the owner preferred the pack version for its explicit numerators, denominators and definitions.
- **The blind Codex grader missed every preference.** It called two pairs ties and leaned the other way on the third. Its rubric % alone cannot decide a pack.

### Unchecked

- Evidence items: the regenerated reports have no evidence manifests.
- Design, plan and content packs: out of scope.
- Run-to-run variance: each branch ran once per case.

## Pack gate 2 — game-analytics 0.2.0 (2026-11-15, multiscope Phase 4, T11)

**Decision: FAIL. `PACKS_DEFAULT` stays `'off'`** (`scripts/profile-router.mjs`).

### Method

- 3 analytics holdout cases never used by a gate (2 vi, 1 en) were sampled before any run with seed 20261115 (sha256(seed:id) ranking within a 4-case vi pool and a 2-case en pool).
- Each case × branch (pack off / pack 0.2.0 on) ran 2 times: 12 reports from isolated Codex sessions on the same result tables and prompt, with the on branch adding only the pack standards block.
- Grading used a mechanical grader, plus a blind Codex grader in one isolated session per report (opaque item keys, single-line quotes ≤ 200 chars, quote provenance check).
- First pass: 4 of 12 verdicts were unusable for format (2 without the fenced json block, 2 with quotes over 200 chars); those 4 were re-graded once, blind, with a format reminder only. 1 of 12 stayed unusable (text after the fenced block) and that report is scored on mechanical items only.
- The owner blind-graded 3 A/B pairs (run 1 of each branch per case, A/B order randomised and hidden); Codex blind-picked the same 3 pairs.

### Result

| Case | Language | Rubric % off: mean of 2 runs (spread) | Rubric % on: mean (spread) | Items down (max over runs) | Language pass off → on |
| --- | --- | ---: | ---: | ---: | --- |
| c1 | vi | 70.0% (20.0) | 60.0% (0.0) | 1 | 0/2 → 0/2 |
| c2 | vi | 60.0% (0.0) | 60.0% (0.0) | 1 | 0/2 → 0/2 |
| c3 | en | 100.0% (0.0) | 100.0% (0.0) | 0 | 2/2 → 2/2 |
| **Mean (n = 3)** |  | **76.7%** | **73.3%** | **max 1** | **2/6 → 2/6** |

Mean run-to-run spread: off 6.7 pp, on 0.0 pp.

### Gate criteria

| Criterion | Required | Observed | Met |
| --- | --- | --- | --- |
| Rubric mean on − off | ≥ +10 pp | −3.4 pp | no |
| No case down more than 1 item | ≤ 1 | 1 | yes |
| Language pass not lower | not lower | 2/6 → 2/6 | yes |
| Owner prefers pack-on | ≥ 2/3 pairs | 1/3 (one on, one off, one tie) | no |
| Codex pair calibration (recorded, not blocking) | ≥ 2/3 agreement with owner | 1/3 agreement → uncalibrated | n/a |

Before the format re-grade the rubric delta was −10.0 pp with 4 verdicts missing; the decision does not depend on the re-grade (the owner criterion fails either way).

### Reasons

- Rubric moved the wrong way (−3.4 pp).
- The owner did not prefer the pack (1/3).
- Pack v0.2 improves gloss behaviour but not enough to pass the language check.
- The Codex grader agrees with the owner on 1/3 pairs and stays uncalibrated, so its rubric items are weak evidence.

### Diagnostics

- Across the Vietnamese runs (4 per branch), pack-on lowered language-check findings from 68 to 52 and distinct flagged terms from 23 to 10, and glossed listed terms 8 times versus 0 off — the first-use rule is being followed partly — but every Vietnamese run in both branches still used at least one English term bare before its first gloss, so language pass stayed 0/4 vs 0/4.
- Quote provenance: 6 of 55 Codex quotes (10.9%) were not found in the report.

### Unchecked

- n = 3 cases, 2 runs per branch.
- Owner pairs compare run 1 only.
- One report scored mechanical-only.
- No evidence manifests (evidence pass n/a).
- Codex sessions saw real holdout data (approved design; outputs stay local).
