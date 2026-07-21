# Full Pipeline Review — 2026-07-21

## Kết luận điều hành

Pipeline hiện chạy tốt ở happy path, code có nền tảng khá chắc và test unit rất mạnh. Tuy nhiên, đánh giá tổng thể là **NO-GO cho mục tiêu production “chạy mượt, ổn định, không có lỗi ngoài dự kiến”** ở trạng thái hiện tại.

Rủi ro lớn nhất không nằm ở luồng thông thường mà ở:

- Tính toàn vẹn của final output khi JSONL hỏng hoặc bị truncate.
- Parallel execution và final review sau commit/merge.
- Recovery khi timeout/cancel/process con còn sống.
- Một số lỗ hổng ghi file và supply chain.
- Silent data corruption trong `fb-video-crawler`.
- Release, CI và các artifact không đồng bộ.

Mục tiêu thực tế nên là: mọi lỗi đều được phát hiện, fail-closed, có trạng thái rõ ràng, khôi phục được và không trả false-success—thay vì cố cam kết tuyệt đối “không bao giờ lỗi”.

Review được thực hiện theo năm góc nhìn: Expert Developer, Expert System Architect, Product Manager, Project Manager và Quality Assurance. Không có source/config nào được sửa trong quá trình review.

## Kết quả xác minh

| Kiểm tra | Kết quả |
|---|---:|
| TypeScript typecheck | Pass |
| Node unit tests | 230/230 pass, 27 files |
| Node coverage | 96.96% lines, 81.39% branches, 94.64% statements |
| Python crawler tests | 76/76 pass |
| Python coverage | 98.22% |
| Live MCP E2E execute → continue | Pass ngoài sandbox; nội dung file đúng |
| `npm audit`, gồm dev dependencies | 0 advisory tại thời điểm review |
| `npm pack --dry-run` | Pass, 88 files, khoảng 187 KB |
| Doctor | Node 26.4, Codex 0.144.6, Claude Code 2.1.216: pass |
| Git worktree cuối review | Clean |

Điểm đáng lưu ý: lần E2E bị sandbox chặn đã làm `codex_execute` thất bại nhưng script vẫn exit `0`. Điều này xác nhận smoke test hiện có thể xanh giả.

## Luồng A–Z

```text
User request
  ↓
/codex-flow command
  ↓
Interview → PLAN.md → TASKS.md → skill selection / task waves
  ↓
MCP stdio: src/index.ts
  ↓
src/server.ts
  ├─ Zod input validation
  ├─ global concurrency guard
  ├─ per-cwd guard
  └─ argsBuilder
       ↓
codexRunner → `codex exec --json`
       ↓
JSONL stdout
  ├─ progress notifier
  ├─ live log / terminal
  └─ eventParser
       ↓
CodexResult
  ├─ workspace diff
  ├─ notes
  ├─ metrics
  └─ MCP JSON-as-text final payload
       ↓
Claude review → codex_continue → final review
```

Module runtime được chia tương đối hợp lý. Tuy nhiên, toàn bộ workflow plan/task/review vẫn chủ yếu là quy ước bằng prompt; runtime không quản lý một state machine bền vững.

## Đánh giá theo năm vai trò

| Góc nhìn | Đánh giá |
|---|---|
| Expert Developer | Code sạch, strict TypeScript, defensive programming tốt; còn nhiều lỗi edge-case có thể gây false-success, data corruption hoặc resource leak. |
| System Architect | Module runtime khá rõ, nhưng orchestration chưa durable, lock chỉ trong một process, output contract yếu và memory worst-case cao. |
| Product Manager | Happy path có giá trị; một số capability đang được mô tả mạnh hơn độ tin cậy thực tế, đặc biệt comments crawler, metrics và parallel flow. |
| Project Manager | Release/version/tag và source-of-truth chưa đồng bộ; nested crawler chưa phải deliverable quản lý được. |
| Quality Assurance | Unit coverage rất tốt nhưng E2E, protocol compatibility, load/soak, release packaging và cross-process tests còn thiếu. |

## Các blocker P0

### 1. Parallel wave sau có thể chạy trên code cũ

`skills/parallel-execution/SKILL.md:39-40` yêu cầu mọi worktree branch từ Phase-0 baseline. Nhưng task ở wave sau có thể phụ thuộc output đã merge từ wave trước.

Tác động: task phụ thuộc không thấy contract/code mới, tự tái tạo implementation, build sai hoặc merge conflict.

Khuyến nghị:

- Wave 1 branch từ baseline.
- Wave N branch từ integration HEAD sau khi wave N−1 đã merge và pass.
- Phase-0 ref chỉ dùng audit/rollback.

