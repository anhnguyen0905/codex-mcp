# Skill Selection — Scope Scenario Eval Report

## Precision baseline (2026-11-11, before tail cutoff)

Measured against the live index at `/Users/danielnguyen/.claude/skill-library/INDEX.md` (720
entries), sha256 `7fdf810befd6f20089a26323cb57144783bf72fe8db68e01519777e542971513`.

| Suite | Pass | Hit@1 | MRR | Top-3 hit rate | Average selection size | Noise rate | Noisy-selection share | Labelled scenarios |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 99/100 (99.0%) | 86.9% | 0.905 | 92/99 (92.9%) | 8.20 | n/a | n/a | 0 |
| 500 | 499/500 (99.8%) | 91.6% | 0.945 | 448/464 (96.6%) | 6.35 | 54/54 (100.0%) | 86/509 (16.9%) | 54 |
| holdout | 100/100 (100.0%) | 99.0% | 0.995 | 100/100 (100.0%) | 8.20 | n/a | n/a | 0 |

The precision labels are measurement-only; selected skills and existing pass, Hit@1, MRR, and
average-selection results are unchanged.

The labels were taken from the currently selected output using a reviewed list of wrong-domain
skills, so the 100.0% noise rate is high by construction and is a before/after yardstick, not an
estimate of noise across all scenarios.

## Tail cutoff (2026-11-11)

The live-index sweep used `tuning.relativeScoreFloor` and real SKILL.md token sizing. The
cutoff is applied independently to each facet, relative to that facet's top score.

| Floor | 100 pass | 100 Hit@1 | 100 MRR | 100 top-3 | 100 avg | 500 pass | 500 Hit@1 | 500 MRR | 500 top-3 | 500 avg | 500 noisy selections | Holdout pass | Holdout Hit@1 | Holdout MRR | Holdout top-3 | Holdout avg |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.0 | 99/100 | 86.9% | 0.905 | 92/99 | 8.20 | 499/500 | 91.6% | 0.945 | 448/464 | 6.35 | 86/509 (16.9%) | 100/100 | 99.0% | 0.995 | 100/100 | 8.20 |
| 0.15 | 99/100 | 86.9% | 0.905 | 92/99 | 7.09 | 499/500 | 91.6% | 0.945 | 448/464 | 5.52 | 69/438 (15.8%) | 100/100 | 99.0% | 0.995 | 100/100 | 4.40 |
| 0.2 | 99/100 | 86.9% | 0.905 | 92/99 | 6.31 | 499/500 | 91.6% | 0.945 | 448/464 | 4.76 | 51/398 (12.8%) | 100/100 | 99.0% | 0.995 | 100/100 | 3.39 |
| 0.25 | 99/100 | 86.9% | 0.905 | 92/99 | 5.55 | 499/500 | 91.6% | 0.945 | 448/464 | 4.04 | 48/346 (13.9%) | 100/100 | 99.0% | 0.995 | 100/100 | 2.69 |
| 0.3 | 99/100 | 86.9% | 0.905 | 92/99 | 4.80 | 498/500 | 91.6% | 0.944 | 447/464 | 3.35 | 37/296 (12.5%) | 100/100 | 99.0% | 0.995 | 100/100 | 2.15 |
| 0.4 | 98/100 | 86.9% | 0.902 | 91/99 | 3.47 | 496/500 | 91.6% | 0.943 | 446/464 | 2.41 | 22/220 (10.0%) | 100/100 | 99.0% | 0.995 | 100/100 | 1.58 |
| 0.5 | 95/100 | 86.9% | 0.894 | 90/99 | 2.64 | 490/500 | 91.6% | 0.939 | 444/464 | 1.88 | 15/159 (9.4%) | 99/100 | 99.0% | 0.990 | 99/100 | 1.31 |
| 0.6 | 93/100 | 86.9% | 0.887 | 89/99 | 2.02 | 486/500 | 91.6% | 0.937 | 443/464 | 1.52 | 8/123 (6.5%) | 99/100 | 99.0% | 0.990 | 99/100 | 1.16 |
| 0.7 | 92/100 | 86.9% | 0.886 | 89/99 | 1.59 | 481/500 | 91.6% | 0.934 | 441/464 | 1.29 | 5/94 (5.3%) | 99/100 | 99.0% | 0.990 | 99/100 | 1.09 |

