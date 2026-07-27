# Skill-selection retrieval — kết quả đo và quyết định 2026-07-28

Tài liệu này thay phần chẩn đoán retrieval trong
`docs/skill-selection-report-2026-07-28.md`. Các số dưới đây là số đo, không phải ước lượng.

## Lệnh đo

Các bảng kết quả dùng đúng các lệnh sau:

```bash
npm test
npm run skills:eval
node scripts/skill-eval.mjs --scenarios tests/fixtures/scenarios-100.json --negatives tests/fixtures/NEGATIVES.md
node scripts/skill-eval.mjs --scenarios tests/fixtures/scenarios-multifacet.json --negatives tests/fixtures/NEGATIVES.md
node scripts/tune-sweep.mjs --out tests/fixtures/SWEEP.md
```

Hai probe chẩn đoán dùng `node --input-type=module`: probe thứ nhất import `parseCatalog`,
`buildDocFrequency`, `matchDetail` để đo score/hit shape trên index và các scenario; probe thứ hai
group kết quả `parseCatalog` theo `name` để đo duplicate. Quan sát index bị ghi đè dùng
`node scripts/build-skills-index.mjs`, sau đó chạy lại `skill-eval.mjs` trên index vừa sinh. Mỗi
phần dưới đây ghi rõ lệnh nào là nguồn của số đo.

## Chẩn đoán đã sửa

Báo cáo trước chia 13 case còn fail thành “7 recall / 6 ranking”, rồi đề xuất aliases trước và
reranker sau. Cả hai nửa của chẩn đoán đều sai. Probe `node --input-type=module` trên matcher
baseline cho thấy sáu case từng bị gọi là ranking — A09, C22, C30, F59, F60, G62 — đều có skill
đúng được kiểm tra ở score chính xác **0.0**. Chúng vắng khỏi shortlist, không phải bị xếp thấp; một
reranker trên shortlist đó sửa được **0** case.

Nguyên nhân thật nằm ở hai defect trong `scripts/skill-match.mjs`:

1. Term nhiều từ chỉ thử exact phrase, không fallback xuống từng từ thành phần. Khi exact phrase
   miss, term đóng góp score 0. Probe baseline đo `"competitor benchmark"` → skill
   `benchmark-methodology` = **0.0**.
2. Relevance floor yêu cầu `descHits >= 2`, nên không phân biệt được một từ generic bị leak với một
   từ hiếm có giá trị chẩn đoán. Cùng probe baseline đo:

| Case | Skill đúng | Score | Hit shape |
|---|---|---:|---|
| B17 | `warehouse-modeling` | 4.3 | `descHits=1` |
| F56 | `performance-marketing` | 4.6 | `descHits=1` |
| E49 | `influencer-strategy` | 4.1 | `descHits=1` |
| I82 | `product-manager` | 4.3 | `descHits=1` |

Quy tắc rút ra: **reranker không thể cứu candidate vắng mặt**. Nếu đáp án đúng của một facet không
có trong shortlist, đó là recall/coverage để Step 7 acquire-or-author xử lý, không phải ranking.

## Kết quả đo

Các run `skill-eval.mjs` đọc index xấp xỉ 656 entry. Cột “Trước” là baseline chạy cùng command trước
matcher fix; cột “Sau” là run hiện tại. Full suite lấy từ `npm test`; 32-scenario lấy từ
`npm run skills:eval`; hai suite còn lại lấy từ hai command `skill-eval.mjs` ở phần Lệnh đo.

| Chỉ số | Trước | Sau |
|---|---:|---:|
| 100-case | 87/100 | 99/100 |
| precision@1 | 78/99 | 84/99 |
| avg selection size | 2.59 | 8.01 |
| 32-scenario | 32/32 | 32/32 |
| multifacet | 4/4 | 4/4 |
| full suite | 671 pass | 694 pass |

Từ hai giá trị average selection size đo được, suy ra shortlist trung bình tăng hơn ba lần. Vì vậy
deterministic matcher phải dừng ở **shortlist**; nếu load thẳng, rule sai domain sẽ đi vào Codex
prompt. Prompt-level prune đọc output `formatShortlist`, rồi mới chuyển kết quả vào gate `LOAD` /
`VET` / `AUTHOR` hiện có.

## Ablation và quyết định bỏ floor clause

Trước T6, ablation hai yếu tố độc lập được đo hai lần và cả hai lần cho cùng kết quả dưới đây.
`node scripts/tune-sweep.mjs --out tests/fixtures/SWEEP.md` hiện chỉ lưu bảng này như historical
evidence; nó không đo lại các variant đã bị loại khỏi code:

| Variant | 100-case | precision@1 | avg selection size |
|---|---:|---:|---:|
| Không fix nào | 87/100 | 78/99 | 2.59 |
| Chỉ IDF floor | 91/100 | 78/99 | 3.28 |
| Chỉ phrase fallback | 99/100 | 84/99 | 8.01 |
| Cả hai | 99/100 | 84/99 | 8.57 |

