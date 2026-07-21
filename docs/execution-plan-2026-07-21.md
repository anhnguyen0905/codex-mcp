# Execution Plan — Full Pipeline Hardening (2026-07-21)

Nguồn: `docs/full-pipeline-review-2026-07-21.md`. Trước khi lập plan, toàn bộ finding đã được re-verify độc lập trên working tree hiện tại.

---

## Phần 1 — Đánh giá bản review

### 1.1 Kết quả xác minh

**22/22 claim có evidence đều được xác nhận đúng** trên source hiện tại (10 blocker P0, 7 finding crawler, 4 finding release/QA, cùng các chi tiết phụ). Không có finding nào đã được fix từ thời điểm review. Đây là bản review chất lượng cao: evidence chính xác đến từng dòng, không phóng đại, phân vai rõ.

Một đính chính nhỏ:

- **CI matrix**: review viết "chỉ build và chạy Vitest trên Node 20/22" — thực tế CI đã chạy matrix **3 OS (ubuntu/macos/windows) × Node 20/22**. Phần thiếu (coverage gate, pack smoke, Python matrix) vẫn đúng, nhưng nền matrix OS đã có sẵn, giảm effort cho các gate mới.

### 1.2 Những điểm review có thể cải thiện thêm (bổ sung của lần đánh giá này)

1. **Lẫn scope crawler vào P0 production**: `fb-video-crawler` đang bị gitignore (`.gitignore:15`), là demo/prototype, không phải runtime dependency của MCP. Đặt "sửa crawler" thành P0 ngang hàng với blocker của MCP server làm mờ critical path. Cần một **scope decision** trước: descope (đánh dấu experimental, sửa README promise) hoặc promote (track trong git + CI + fix full). Go-live của MCP không nên bị block bởi crawler.

2. **Thiếu platform-specific cho process-tree cleanup**: khuyến nghị "kill process group" chỉ đúng POSIX. Trên Windows không có process group tương đương — cần `taskkill /pid <pid> /T /F`. Codebase đã claim hỗ trợ Windows (CI chạy windows-latest), plan phải cover cả hai.

3. **Rủi ro lockfile trong thư mục OneDrive**: workspace này nằm trong OneDrive-synced folder. Nếu đặt cross-process lease file **bên trong workspace**, OneDrive sync có thể tạo conflict copy, delay lstat, hoặc resurrect file đã xoá → lease sai. Lease nên nằm ở `~/.codex-mcp/locks/<hash(realpath(cwd))>.json`, ngoài mọi thư mục sync.

4. **Schema validation theo version Codex CLI là hướng brittle**: Codex CLI release nhanh (hiện 0.144.x), pin strict schema sẽ gãy liên tục. Hướng bền hơn: **tolerant parsing + completion invariant + counters** — bắt buộc thấy completion marker, đếm `parseErrors`/`unknownEvents` và surface ra payload, chỉ fail-closed khi invariant vỡ, không reject event lạ.

5. **Thiếu quản lý breaking change**: thêm `status: success|partial|failed|aborted` và semantics mới cho `truncated` sẽ đổi hành vi client (Claude prompt hiện tại đọc `isError`). Cần `schemaVersion` trong payload ngay từ wave đầu và cập nhật đồng bộ command/skill prompt đọc kết quả.

6. **Đã verify tính khả thi fix argv→stdin**: `codex exec` hỗ trợ prompt qua stdin (`codex exec -` hoặc pipe). Fix #10 làm được ngay, không cần chờ upstream.

7. **Thiếu effort/dependency/quick-wins**: review có roadmap P0/P1/P2 nhưng không có thứ tự phụ thuộc, ước lượng, hay nhóm "sửa trong một buổi". Khoảng 8 finding là fix nhỏ độc lập — gom thành Wave 0 để giảm rủi ro ngay lập tức trước khi đụng vào phần khó.

**Kết luận đánh giá**: giữ nguyên verdict NO-GO của review. Plan dưới đây thực thi roadmap của review sau khi điều chỉnh theo 7 điểm trên.

---

## Phần 2 — Execution Plan

### Nguyên tắc chung