The chosen value is conservatively `0.2`. Both `0.2` and `0.25` preserve every baseline pass,
Hit@1, and top-3 result on all three suites, but `0.2` has the lowest noisy-selection share
among the preserving points (12.8% versus 13.9%) and keeps a margin from `0.3`, where real
passes are lost. The cutoff remains tunable through `tuning.relativeScoreFloor`. It reduces
500-suite average selection size from
6.35 to 4.76 and noisy-selection share from 86/509 (16.9%) to 51/398 (12.8%). The 500 noise
rate also falls from 54/54 (100.0%) to 40/54 (74.1%), so the scoped gate is `--max-noise 0.80`.
The measured average-size gates are `5.1` for the 500 suite and `6.7` for the 100 suite.

G69 remains intentionally unchanged. With the live index, `benchmark-methodology` scores 1.2
from only the partial `pricing research` phrase (one description hit), while
`game-designer-balance` scores 2.4 from two description hits (`pricing research` and
`bundle pricing`); neither has a name or exact phrase hit. They therefore lose to
`market-research` (9.468; exact `pricing research` plus `market comparison`) and the other
research skills. Raising single-description evidence or adding pricing aliases would be
overfitted to this scenario and risks the existing relevance-floor and negative rules.

## Per-facet selection (2026-11-11)

Before T6, the four-scenario multifacet fixture reported 4/4 pass with an average selection
size of 10.25, but it could not say whether each facet was represented. After applying the
reviewed oracle expectations, the 22-scenario fixture reports 41/42 (97.6%) per-facet coverage,
average selection size 9.41, and exit 1 because one expected facet is uncovered:

```text
MULTI_EXIT:1
Passed: 21/22 (95.5%)
Average selection size: 9.41
Per-facet coverage: 41/42 (97.6%)
```

Uncovered facet classification:

| Scenario/facet | Terms | Top five candidates (score) | Expected rank | Class |
|---|---|---|---|---|
| M07/budget | budget model; cost forecast; financial plan | cost-aware-llm-pipeline (7.99), cost-tracking (7.99), timesfm-forecasting (6.55), financial-audit (6.34), ecc-tools-cost-audit (6.17) | media-planning #10 (4.83); xlsx #15 (3.20); unit-economics #48 (1.83) | (a) expected skills are not competitive on these terms |

The M07 budget facet is a terms/description mismatch, not a multi-facet defect: the expected
skills rank below stronger cost/forecasting matches and the matcher selects the same relevant
candidate family in a direct single-facet call. No matcher change was made for this class (a)
miss.

The single-facet baselines are unchanged on the live 720-skill index: 100-suite 99/100,
Hit@1 86/99, average 6.31; 500-suite 499/500, Hit@1 425/464, average 4.76, noisy selections
51/398; holdout 100/100, Hit@1 99/100, average 3.39. Observed exits: `skills:eval:scope` 0,
`skills:eval:scope100` 0, and holdout 0.

For multifacet scenarios, Hit@1, MRR, and top-3 remain whole-scenario comparators for
continuity; per-facet coverage is the meaningful metric. M21 and M22 include intentionally
unsupported facets without `expectAny`; they are excluded from the denominator.

## Raw-request mode (2026-11-11)

Measured against the same live 720-entry index. Oracle terms are scenario terms; raw terms are
produced by `deriveTerms(scenario.request)`. Raw mode evaluates multi-facet requests as one facet.

| Suite | Terms | Pass | Hit@1 | Top-3 | Average selection size | Noisy selections |
|---|---|---:|---:|---:|---:|---:|
| 100 | oracle | 99/100 | 86/99 | 92/99 | 6.31 | n/a |
| 100 | raw | 77/100 | 54/99 | 66/99 | 6.23 | n/a |
| 500 | oracle | 499/500 | 425/464 | 448/464 | 4.76 | 51/398 |
| 500 | raw | 348/500 | 253/464 | 304/464 | 5.73 | 15/341 |
| holdout | oracle | 100/100 | 99/100 | 100/100 | 3.39 | n/a |
| holdout | raw | 83/100 | 74/100 | 79/100 | 4.34 | n/a |

The first 30 raw failures in the 500 suite were classified using A–E: A, request words absent
from every expected description; B, Vietnamese request with no English vocabulary; C, generic
words dominate or expected skill is outranked; D, expected skill is selected but beyond budget or
tail-cut; E, other.