### 2. Final review có thể không thấy code đã commit

Workflow có checkpoint commits, nhưng `codex_review` chỉ review uncommitted `git diff HEAD`. Sau khi task hoặc wave đã commit, working tree sạch và review cuối không có range `baseline..HEAD`.

Bằng chứng: `src/server.ts:174-181`, `src/workspaceDiff.ts:47-84`.

Khuyến nghị: truyền baseline ref và review toàn bộ `baseline..HEAD`, gồm mọi checkpoint/merge commit.

### 3. Diff không phải “những gì run vừa thay đổi”

Hiện chỉ chụp trạng thái sau run bằng `git status` + `git diff HEAD`.

Hệ quả:

- Trộn pre-existing dirty files với thay đổi của Codex.
- Không biết chính xác run nào sửa gì.
- `git diff HEAD` không chứa nội dung file untracked.
- Khi timeout/cancel, diff còn bị bỏ hoàn toàn, trong khi workspace có thể đã bị sửa một phần.

Khuyến nghị: before/after snapshot, run ID và bounded untracked-file patch/artifact.

### 4. JSONL có thể hỏng nhưng tool vẫn báo success

`src/eventParser.ts:36-42,99-114` bỏ im lặng malformed và unknown events. `src/server.ts:221-269` không yêu cầu completion marker và không xem `outputTruncated` là lỗi.

Một stdout rỗng/malformed với exit code `0` có thể trả `isError=false`. Batch còn bỏ hẳn `outputTruncated` khỏi task result tại `src/server.ts:588-600`.

Khuyến nghị:

- Schema validation theo phiên bản Codex CLI.
- Trả `parseErrors`, `unknownEvents`, `protocolVersion`.
- Yêu cầu completion invariant.
- Trạng thái `success | partial | failed | aborted`.
- Truncated/protocol-incomplete không được success bình thường.

### 5. Output cap có lỗi và memory worst-case cao

`src/codexRunner.ts:115-149` kiểm tra cap trước khi thêm nguyên chunk. Một chunk lớn hơn 10 MB vẫn được giữ toàn bộ và có thể báo `truncated=false`.

Ngoài ra mỗi run giữ khoảng 20 MB stdout/stderr rồi tạo thêm bản copy/string. Với concurrency mặc định 16, GC/OOM risk là đáng kể.

Khuyến nghị: streaming JSONL parser, bounded tail buffer và weighted admission control.

### 6. Process con có thể tiếp tục chạy sau khi lock đã nhả

Khi Codex process phát `exit` nhưng descendant giữ pipe, runner chờ hai giây rồi settle mà không đảm bảo kill descendant/process group.

Tác động:

- Run cũ vẫn có thể sửa workspace.
- Cwd lock được nhả.
- Run mới bắt đầu chồng lấn.
- Exit code thành `null`, tạo false failure và resource leak.

Khuyến nghị: cleanup process tree trước khi release lock/slot.

### 7. Lock chỉ có hiệu lực trong một MCP process

Per-cwd guard hiện là `Set` trong memory của từng `createServer`. Hai Claude clients hoặc hai MCP server processes vẫn có thể chạy cùng workspace đồng thời.

Khuyến nghị: cross-process workspace lease/lockfile có PID, start time, run ID và stale-lock recovery.

### 8. Ghi notes xuyên symlink leaf

`src/notesWriter.ts:105-132` kiểm tra symlink ở directory nhưng không kiểm tra file `<sessionId>.md`.

Đã tái hiện an toàn: symlink note có thể khiến `writeFileSync`/`appendFileSync` ghi hoặc truncate file ngoài workspace.

Khuyến nghị: `O_NOFOLLOW`, kiểm tra `fstat`, atomic temp+rename và test leaf symlink.

### 9. Skill sync/vetting có rủi ro supply chain

`skills:sync` clone/pull toàn bộ repository third-party vào thư mục được index mặc định. Quy trình vet chỉ lưu path, không lưu commit/content hash. Sau lần `git pull`, nội dung tại cùng path thay đổi nhưng vẫn được coi là vetted.

Ngoài ra indexer không bắt buộc `SKILL.md` phải là regular file; symlink có thể được `readFile` follow ra ngoài root.

Bằng chứng:

- `scripts/sync-awesome-skills.mjs:110-143,188-193`
- `scripts/build-skills-index.mjs:70-104`
- `skills/skill-selection/SKILL.md:69-76`

Khuyến nghị: quarantine, commit pin, content hash, re-vet khi hash đổi, reject symlink và xác minh realpath nằm trong approved root.

### 10. Prompt lớn được truyền qua argv