So với phrase fallback đơn lẻ, IDF-aware floor đem lại **0** pass biên nhưng tốn thêm **0.56**
skill/request. Kết quả vẫn là 0 pass biên trên 17 scenario có term list toàn từ đơn: S01, S02, S04,
S06, S09, S10, S11, S12, S17, S18, S25, S26, S27, S28, S30, S32, D34. Đây từng là lý do có nguyên
tắc duy nhất để giữ clause; số đo đã bác bỏ giá trị thực tế của nó. Clause bị loại theo YAGNI, cùng
constant `RARE_DESC_IDF` và tracking `rareDescHit`.

## Sweep và quyết định không overfit

Cùng command `tune-sweep.mjs` hiện quét một chiều `partialFactor` qua cả ba suite và ghi kết quả
vào `tests/fixtures/SWEEP.md`. Trục `rareDescIdf` đã bị bỏ cùng floor clause; báo cáo vẫn giữ ma trận
ablation hai yếu tố pre-T6 dưới nhãn historical evidence. Giá trị ship
`partialFactor = 0.6` nằm trong plateau, không nằm trên một spike.

Trong lưới hai chiều pre-T6, một số cell từng đo được 100/100 nhưng cố ý không được chọn. Chúng đạt
100 bằng cách cứu A09 — case đã được phân loại là coverage gap, không phải retrieval failure — và
tốn thêm xấp xỉ 1 skill nhiễu cho mỗi request. Tune constant về phía answer key là đúng kiểu overfit
mà sweep được tạo ra để phát hiện.

## Lưới precision

`tests/fixtures/NEGATIVES.md` dùng format
`<term> | <skill must-not-be-top1>` và được enforce qua `--negatives` trong hai command
`skill-eval.mjs`. `checkNegatives` throw nếu rule gọi tên một skill không có trong catalog. Review đã
đo được rằng nếu không có check này, một rule gõ sai sẽ luôn xanh: lưới chỉ mang tính trang trí.

Report eval hiện in precision@1 và average selection size cạnh pass rate. Vì vậy một recall win đổi
lấy precision hoặc shortlist lớn hơn không còn bị che bởi tổng pass.

## Đã bỏ khỏi scope, có lý do đo được

`triggers:` frontmatter, `ALIASES.md`, và penalty `not_for:` bị bỏ. Hai command eval trên 100-case và
multifacet xác nhận matcher fix đã lấy lại các case vocabulary mà chúng nhắm tới:
roas/tROAS/RICE/CPM. Probe baseline của E45 — lý do duy nhất từng được nêu cho `not_for:` — đã chọn
`brand-voice` với score **21.7**, nên thay đổi đó không mua thêm pass.

## Còn treo

1. A09, flatten nested Firebase JSON, vẫn là fail duy nhất trong run 99/100 của command 100-case.
   Đây là coverage gap thật, không phải retrieval.
2. `expectAny` của B17 gọi `funnel-analytics`, nhưng probe catalog bằng
   `node --input-type=module` xác nhận tên này không có trong index. Case vẫn pass trong command
   100-case nhờ `warehouse-modeling`; expectation đã stale.
3. `buildIndex` vẫn ghi đè index bằng partial scan khi một skill root không đọc được; root mất chỉ
   sinh warning. Quan sát được: giữa phiên 2026-07-27, index bị ghi lại còn 337 entry với **toàn bộ
   plugin root vắng mặt** (bản sao: `~/.claude/skill-library/INDEX.degraded-20260727-1136.md.bak`,
   phân tích path xác nhận chỉ còn entry dưới `claude-skill-library/remote/`). **Chưa xác định được
   cái gì trigger lần rebuild đó** — không hook nào trong `~/.claude` tham chiếu
   `build-skills-index`. Điều đã xác định là *cơ chế*: đọc code `buildIndex` cho thấy root thiếu chỉ
   được push vào `warnings` rồi vẫn ghi partial scan ra file, nên một lần `~/.claude/plugins/cache`
   không đọc được là đủ để thay index đầy đủ bằng index rỗng ruột. `skill-eval.mjs` không có index
   sanity check nên vẫn chấm phần còn lại và ra một con số trông hợp lý.
4. Probe duplicate bằng `node --input-type=module` trên index 656 entry đo được 11 tên skill trùng:
   `frontend-slides` ×3, `xlsx`, `pptx`, `pdf`, `docx`, `scholar-evaluation`,
   `literature-review`, `exa-search`, `gget`, `skill-builder`, `loki-mode`. `buildIndex` không
   dedupe giữa các root; duplicate làm giảm IDF và chiếm slot shortlist. Đây là retrieval issue thật,
   cần một thay đổi riêng có số đo.
5. MCP tool `codex_skills` và embedding retrieval tiếp tục được defer.