| ID | Derived terms | Expected skills | Class |
|---|---|---|:---:|
| A02 | normalize phone; dedupe email; clean; normalize; phone; dedupe; email | exploratory-data-analysis; xlsx; polars | C |
| A03 | revenue; month; region; pivot; excel | xlsx | A |
| A06 | report rows; rows lost; merge; csvs; report; rows; lost; join | polars; exploratory-data-analysis | A |
| A10 | churn dataset; explaining; churn; dataset; stakeholders | internal-comms; article-writing | A |
| B14 | daily etl; etl pipeline; meta ads; ads api; api into; into bigquery; daily; etl; pipeline; meta; ads; api | api-connector-builder; data-throughput-accelerator; data-scraper-agent | A |
| B16 | revenue gap; gap between; between two; two sources; reconcile; revenue; gap; between; two; sources | finance-billing-ops | A |
| C24 | day churn; churn prediction; prediction model; model evaluated; day; churn; prediction; model; evaluated; auc | mle-workflow; scikit-learn; mle-reviewer | C |
| C25 | users into; into behavioural; behavioural segments; describe them; cluster; users; into; behavioural; segments; describe; them | scikit-learn; umap-learn | C |
| C26 | revenue drop; no guessing; revenue; drop; data; no; guessing | exploratory-data-analysis; statistical-analysis | C |
| C30 | topic analysis; analysis over; store reviews; sentiment; topic; analysis; over; store; reviews | transformers; regex-vs-llm-structured-text | A |
| D32 | six charts; quarterly report; right chart; chart type; type per; per metric; six; charts; quarterly; report; right; chart | d3-viz; matplotlib; seaborn; dashboard-builder | C |
| D36 | executive summary; insight first; executive; summary; charts; insight; first | internal-comms; article-writing | C |
| D37 | reusable weekly; weekly report; report template; growth team; reusable; weekly; report; template; growth; team | docx; internal-comms; theme-factory | A |
| E50 | crisis communication; communication plan; server downtime; crisis; communication; plan; server; downtime | internal-comms; crisis-communication | C |
| F59 | incrementality test; brand campaign; campaign via; via geo; geo holdout; incrementality; test; brand; campaign; via; geo; holdout | experimental-design; statistical-power | C |
| G65 | survey responses; survey; responses; age; spend | statistical-analysis; interpreting-culture-index | C |
| G69 | pricing research; common pack; pack price; price points; pricing; research; common; pack; price; points | benchmark-methodology; game-designer-balance | C |
| H74 | onboarding sequence; new users; onboarding; sequence; new; users | marketing-campaign; email-ops | C |
| H78 | press release; game launch; press; release; game; launch | article-writing; internal-comms | C |
| H80 | monthly newsletter; monthly; newsletter; community | article-writing; content-engine | C |
| J98 | vs buy; buy attribution; vs; buy; attribution | what-if-oracle; council | A |
| J99 | hr attrition; handle carefully; hr; attrition; department; pii; handle; carefully | statistical-analysis; security-review; hipaa-compliance | A |
| J100 | me improve; improve marketing; marketing effectiveness; deliberately vague; me; improve; marketing; effectiveness; deliberately; vague | none | E |
| K02 | quan ca; ca phe; du bao; bao dong; dong tien; chuan bi; bi nhap; nhap hang; hang dip; dip le; quan; ca | sme-operations | B |
| K03 | re opening; third location; fried chicken; chicken chain; me figure; figure out; sales volume; re; opening; third; location; fried | sme-operations; unit-economics | E |
| K05 | hang thoi; thoi trang; lap ke; ke hoach; hoach ton; ton kho; kho theo; theo mua; tranh het; het hang; hang dip; dip tet | inventory-demand-planning; sme-operations | B |
| K08 | xuong gia; gia cong; cong nho; nho muon; muon tinh; tinh diem; diem hoa; hoa von; dong san; san pham; pham moi; moi truoc | sme-operations; unit-economics | B |
| K11 | chu xuong; xuong may; may nho; nho muon; quy trinh; trinh chuan; chuan kiem; kiem soat; soat chi; chi phi; phi nguyen; nguyen vat | sop-authoring; sme-operations | B |
| K14 | chu tiem; tiem tap; tap hoa; hoa muon; muon lap; lap bang; bang excel; excel theo; theo doi; doi bien; bien loi; loi nhuan | xlsx; unit-economics; sme-operations | B |
| K15 | founder trying; figure out; monthly burn; burn rate; rate before; next funding; funding round; founder; trying; figure; out; runway | sme-operations | C |

