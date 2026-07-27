# PARTIAL_FACTOR one-dimensional sweep

- Generated: 2026-07-27T08:58:07.846Z
- Index: `/Users/danielnguyen/.claude/skill-library/INDEX.md` (656 parsed entries)
- Integrity check: 657 non-heading lines; 277 `plugins/cache/ecc` entries
- Suites: 32-case (32), 100-case (100), multifacet (4)
- Shipped value: `partialFactor=0.6` (★)

The live sweep is one-dimensional because T6 removed the IDF-aware floor after its measured
ablation contributed zero marginal passes and increased average selection size.

## Seven-cell sweep

Every row reports all three suite pass counts plus aggregate precision@1 and average selection
size. A ❌ marks any row below the mandatory 32/32 gate regardless of its other metrics.

| partialFactor | 32-case | 100-case | multifacet | precision@1 (all suites) | avg selection (all suites) |
|---:|---:|---:|---:|---:|---:|
| ✅ 0.3 | 32/32 | 99/100 | 4/4 | 113/134 | 8.05 |
| ✅ 0.4 | 32/32 | 99/100 | 4/4 | 114/134 | 8.05 |
| ✅ 0.5 | 32/32 | 99/100 | 4/4 | 113/134 | 8.05 |
| ★ 0.6 | 32/32 | 99/100 | 4/4 | 113/134 | 8.05 |
| ✅ 0.7 | 32/32 | 98/100 | 4/4 | 113/134 | 8.05 |
| ✅ 0.8 | 32/32 | 98/100 | 4/4 | 114/134 | 8.05 |
| ✅ 1 | 32/32 | 98/100 | 4/4 | 115/134 | 8.05 |

**Verdict: the shipped partialFactor 0.6 sits inside a one-dimensional plateau; both adjacent cells pass the 32/32 gate and stay within one aggregate case.** Neighbours: 0.5=135/136, 0.7=134/136.

## Historical two-factor ablation (pre-T6 recorded evidence)

These values were measured before T6 and are preserved as historical evidence. They are **not**
freshly measured by this run: T6 removed the IDF-aware floor clause, `RARE_DESC_IDF`, and
`rareDescHit`, so the floor-only and both variants are no longer reachable.

| Variant | 32-case | 100-case | multifacet | precision@1 (100-case) | avg selection (100-case) |
|---|---:|---:|---:|---:|---:|
| neither fix | 32/32 | 87/100 | 4/4 | 78/99 (78.8%) | 2.59 |
| IDF floor only | 32/32 | 91/100 | 4/4 | 78/99 (78.8%) | 3.28 |
| phrase fallback only | 32/32 | 99/100 | 4/4 | 84/99 (84.8%) | 8.01 |
| both | 32/32 | 99/100 | 4/4 | 84/99 (84.8%) | 8.57 |

The matrix measured zero marginal passes from the floor over phrase fallback, at +0.56 average
selection size. That dominated result is why T6 removed the clause and why the live sweep now
has only one axis.

## Method

The index was read and parsed once, then the same entry array and cached SKILL.md token sizer
were reused for all seven sweep cells. Pass checks, precision@1, the 6,000-token budget, and
the capped `ceil(file characters / 4)` sizing match `skill-eval.mjs`.
The sweep is exhaustive only over the requested partialFactor values; reported results are
measurements, not a claim of a global optimum.