- **TDD bắt buộc**: mỗi task viết test red trước, fix xanh sau; giữ coverage ≥ 80% (hiện ~97% lines Node).
- **Mỗi task = 1 commit/PR nhỏ**, review bằng `code-reviewer` (+ `security-reviewer` cho T0.6, W2, crawler).
- **Không mutation semantics cũ khi chưa có `schemaVersion`** — mọi thay đổi payload đi cùng version bump của contract.
- Ước lượng: S ≤ nửa ngày, M ≤ 2 ngày, L ≤ 1 tuần.

### Wave 0 — Quick wins (song song hoá được toàn bộ, ~1–2 ngày)

Tám fix nhỏ, độc lập, giảm rủi ro tức thì. Không phụ thuộc lẫn nhau.

| ID | Task | File chính | Size |
|---|---|---|---|
| T0.1 | **Fix chunk-cap bug**: chunk vượt cap phải bị cắt tại ranh giới cap và set `capped=true` (hiện chunk đầu >10MB được giữ nguyên, `truncated=false`). Test: một chunk 11MB → giữ 10MB, `truncated=true`. | `src/codexRunner.ts:121-131` | S |
| T0.2 | **Batch trả `outputTruncated`**: đưa flag vào từng task result thay vì destructure bỏ đi. | `src/server.ts:588-601` | S |
| T0.3 | **Release consistency gate**: sync `package-lock.json` lên 0.9.0; viết `scripts/check-release-consistency.mjs` so `package.json`/`package-lock.json`/`server.json`/`.claude-plugin/plugin.json`/`CHANGELOG.md`/git tag; thêm vào CI. Quyết định với tag `v0.9.0` lệch manifest: giữ tag, ghi nhận trong CHANGELOG, gate chỉ áp dụng từ v0.10.0 (không rewrite tag đã publish). | `package-lock.json`, `scripts/`, `.github/workflows/ci.yml` | M |
| T0.4 | **Một source-of-truth cho `/codex-flow`**: `commands/codex-flow.md` là bản chuẩn (6 phase); `.claude/commands/codex-flow.md` hoặc xoá hoặc sync tự động; CI byte-equality check nếu giữ cả hai. | `commands/`, `.claude/commands/` | S |
| T0.5 | **smoke-e2e assert thật**: assert `health.loggedIn`, `isError===false`, session ID tồn tại, file content đúng, continuation đúng; fail ⇒ `process.exit(1)`; cleanup workspace tạm. Thêm `scripts/smoke-e2e.mjs` vào `files` của package (hoặc bỏ `test:e2e` khỏi published scripts). | `scripts/smoke-e2e.mjs`, `package.json` | S |
| T0.6 | **Chặn symlink leaf trong notesWriter**: `lstat` file `<sessionId>.md` reject symlink; ghi bằng temp file + `rename` (atomic, không follow); test leaf-symlink (đã có PoC tái hiện trong review). | `src/notesWriter.ts:105-132` | S |
| T0.7 | **Metrics đếm đúng failure**: `turn.failed`/`parsed.errors` với exit 0 phải tính failed; thêm `errorKind` vào `MetricEntry`; aggregate đọc cả file rotate `.1`. | `src/metricsLog.ts:153-168`, `src/server.ts:257-268` | S |
| T0.8 | **Sửa parallel-execution skill**: Wave 1 branch từ Phase-0 baseline; Wave N branch từ integration HEAD sau khi wave N−1 merge + pass; Phase-0 ref chỉ dùng audit/rollback. Đây là sửa prompt/doc, làm ngay được. | `skills/parallel-execution/SKILL.md:39-40` | S |

**Gate Wave 0**: toàn bộ test pass, coverage không giảm, CI có release-consistency + command-equality check.

### Wave 1 — Correctness core của runner/parser (P0, ~1 tuần, tuần tự một phần)

Thứ tự bắt buộc: T1.1 → T1.2 (cùng đụng runner/parser), T1.3–T1.5 song song sau đó.