| Class | Count |
|---|---:|
| A | 9 |
| B | 5 |
| C | 14 |
| D | 0 |
| E | 2 |

| Class | Two examples (derived terms → expected skills) |
|---|---|
| A | A03 `revenue, month, region, pivot, excel` → `xlsx`; A10 `churn dataset, explaining, churn, dataset, stakeholders` → `internal-comms, article-writing` |
| B | K02 `quan ca, ca phe, du bao, bao dong, dong tien, chuan bi, bi nhap, nhap hang, hang dip, dip le, quan, ca` → `sme-operations`; K05 `hang thoi, thoi trang, lap ke, ke hoach, hoach ton, ton kho, kho theo, theo mua, tranh het, het hang, hang dip, dip tet` → `inventory-demand-planning, sme-operations` |
| C | A02 `normalize phone, dedupe email, clean, normalize, phone, dedupe, email` → `exploratory-data-analysis, xlsx, polars`; C24 `day churn, churn prediction, prediction model, model evaluated, day, churn, prediction, model, evaluated, auc` → `mle-workflow, scikit-learn, mle-reviewer` |
| D | No examples in the first 30; no expected skill was selected beyond budget or solely removed by the tail cutoff. |
| E | J100 `me improve, improve marketing, marketing effectiveness, deliberately vague, me, improve, marketing, effectiveness, deliberately, vague` → no expected skills; K03 `re opening, third location, fried chicken, chicken chain, me figure, figure out, sales volume, re, opening, third, location, fried` → `sme-operations, unit-economics` |

Raw 500 pass ratio is 0.69; `skills:eval:raw` gates at 0.67 (ratio rounded down to two decimals
minus 0.02). These are baseline observations, not tuning targets.

Sample CLI (`Analyze revenue cohorts and prepare an executive report`):

```text
terms: request = revenue cohorts, executive report, revenue, cohorts, executive, report
- cohort-tail-projection score=13.0 via: revenue, cohorts
- cohort-retention-analysis score=9.3 via: cohorts
```

## Domain-mismatch signal (2026-11-11)

The live index was present (720 entries). A generic-head name-qualifier demotion improved some
synthetic shapes, but a stricter absolute floor broke the existing rare-term contract. No design
removed all four measured wrong-domain examples while preserving acceptance, so **no IMP-9
matcher change is shipped**.

| Suite | Pass | Hit@1 | Top-3 | Average selection size | Noisy selections / facet coverage |
|---|---:|---:|---:|---:|---:|
| scenarios-100 | 99/100 | 86/99 | 92/99 | 6.31 | n/a |
| scenarios-500 | 499/500 | 425/464 | 448/464 | 4.76 | 51/398 |
| scenarios-holdout | 100/100 | 99/100 | 100/100 | 3.39 | n/a |
| multifacet | 21/22 | 2/4 | 3/4 | 9.41 | 41/42 facets |
| raw 500 | 348/500 | 253/464 | 304/464 | 5.73 | 15/341 |

Designs tried and rejected (measured on the live index, 720 entries):

- **Generic-head name-qualifier demotion** — demote a candidate whose only evidence is a generic head
  word while its name carries a qualifier absent from the terms. It fixed the synthetic shapes but did
  not remove all four live examples without lowering Hit@1 beyond the allowed two scenarios.
- **Per-facet absolute evidence floor** — let a facet with only weak generic matches end empty. It broke
  the rare-term contract (a single rare exact term such as `incoterms` must still select its skill).

Open examples, kept as ledger evidence rather than precision guards: `cohort analysis` →
`clinical-decision-support`, `executive report` → `clinical-reports`, `planetary mineralogy` →
`geomaster`, `mycology classification` → `loki-mode`. The prompt-level prune in skill-selection Step 5
(wrong-domain removal) remains the control for these cases.

## Method & scope of this eval

