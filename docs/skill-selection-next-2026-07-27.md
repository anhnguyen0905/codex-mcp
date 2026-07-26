# Skill selection — hướng improve tiếp (2026-07-27)

Trạng thái hiện tại (đã đo, không phải giả định):

| Chỉ số | Giá trị |
|---|---|
| Index | 640 entry (294 trusted / 318 remote `vetted:false` / 9 URL pointer) |
| Eval gốc 32 scenario | 32/32 |
| 100 case non-engineering (`.codex-flow/skill-selection-test/scenarios-100.json`) | 62/100 |
| Đã làm hôm nay | plugin roots vào index (362→640), Step 7 acquire-or-author, facet 5→11, stemming (59→62) |

38 case còn fail đã phân loại trong `.codex-flow/skill-selection-test/IMPLEMENTED.md` §4:
phần lớn là **thiếu skill thật** (performance marketing, unit economics, warehouse modeling…),
một phần nhỏ là **giới hạn của matcher**.

Nguyên tắc chọn hướng: cái gì đo được trên harness thì làm trước; cái gì cần hạ tầng mới thì hoãn
đến khi số liệu chững lại. Mọi thay đổi phải giữ eval gốc **32/32**.

---

## P1 — Mechanical, đo được ngay trên harness

### 1. IDF weighting (khả năng là win lớn nhất còn lại)

Hiện `NAME_WORD=5 / DESC_WORD=2` phẳng: term `"analysis"` và term `"incrementality"` cùng giá trị.
Hệ quả: skill mô tả chung chung ("statistical analysis of research data") đè skill chuyên biệt, và
top-3 bị chiếm bởi những entry match từ phổ thông. Trên index 640 entry, IDF tính một lần lúc build
là đủ.

- Thay điểm word/phrase bằng `base × idf(term)`, `idf = log(N / df(term))`, df đếm trên description
  của toàn index; ghi df vào INDEX.md header hoặc file `IDF.json` cạnh index.
- Giả thuyết: sửa được các case dạng D32 (`chart type/data visualization` → hiện `(none)`), C22
  (`hypothesis-generation` đè `statistical-analysis`), G62 (`market-research` đè
  `benchmark-methodology`).
- Đo: 100-case + 32-case. Rủi ro: term siêu hiếm do người dùng viết sai chính tả được thổi điểm →
  chặn bằng cap `idf ≤ 3×`.

### 2. Selection theo từng facet, có sub-budget

Chính eval hiện tại đã ghi nhận giới hạn này (S31): một list term gộp làm facet mạnh chiếm hết
top-3, facet yếu biến mất. SKILL.md đã yêu cầu "select per facet", nhưng `selectSkills()` chỉ nhận
một list phẳng — tức là **doc và code không cùng contract**.

- `selectSkills(entries, { facets: [{ name, terms }] }, { tokenBudget })`: chạy ranking mỗi facet,
  chia budget theo số facet, merge và dedupe.
- Sửa đúng các case cross-domain (J91, J92, J95, A10, D36) — nơi nửa yêu cầu là code, nửa là content.
- Đo: thêm scenario multi-facet vào cả hai file eval.

### 3. `triggers:` / `not_for:` trong frontmatter skill

Vốn từ business không nằm trong description là nguyên nhân gốc của nhóm F (roas, cac, payback,
tROAS, geo holdout). Không thể sửa description skill của người khác, nhưng **có thể sửa skill mình
tự viết (Step 7d)** và thêm lớp alias cho skill người khác.

- `triggers: [roas, cpi, cac, payback, bidding, media plan]` → index thành cột thứ 4, matcher tính
  điểm ngang name-hit.
- `not_for: [brand voice, tone]` trên `brand-guidelines` → penalty, dập đúng bẫy "name match ≠
  domain match" (case E45).
- Với skill third-party không sửa được: file `~/.claude/skill-library/ALIASES.md`
  (`<skill> | <trigger terms>`), merge lúc build. Rẻ, không xâm phạm file gốc.

### 4. Regression net: negative pairs

Từ 38 fail + các noise đã biết, sinh `NEGATIVES.md` dạng `<term> | <skill must-not-be-top1>`
(`sql | expo-examples`, `seo | eas-observe`, `brand voice | brand-guidelines`). Cho harness fail nếu
vi phạm. Đây là thứ giữ cho IDF/alias không phá precision khi tune tiếp.