**T1.1 — Streaming runner + bounded memory (L)**
- Parse JSONL theo dòng ngay khi stream về (line splitter trên stdout), không buffer 10MB rồi parse cuối.
- Giữ bounded tail buffer (ví dụ 1MB) cho raw output phục vụ debug; event đã parse là nguồn chính.
- File: `src/codexRunner.ts`, `src/eventParser.ts` (thêm API incremental).
- Test: output 50MB stream → memory bounded, events đầy đủ; chunk cắt giữa dòng JSON.

**T1.2 — Completion invariant + run status model (M, phụ thuộc T1.1)**
- Parser trả thêm `parseErrors: number`, `unknownEvents: number`, `sawCompletion: boolean`.
- Payload thêm `schemaVersion` và `status: success | partial | failed | aborted`:
  - `failed`: exit ≠ 0, errors, timeout.
  - `aborted`: cancel.
  - `partial`: exit 0 nhưng thiếu completion marker, hoặc `outputTruncated`, hoặc `parseErrors > 0`.
  - `success`: chỉ khi completion marker + không truncate + không parse error.
- `isError=true` cho `failed|aborted`; `partial` trả `isError=false` nhưng status + warning rõ ràng trong payload (Claude reviewer quyết định).
- Cập nhật prompt đọc kết quả trong `commands/codex-flow.md` + review skills để hiểu `status`.
- File: `src/eventParser.ts:36-42,99-114`, `src/server.ts:221-269`, types.
- Test: stdout rỗng + exit 0 ⇒ `partial`, không bao giờ clean success; malformed lines ⇒ `parseErrors` surfaced.

**T1.3 — Process-tree cleanup trước khi nhả lock (M)**
- Trên đường settle sau `exit` (đang chờ 2s rồi bỏ qua descendants): kill process group (POSIX `process.kill(-pid, SIGKILL)`) / `taskkill /pid /T /F` (Windows) **trước khi** resolve promise → lock/slot chỉ nhả sau cleanup.
- Exit code thật của child được giữ (không còn false `null`).
- File: `src/codexRunner.ts:138-176`.
- Test: spawn child kèm grandchild giữ pipe → sau settle không còn descendant; lock nhả sau kill.

**T1.4 — Before/after diff + run attribution (M)**
- Snapshot `git status --porcelain -z` + hash trước run; sau run diff so với snapshot → tách "run này đổi gì" khỏi pre-existing dirty files.
- Untracked file mới: đưa nội dung (bounded, ví dụ 200KB/file, có flag truncated) vào diff payload.
- Diff vẫn được thu khi timeout/cancel (workspace có thể đã bị sửa một phần).
- Gắn `runId` vào payload + metrics + notes.
- File: `src/workspaceDiff.ts`, `src/server.ts`.

**T1.5 — Review theo baseline range (M)**
- `codex_review` nhận `baselineRef` optional; khi có → review `baselineRef..HEAD` **cộng** uncommitted; khi không → giữ hành vi cũ.
- `commands/codex-flow.md` Phase cuối truyền Phase-0 baseline ref (preflight đã lưu) vào final review.
- File: `src/server.ts:174-181`, `src/workspaceDiff.ts:47-84`, `commands/codex-flow.md`, `skills/parallel-execution`.
- Test: commit rồi review với baseline ⇒ thấy committed changes + file mới.

**T1.6 — Prompt qua stdin (S)**
- `codex exec -` / `codex exec resume <id> -`, pipe prompt vào stdin; argv chỉ còn flags + session ID.
- Thêm max input size (ví dụ 5MB) với error message rõ.
- File: `src/argsBuilder.ts:26-68`, `src/codexRunner.ts` (stdin pipe).
- Test: prompt 2MB chạy được; vượt max ⇒ validation error.

**Gate Wave 1**: acceptance của review — "Malformed, unknown, missing-completion hoặc truncated JSONL không bao giờ trả clean success" + "Không còn descendant process sau cancel/timeout; lock chỉ nhả sau cleanup" + "Final review thấy toàn bộ baseline..HEAD, gồm file mới".

### Wave 2 — Cross-process + supply chain (P0 còn lại, ~3–4 ngày, song song được)