This harness tests the **deterministic retrieval core** of skill-selection
(`scripts/skill-match.mjs`, Steps 4–5 of the skill): given the search terms a role facet
produces, does the index surface the right skill(s) within the context budget (~3% of a 200k
window, sized from each skill's real SKILL.md), and stay empty for uncovered domains? Selection
is bounded by that token budget, not a fixed skill count. Each scenario supplies the `terms` a
competent classifier would derive, then asserts on the selected set (`expectAny` / `expectNone`
/ `expectEmpty`).

What it does **not** test (these are LLM-judgment steps, verified in review, not unit tests):

- **Step 2 role classification** — turning a free-text request into facets + terms.
- **Per-facet selection for multi-facet requests** — Hit@1, MRR, and top-3 remain whole-scenario
  comparators; per-facet coverage is the meaningful metric for multi-facet scenarios.
- **Step 5 vetting and distillation** of skill content into Codex prompt blocks.

## Archive — superseded measurements (before 0.31.0)

The generated block below (index of 656 skills, 2026-07-27) is superseded by the Precision baseline,
Tail cutoff, Per-facet selection and Raw-request mode sections above. It is kept unchanged for history;
its headings are demoted one level.

- Generated: 2026-07-27T09:00:13.223Z
- Index: `/Users/danielnguyen/.claude/skill-library/INDEX.md` (656 skills)
- Scenarios: 32
- Context budget per scenario: ~6,000 tokens (≈3% of a 200k window)
- **Passed: 32/32 (100.0%)**
- **Precision@1: 27/31 (87.1%)**
- **Average selection size: 8.00**

### Results

| # | Scope | Facet | Selected skills (relevance-ranked) | ~Tokens | Verdict |
|---|-------|-------|-------------------------------------|---------|---------|
| S01 | engineering | engineering | exec-typescript, nodejs-keccak256, constant-time-analysis, mcp-builder, mcp-server-patterns | 2,737 | ✅ PASS |
| S02 | engineering | engineering | golang-patterns, golang-testing, exec-go, swift-concurrency-6-2 | 2,138 | ✅ PASS |
| S03 | engineering | engineering | exec-python, python-patterns, generating-python-installer, modern-python, python-testing, zarr-python | 3,333 | ✅ PASS |
| S04 | data-viz | data | d3-viz, matplotlib, using-tmux-for-interactive-commands, claude-d3js-skill, scientific-visualization, etetoolkit, seaborn | 4,200 | ✅ PASS |
| S05 | data-analysis | data | polars, polars-bio, dask, exploratory-data-analysis, vaex, flowio, optimize-for-gpu, astropy, exec-deliverable, matlab | 6,000 | ✅ PASS |
| S06 | data-analysis | data | statistical-analysis, statistical-power, statsmodels, ai-regression-testing, clinical-decision-support, experimental-design, geomaster, matlab, matplotlib, peer-review | 6,000 | ✅ PASS |
| S07 | data-analysis | data | exploratory-data-analysis, neurokit2, scanpy, autoskill, astropy, exec-deliverable, matlab, neuropixels-analysis, statistical-analysis, aeon | 6,000 | ✅ PASS |
| S08 | marketing | marketing | market-research-reports, market-research, benchmark-methodology, competitive-report-structure, prediction-market-oracle-research, ito-market-intelligence, clinical-reports, session-report, game-designer-systems, game-director | 5,896 | ✅ PASS |
| S09 | product | product | product-manager, product-capability, plan-backlog, product-lens, carrier-relationship-management, citation-management, logistics-exception-management, project-manager, returns-reverse-logistics | 5,400 | ✅ PASS |
| S10 | design | design | frontend-design, frontend-design-direction, frontend-slides, frontend-slides, frontend-slides, expo-tailwind-setup, frontend-a11y, frontend-patterns, web-artifacts-builder, api-design | 6,000 | ✅ PASS |
| S11 | design | design | frontend-slides, frontend-slides, frontend-slides, scientific-slides, golden-html, golden-html-kw, golden-html-multi, pptx, pptx, theme-factory | 6,000 | ✅ PASS |
| S12 | security | security | libfuzzer, atheris, coverage-analysis, aflpp, ffuf-web-fuzzing, fuzzing-dictionary, fuzzing-obstacles, cargo-fuzz, genotoxic, golang-testing | 6,000 | ✅ PASS |
| S13 | security | security | semgrep-rule-creator, semgrep, semgrep-rule-variant-creator, audit-augmentation, sarif-parsing, Trail of Bits Security Skills, yara-rule-authoring, audit-prep-assistant, laravel-verification, quarkus-verification | 6,000 | ✅ PASS |
| S14 | security | security | solana-vulnerability-scanner, algorand-vulnerability-scanner, cairo-vulnerability-scanner, ton-vulnerability-scanner, cosmos-vulnerability-scanner, substrate-vulnerability-scanner, entry-point-analyzer, firebase-apk-scanner, guidelines-advisor, property-based-testing | 6,000 | ✅ PASS |
| S15 | bioinformatics | data | bulk-rnaseq, pydeseq2, scanpy, scvi-tools, arboreto | 3,000 | ✅ PASS |
| S16 | bioinformatics | data | scanpy, anndata, cellxgene-census, bulk-rnaseq, scvelo, scvi-tools, arboreto, geniml, hugging-science, pathway-enrichment | 6,000 | ✅ PASS |
| S17 | document | document | pdf, pdf, nutrient-document-processing, docx, docx, golden-pdf, golden-pdf-ch, golden-pdf-kw, liteparse, investor-materials | 5,983 | ✅ PASS |
| S18 | document | document | xlsx, docx, docx, xlsx, golden-word, DroneZombie_Building, markitdown, nutrient-document-processing | 4,800 | ✅ PASS |
| S19 | testing | engineering | quarkus-tdd, springboot-tdd, tdd-workflow, test-driven-development, golang-testing, exec-self-testing, kotlin-testing, perl-testing, python-testing, rust-testing | 5,757 | ✅ PASS |
| S20 | testing | engineering | property-based-testing, fsharp-testing, kotlin-testing, rust-testing, hypothesis-generation, swift-protocol-di-testing, testing-handbook-generator, arbor, hypogenic, statistical-analysis | 6,000 | ✅ PASS |
| S21 | debugging | engineering | systematic-debugging, quality-nonconformance, agent-introspection-debugging, click-path-audit | 2,400 | ✅ PASS |
| S22 | scientific-writing | product | scientific-writing, citation-management, paper-lookup, bgpt-paper-search, research-lookup, venue-templates, parallel-web, scholar-evaluation, peer-review, scientific-critical-thinking | 6,000 | ✅ PASS |
| S23 | ml | data | pytorch-lightning, pytorch-patterns, pyhealth, transformers, shap, histolab, scanpy, get-available-resources, pennylane, geniml | 6,000 | ✅ PASS |
| S24 | reinforcement-learning | data | stable-baselines3, pufferlib, continuous-learning-v2, agent-architecture-audit, agent-eval, agent-harness-construction, agent-introspection-debugging, agent-payment-x402, agent-self-evaluation, agent-sort | 5,903 | ✅ PASS |
| S25 | chemistry | data | rdkit, datamol, molecular-dynamics, molfeat, rowan | 3,000 | ✅ PASS |
| S26 | quantum | data | qiskit, cirq, pennylane, qutip | 2,400 | ✅ PASS |
| S27 | game-design | product | game-designer-balance, game-director, game-designer-systems | 1,800 | ✅ PASS |
| S28 | game-design | product | game-designer-systems, game-designer-balance, game-director, project-manager, pufferlib, design-system, latency-critical-systems, flox-environments, hexagonal-architecture, swift-protocol-di-testing | 5,990 | ✅ PASS |
| S29 | mobile | engineering | react-native-patterns, expo-ui, expo-router, expo-web-to-native, expo-native-ui, expo-brownfield, expo-tailwind-setup, expo-data-fetching, eas-observe, expo-dom | 6,000 | ✅ PASS |
| S30 | browser-automation | engineering | webapp-testing, playwright-skill, browser-qa, automation-audit-ops, macos-terminal-window-automation, netmiko-ssh-automation | 3,600 | ✅ PASS |
| S31 | multi-facet | data+marketing | market-research, market-research-reports, prediction-market-oracle-research, dashboard-builder, marketing-campaign, d3-viz, scientific-visualization, ito-market-intelligence, game-designer-systems, game-director | 5,885 | ✅ PASS |
| S32 | uncovered | engineering | _(none)_ | 0 | ✅ PASS |

### Precision guard

✅ Precision regression net passed.