`src/argsBuilder.ts:26-68` đưa toàn prompt/PLAN/skill blocks vào command-line positional argument.

Rủi ro:

- `E2BIG` hoặc Windows command-line limit.
- Prompt có thể xuất hiện trong process inspection.
- Không có max input size.

Khuyến nghị: truyền prompt qua stdin/input file protocol, argv chỉ chứa flags/session ID.

## Product correctness: `fb-video-crawler`

Thư mục này là standalone demo/prototype, không phải runtime dependency của MCP và đang bị ignore hoàn toàn bởi Git tại `.gitignore:37`. Vì vậy hiện nó không có CI, release hay regression protection chính thức.

### 1. Silent metrics corruption

`fb-video-crawler/src/fb_crawler/metrics.py:119-140` gán segment số đầu tiên là views, segment thứ hai là reactions mà không kiểm tra label.

Probe thực tế:

```text
1K reactions · 2K views
→ view_count=1000, reaction_count=2000
```

### 2. Có thể trả metrics của video khác

`fetch_metrics()` validate ID request nhưng không đối chiếu với ID trong `og:url`.

### 3. Comments bị partial nhưng báo thành công

`comments.py:175-202` hết `max_pages` vẫn trả list bình thường dù còn `next_cursor`. CLI in `total` như toàn bộ dataset.

### 4. Parser hỏng với HTML phổ biến có `<br>` hoặc `<img>`

Stack tự quản lý mọi start tag nhưng HTML void tags không có end tag, dẫn tới `Unclosed Facebook comment node`.

### 5. Zero comments bị đánh đồng với auth wall

Trang hợp lệ không có comment có thể bị trả `FacebookAuthRequiredError` thay vì một collection rỗng hợp lệ hoặc schema/auth state rõ ràng.

### 6. CSV formula injection

`export.py:33-41` ghi trực tiếp cell bắt đầu bằng `=`, `+`, `-`, `@`; mở trong Excel/Sheets có thể thực thi formula.

### 7. Output không atomic

File JSON/CSV bị mở và overwrite trực tiếp. Disk-full/permission/interruption có thể để lại file partial hoặc truncate file cũ.

### 8. HTTP boundary còn yếu

- Không giới hạn response size.
- Chưa kiểm soát mọi redirect target trước khi request.
- Cho phép HTTP đầu vào.
- Lỗi cuối có thể bị báo sai nếu trước đó từng nhận 5xx rồi attempt cuối gặp network timeout.

### 9. Comments live chưa phù hợp product promise

README thừa nhận unauthenticated endpoint thường yêu cầu login nhưng product không cung cấp auth/token flow. Fixture comments là synthetic, chưa có real schema canary.

## QA, release và project findings

### Hai bản `/codex-flow` bị drift

`commands/codex-flow.md` là workflow 6 phase mới, trong khi `.claude/commands/codex-flow.md` vẫn là bản 5 phase cũ.

Bản cũ thiếu resume, baseline, known-red, contracts, skill selection, parallel flow và các language skills mới.

Khuyến nghị: một source-of-truth và CI byte-equality check.

### Release `0.9.0` không nguyên tử

- `package.json`: `0.9.0`
- `server.json`: `0.9.0`
- `package-lock.json:3,9`: vẫn `0.8.0`
- Tag `v0.9.0` chứa plugin manifest `0.8.0`; commit bump manifest nằm sau tag.

Khuyến nghị: release gate đồng bộ package/lock/server/plugin/changelog/tag trước khi publish.

### Smoke E2E có thể xanh giả

`scripts/smoke-e2e.mjs:17-52` chỉ log kết quả, không assert:

- `health.loggedIn`
- `isError`
- Session ID
- File existence/content
- Continuation content

Đã quan sát `codex_execute` fail nhưng script vẫn exit `0`.

Script còn không nằm trong npm tarball dù `package.json` expose `npm run test:e2e`.

### CI chưa enforce các gate quan trọng

`.github/workflows/ci.yml:9-26` chỉ build và chạy Vitest trên Node 20/22.

Thiếu:

- Coverage gate thực tế.
- `npm pack`/installed-package smoke.
- Real Codex protocol canary.
- Python 3.11/3.12/3.13 matrix.
- Wheel/sdist install test.
- Cross-process/load/soak tests.
- Release version consistency.

### Observability chưa phản ánh đúng failure

`src/metricsLog.ts:153-168` chỉ tính failure từ exit/timeout/abort. `turn.failed` với exit `0` được tool xem là lỗi nhưng metrics lại tính success.

Rotation còn làm aggregate bỏ lịch sử `.1`; session listing dùng creation timestamp thay vì last activity thực.