## P2 — Hạ tầng, làm sau khi P1 chững

### 5. Batch vetting có triage rủi ro (mở khoá 318 entry)

Gate `vetted` đang chặn `market-research-reports`, `what-if-oracle`, `exploratory-data-analysis`,
`statistical-power`, `xlsx`, `pptx`. Vet tay từng file nên chưa ai làm → gate = chặn tất.

- `--vet-repo <dir>`: scan mọi SKILL.md trong repo, chấm rủi ro bằng pattern (fetch URL lạ, "ignore
  previous instructions", verb exfiltrate/upload, base64 blob dài, lệnh ghi ngoài workspace).
- Sạch + repo nằm trong allowlist nguồn (anthropics/skills, trailofbits/skills) → auto-vet, pin
  sha256 + commit như hiện tại. Có cờ → đưa vào danh sách người đọc.
- Giữ nguyên bản chất pin theo nội dung: `git pull` đổi file → tự về `vetted:false`.

### 6. Gap ledger đóng vòng lặp

`~/.claude/skill-library/GAPS.md`: mỗi lần Step 7d phải tự viết skill, hoặc một facet về 0, append
một dòng (ngày, request, facet, term, hành động). Rồi:

- `skills:eval` đọc GAPS.md để sinh scenario mới → coverage tự lớn theo việc thật đang làm.
- Có số liệu trả lời "library đang thiếu gì nhất" thay vì cảm giác.

### 7. Selection thành MCP tool (`codex_skills`)

Hiện selection phụ thuộc model nhớ và làm đúng 7 step. Đưa phần deterministic (Step 1, 4, 5 budget)
vào server: input = request/facets, output = ranked skills + đường dẫn block distilled + lý do loại.
Lợi: log được, test được, không drift theo model; model chỉ còn làm việc nó giỏi (classify + distill
+ vet). Effort trung bình, đây là bước "biến quy trình thành code".

### 8. Tín hiệu hữu ích hậu kiểm

Phase 5 ghi lại: skill nào được embed, review có bắt lỗi vi phạm rule của skill đó không. Skill
không bao giờ ảnh hưởng output → hạ prior hoặc bỏ. Cần đổi `session-report`; giá trị dài hạn.

## P3 — Cân nhắc, hiện chưa nên

### 9. Embedding retrieval

Sẽ giải quyết tổng quát vấn đề đồng nghĩa (roas ↔ return on ad spend) mà alias phải làm tay. Nhưng
cần model local + build embedding index + invalidation theo sha256, và không chạy được trong một
prompt stateless. Chỉ đáng làm nếu sau P1 mà vẫn còn một lớp miss kiểu "đúng khái niệm, khác từ".
Theo KISS/YAGNI: lexical + IDF + alias curated trước.

### 10. Pre-author 14 skill đang thiếu

`performance-marketing`, `media-planning`, `unit-economics`, `marketing-attribution`,
`causal-inference`, `warehouse-modeling`, `event-taxonomy`, `survey-design`, `aso`,
`localization-copy`, `okr-planning`, `creative-brief`, `influencer-strategy`, `data-quality-checks`.

Step 7d sẽ tự viết khi flow chạy tới. Viết trước 3 cái phủ nhiều case nhất
(`performance-marketing`, `unit-economics`, `media-planning` → 10 case) là hợp lý, nhưng đây là
**việc nội dung domain**, nên chạy trong một flow có review chứ không nhét vào PR hạ tầng này.

---

## Thứ tự đề xuất

1. IDF weighting (#1) — đo ngay, kỳ vọng lớn nhất
2. Per-facet selection (#2) — sửa mismatch doc↔code
3. `triggers:`/`ALIASES.md` (#3) + `NEGATIVES.md` (#4) — vốn từ + lưới precision
4. Batch vet có triage (#5)
5. Gap ledger (#6)
6. Rồi mới xét MCP tool (#7) / embedding (#9)

Mỗi bước: chạy `npm run skills:eval` (phải giữ 32/32) và bộ 100 case; ghi số trước/sau vào
`.codex-flow/skill-selection-test/`. Không tune bằng cảm giác.
