# Evidence v2 validation

Evidence v2 is validated with a fully synthetic Vietnamese purchase-funnel fixture for the fictional game Sky Courier by fictional studio Cloud Kite. It uses the invented app id `com.example.skycourier`, regions R01–R10, and bundle_a through bundle_h; all dates, counts, reasons, and rates are invented. The fixture has 47 figures, 8 tables, 10 claims, and no ignored measured numbers. Figure commands derive from Q01–Q10 CSV cells or arithmetic over those cells, and breakdown reconciliation is tested against Q02 totals.

The clean and mutation/seed coverage is implemented in [`tests/evidenceSyntheticReport.test.ts`](../tests/evidenceSyntheticReport.test.ts).

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

The seed table is intentionally generic so it documents checker behavior without preserving report-specific data.
