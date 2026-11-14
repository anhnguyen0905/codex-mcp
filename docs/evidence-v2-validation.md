# Evidence v2 validation

Evidence v2 was validated on a real pilot purchase-funnel report and its Q01–Q10 result CSVs (46 figures, 8 tables, 10 claims, 7 structural `ignoreNumbers` literals; figure commands derived from cited CSV cells or arithmetic over those cells). The real report and its data are not kept in this public repository; an anonymized fixture replaces them (multiscope Phase 3, R5.1).

| Seed | Change | v1 pilot outcome | v2 expected check | v2 observed |
|---|---|---|---|---|
| a | Change the headline conversion-rate anchor | caught | anchor-mismatch | caught |
| b | Swap one country's conversion rate with another real value | passed under v1 (pilot run 2) | anchor-mismatch | caught |
| b2 | Same swap and remove anchor | n/a | unanchored-number | caught |
| c | Empty one claim's sources | caught | claim-unsourced or claim-no-figure | caught |
| d | Change one table cell by 1 | caught | table-mismatch | caught |
| e | Swap an anchored failure-reason share with another real value | passed under v1 (pilot run 2) | anchor-mismatch | caught |
| f | Append an invented percentage sentence | caught | unanchored-number | caught |
| mutation | Transform every numeric CSV cell with `round(x*1.5+1, 4)` | n/a | every figure mismatches | caught |
| g | Change one source CSV cell | n/a | figure-mismatch and table-mismatch | caught |

The unit-level regressions for seeds b and e live in `tests/evidenceCheck.test.ts` with synthetic values.