## Các phát hiện P1/P2 khác

- Mọi payload được JSON stringify trong text, chưa có `structuredContent`, output schema hoặc `schemaVersion`.
- Batch không có attributable progress/live telemetry và đánh toàn tool là MCP error khi chỉ một task fail dù `failFast=false`.
- Progress notification fire-and-forget từng event, không backpressure/throttle.
- Health không phân biệt rõ chưa login với login probe timeout/failure.
- Session filter cần canonical cwd và sort theo real last activity.
- Metrics thiếu model, task ID, error kind, queue time, time-to-first-progress, retry count và model-aware cost.
- `src/server.ts` dài 663 dòng, đang giữ cả schema, controller, orchestration, locking, telemetry và output encoding.
- Skill eval “32/32” chủ yếu đo recall-any trên local index; report vẫn có duplicate/tangential skills và chưa đo precision thực tế.
- `.mcp.json` dùng `@latest`, khiến source dev và published MCP có thể chạy khác phiên bản.
- Live terminal watcher không có completion marker và không tự thoát.
- Chưa có benchmark cho batch 50 tasks, output lớn, hàng nghìn sessions, metrics rotation, memory/FD/process cleanup.
- Crawler thiếu lock/reproducible dependency policy, lint/type/static gates, Python version matrix và release metadata đầy đủ.

## Điểm mạnh

- TypeScript `strict: true`, source có type boundary rõ.
- Spawn Codex/git bằng argv, không qua shell; có `--` guard chống flag smuggling.
- Timeout/cancel có SIGTERM → SIGKILL và process group trên POSIX.
- Per-cwd guard, global gate và bounded batch worker pool là nền tảng tốt.
- Progress/live view/notes/metrics được thiết kế best-effort để side channel không đánh sập run chính.
- Symlink protection ở directory layer, file mode `0600` cho dữ liệu nhạy cảm.
- Parser event O(n), có defensive handling cho malformed array item.
- Python dùng frozen dataclass, Protocol và domain exceptions rõ ràng.
- URL pagination có hostname check, cycle detection và deterministic dedup.
- Crawler trung thực với comment/share unavailable thay vì fabricate.
- Test suites nhanh, offline và coverage cao.
- Production dependencies không có advisory được npm audit phát hiện tại thời điểm review.

## Roadmap đề xuất

### P0 — Correctness và security blockers

1. Sửa parallel wave base và baseline-range final review.
2. Before/after diff, gồm untracked content.
3. Protocol schema + completion invariant + truncated/partial semantics.
4. Streaming runner và process-tree cleanup.
5. Cross-process workspace lease.
6. Chặn notes/skill symlink và thiết kế lại skill quarantine/vetting.
7. Sửa crawler label-aware metrics, ID match, comment completeness và parser.
8. Đồng bộ command/release/tag/version.

### P1 — Release confidence

1. Meaningful E2E với assertion và cleanup.
2. CI coverage/per-file gates + package install smoke.
3. Codex CLI compatibility fixtures/canary.
4. Python matrix, build/wheel và tracked deliverable decision.
5. Structured API contract.
6. Accurate metrics/session behavior.

### P2 — Performance và vận hành

1. Batch/load/soak benchmarks.
2. Bounded progress/backpressure.
3. Model-aware cost and latency telemetry.
4. Atomic output writes.
5. Config/docs/manifests sinh từ một source.

## Acceptance gate trước production

- Sequential và parallel E2E: task wave sau phải consume được output wave trước.
- Final review thấy toàn bộ `baseline..HEAD`, gồm file mới.
- Malformed, unknown, missing-completion hoặc truncated JSONL không bao giờ trả clean success.
- Không còn descendant process sau cancel/timeout; lock chỉ nhả sau cleanup.
- Version package/lock/server/plugin/tag khớp tuyệt đối.
- Packed artifact chạy được mọi script được quảng bá.
- CI Node + Python matrix, coverage và install smoke đều xanh.
- Facebook parser trả đúng hoặc `null + warning`, không bao giờ đảo/suy diễn số.
- Partial comments luôn có `hasMore`, `truncated`, `stopReason`.
- Không ghi xuyên symlink; không load skill đã thay đổi mà chưa re-vet.
- Có SLO về memory, cancellation latency, orchestration overhead và uncategorized failure.

## Kết luận cuối

Nền tảng code tốt và sequential live flow đã chạy được, nhưng pipeline hiện chưa đạt production-grade vì còn false-success, review blind spot, parallel-state lỗi và silent data corruption.

Report này chỉ ghi nhận đánh giá và khuyến nghị. Chưa có bất kỳ sửa chữa source code nào được thực hiện.
