# Skill Selection — Scope Scenario Eval Report

- Generated: 2026-07-13T16:25:03.768Z
- Index: `/Users/danielnguyen/.claude/skill-library/INDEX.md` (348 skills)
- Scenarios: 32
- Context budget per scenario: ~6,000 tokens (≈3% of a 200k window)
- **Passed: 32/32 (100.0%)**

## Results

| # | Scope | Facet | Selected skills (relevance-ranked) | ~Tokens | Verdict |
|---|-------|-------|-------------------------------------|---------|---------|
| S01 | engineering | engineering | exec-typescript, constant-time-analysis, mcp-builder | 1,537 | ✅ PASS |
| S02 | engineering | engineering | exec-go | 338 | ✅ PASS |
| S03 | engineering | engineering | exec-python, modern-python, zarr-python | 1,533 | ✅ PASS |
| S04 | data-viz | data | d3-viz, using-tmux-for-interactive-commands, matplotlib | 1,800 | ✅ PASS |
| S05 | data-analysis | data | polars, exploratory-data-analysis, polars-bio, astropy, matlab, dask | 3,600 | ✅ PASS |
| S06 | data-analysis | data | statistical-analysis, statistical-power, statsmodels | 1,800 | ✅ PASS |
| S07 | data-analysis | data | exploratory-data-analysis, astropy, matlab | 1,800 | ✅ PASS |
| S08 | marketing | marketing | market-research-reports | 600 | ✅ PASS |
| S09 | product | product | product-manager, plan-backlog, project-manager | 1,643 | ✅ PASS |
| S10 | design | design | frontend-design, frontend-slides, frontend-slides, canvas-design, experimental-design, expo-tailwind-setup, web-artifacts-builder | 4,200 | ✅ PASS |
| S11 | design | design | frontend-slides, frontend-slides, scientific-slides, golden-html, golden-html-kw, golden-html-multi, pptx, pptx, theme-factory | 5,400 | ✅ PASS |
| S12 | security | security | libfuzzer, coverage-analysis, atheris, ffuf-web-fuzzing, fuzzing-dictionary, fuzzing-obstacles, aflpp, cargo-fuzz, genotoxic, ruzzy | 6,000 | ✅ PASS |
| S13 | security | security | semgrep-rule-creator, semgrep, semgrep-rule-variant-creator, audit-augmentation, sarif-parsing, Trail of Bits Security Skills, audit-prep-assistant, yara-rule-authoring | 4,800 | ✅ PASS |
| S14 | security | security | algorand-vulnerability-scanner, cairo-vulnerability-scanner, solana-vulnerability-scanner, ton-vulnerability-scanner, cosmos-vulnerability-scanner, substrate-vulnerability-scanner, entry-point-analyzer, firebase-apk-scanner, guidelines-advisor, property-based-testing | 6,000 | ✅ PASS |
| S15 | bioinformatics | data | bulk-rnaseq, scanpy, scvi-tools | 1,800 | ✅ PASS |
| S16 | bioinformatics | data | scanpy, anndata, cellxgene-census, bulk-rnaseq, scvelo, scvi-tools, arboreto, geniml, hugging-science | 5,400 | ✅ PASS |
| S17 | document | document | pdf, pdf, docx, docx, golden-pdf, golden-pdf-ch, golden-pdf-kw, liteparse | 4,783 | ✅ PASS |
| S18 | document | document | xlsx, xlsx, docx, docx, golden-word, markitdown | 3,600 | ✅ PASS |
| S19 | testing | engineering | exec-self-testing, test-driven-development, constant-time-testing, mutation-testing, property-based-testing, testing-handbook-generator, webapp-testing | 3,957 | ✅ PASS |
| S20 | testing | engineering | property-based-testing, hypothesis-generation, constant-time-testing, exec-self-testing, mutation-testing, testing-handbook-generator, webapp-testing, hypogenic | 4,557 | ✅ PASS |
| S21 | debugging | engineering | systematic-debugging | 600 | ✅ PASS |
| S22 | scientific-writing | product | citation-management, scientific-writing, paper-lookup, bgpt-paper-search, research-lookup | 3,000 | ✅ PASS |
| S23 | ml | data | pytorch-lightning, pyhealth, shap, histolab, scanpy, get-available-resources, pennylane | 4,200 | ✅ PASS |
| S24 | reinforcement-learning | data | stable-baselines3, pufferlib, pi-agent | 1,800 | ✅ PASS |
| S25 | chemistry | data | rdkit, molecular-dynamics, datamol, molfeat | 2,400 | ✅ PASS |
| S26 | quantum | data | qiskit, cirq, qutip, pennylane | 2,400 | ✅ PASS |
| S27 | game-design | product | game-designer-balance, game-director, game-designer-systems | 1,800 | ✅ PASS |
| S28 | game-design | product | game-designer-systems, game-designer-balance, game-director, project-manager, pufferlib | 3,000 | ✅ PASS |
| S29 | mobile | engineering | expo-ui, expo-router, expo-web-to-native, expo-brownfield, expo-tailwind-setup, expo-native-ui, expo-data-fetching, eas-observe, Expo Skills, expo-app-clip | 6,000 | ✅ PASS |
| S30 | browser-automation | engineering | playwright-skill, webapp-testing | 1,200 | ✅ PASS |
| S31 | multi-facet | data+marketing | market-research-reports | 600 | ✅ PASS |
| S32 | uncovered | engineering | _(none)_ | 0 | ✅ PASS |

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
- **Per-facet selection for multi-facet requests** — the mechanical run scores one combined
  term list, so a strong facet can crowd out a weak one (see S31: only the marketing skill
  surfaces from a combined list; the skill instructs the model to select per-facet instead).
- **Step 5 vetting and distillation** of skill content into Codex prompt blocks.