**T2.1 — Cross-process workspace lease (M)**
- Lease file tại `~/.codex-mcp/locks/<sha256(realpath(cwd))>.json` chứa `{pid, startTime, runId, hostname}` — **ngoài workspace** để tránh OneDrive/cloud-sync corruption (điểm bổ sung 1.2.3).
- Acquire: `O_EXCL` create; stale recovery: pid chết hoặc `startTime` không khớp process → reclaim.
- In-memory Set giữ làm fast path; lease là lớp cross-process.
- File: module mới `src/workspaceLease.ts`, wire vào `src/server.ts:349,392`.
- Test: hai server instance cùng cwd → instance sau bị từ chối; stale lock (pid giả) được reclaim.

**T2.2 — Skill sync quarantine + vetting theo hash (M)**
- `skills:sync` clone vào `~/claude-skill-library/quarantine/` (KHÔNG nằm trong index roots).
- Vet record: `{path, gitCommit, sha256(content)}`; sau `git pull` hash đổi ⇒ trạng thái về unvetted, `skill-selection` từ chối load.
- Indexer: reject `SKILL.md` là symlink (`lstat`), verify `realpath` nằm trong approved root.
- File: `scripts/sync-awesome-skills.mjs:110-143,188-193`, `scripts/build-skills-index.mjs:70-104`, `skills/skill-selection/SKILL.md:69-76`.
- Test: symlink SKILL.md bị bỏ qua; hash mismatch ⇒ unvetted.

### Wave 3 — Crawler scope decision + fixes (điều kiện, ~2–4 ngày nếu promote)

**T3.0 — Decision gate (cần input của owner)**: chọn một trong hai:
- **(a) Descope**: giữ gitignore, đổi README thành "experimental prototype, not supported", gỡ mọi promise về comments/metrics reliability. Effort: S. Các task T3.1–T3.7 bị hủy.
- **(b) Promote thành deliverable**: track trong git, thêm CI Python (matrix 3.11–3.13, pytest, coverage gate), rồi thực hiện T3.1–T3.7.

Nếu (b), theo thứ tự severity:

| ID | Fix | File | Size |
|---|---|---|---|
| T3.1 | Label-aware parsing: đọc label từng segment (`views`/`reactions`…), không suy diễn theo vị trí; không nhận diện được ⇒ `null` + warning, không bao giờ đảo số. | `metrics.py:119-140` | S |
| T3.2 | Đối chiếu video ID request với ID trong `og:url`; mismatch ⇒ error rõ ràng. | `metrics.py:105-109` | S |
| T3.3 | Kết quả comments trả `{items, hasMore, truncated, stopReason}`; CLI in đúng semantics. | `comments.py:175-202`, CLI | S |
| T3.4 | Xử lý HTML void tags (`br`, `img`, `hr`…) trong tag stack; thêm `handle_startendtag`. | `comments.py:64-131` | S |
| T3.5 | Tách "zero comments hợp lệ" khỏi auth wall (detect auth-wall bằng signal cụ thể, không phải `not page_comments`). | `comments.py:192-193,242` | S |
| T3.6 | CSV formula injection: escape cell bắt đầu `=`,`+`,`-`,`@` (prefix `'`). | `export.py:33-41` | S |
| T3.7 | Atomic writes: temp file + `os.replace`; áp dụng cho JSON + CSV. HTTP: response size limit, redirect host check, HTTPS-only default, báo đúng lỗi cuối. | `export.py`, HTTP layer | M |

### Wave 4 — Release confidence (P1, ~1 tuần)

| ID | Task | Size |
|---|---|---|
| T4.1 | **CI gates**: coverage threshold (lines ≥ 90% cho repo này vì baseline đã 97%), `npm pack` + install-from-tarball smoke (chạy được `dist/index.js` + mọi script được quảng bá). | M |
| T4.2 | **Protocol canary fixtures**: bộ JSONL fixture capture từ Codex CLI thật (per version); test parser chống fixture; script refresh fixture khi upgrade Codex. Đây là thay thế thực dụng cho strict schema pinning (điểm 1.2.4). | M |
| T4.3 | **E2E có assertion trong CI** (job optional, chỉ chạy khi có Codex login/secret) dùng smoke-e2e mới của T0.5. | S |
| T4.4 | **Structured output contract**: `structuredContent` + output schema + `schemaVersion` cho mọi tool (đã có nền từ T1.2). | M |
| T4.5 | **Session/health accuracy**: canonical cwd khi filter session, sort theo last-activity thật; health phân biệt `not-logged-in` / `probe-timeout` / `probe-failed`. | S |
| T4.6 | **Batch semantics**: `failFast=false` + 1 task fail ⇒ tool-level success với per-task status (không đánh cả tool là MCP error); progress có task attribution. | M |
| T4.7 | **`.mcp.json` pin version** thay vì `@latest` (dev dùng local build path). | S |

### Wave 5 — Vận hành & hiệu năng (P2, làm dần)

- Benchmark: batch 50 tasks, output lớn, nghìn sessions, metrics rotation; đo memory/FD/process leak (soak 1h).
- Progress notification throttle/backpressure (coalesce theo interval, ví dụ 250ms).
- Metrics mở rộng: model, task ID, error kind (đã có T0.7), queue time, time-to-first-progress, retry count, model-aware cost.
- Tách `src/server.ts` (663 dòng): `schemas.ts`, `handlers/`, `locking.ts`, `outputEncoding.ts` — tuân thủ giới hạn file < 800 dòng và single-responsibility.
- Live terminal watcher: completion marker + auto-exit.
- Config/docs/manifest sinh từ một source (version, tool list).

### Dependency graph tổng

```
Wave 0 (8 task song song)
   ↓
T1.1 → T1.2 ─┐
T1.3 ────────┤→ Gate W1 → Wave 2 (T2.1 ∥ T2.2) → Wave 4 → Wave 5
T1.4 → T1.5 ─┤
T1.6 ────────┘
Wave 3: độc lập, chỉ chờ T3.0 decision — chạy song song với W1/W2 nếu promote
```

### Ước lượng tổng

| Wave | Effort | Có thể song song |
|---|---|---|
| W0 | 1–2 ngày | Hoàn toàn |
| W1 | ~1 tuần | Một phần (T1.1→T1.2 tuần tự) |
| W2 | 3–4 ngày | Hai task song song |
| W3 | 0.5 ngày (descope) / 2–4 ngày (promote) | Sau decision |
| W4 | ~1 tuần | Phần lớn |
| W5 | Liên tục | — |

**Tổng critical path tới "production-ready" (W0→W4, chưa tính W5): ≈ 3–3.5 tuần** một người, ngắn hơn nếu chạy parallel execution qua codex-flow cho các task độc lập.

### Acceptance gate cuối (kế thừa review, áp dụng nguyên trạng)

- Sequential + parallel E2E: wave sau consume được output wave trước.
- Final review thấy toàn bộ `baseline..HEAD`, gồm file mới.
- Malformed/unknown/missing-completion/truncated JSONL không bao giờ trả clean success.
- Không còn descendant sau cancel/timeout; lock chỉ nhả sau cleanup.
- Version package/lock/server/plugin/tag khớp tuyệt đối (gate từ v0.10.0).
- Packed artifact chạy được mọi script được quảng bá.
- CI Node (+Python nếu W3b) matrix, coverage, install smoke xanh.
- Crawler (nếu promote): số đúng hoặc `null + warning`; partial luôn có `hasMore/truncated/stopReason`.
- Không ghi xuyên symlink; skill đổi hash chưa re-vet không được load.
- SLO memory, cancellation latency, orchestration overhead được đo ở W5.

### Quyết định của owner (đã chốt 2026-07-21)

1. **T3.0** — ✅ **Promote** `fb-video-crawler` thành deliverable chính thức: track trong git, CI Python riêng (`crawler-ci.yml`), thực hiện T3.1–T3.7.
2. **T0.3** — ✅ **Rewrite tag**: `package-lock.json` đã sync lên 0.9.0 (commit `93eb07a`), tag `v0.9.0` đã được re-point tới commit đó và force-push. Consistency gate áp dụng từ nay.
3. **T1.2** — ✅ Theo khuyến nghị: `partial` trả `isError=false` + `status` trong payload, Claude reviewer quyết định bước tiếp theo.
