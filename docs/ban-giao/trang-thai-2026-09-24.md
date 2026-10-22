# Bàn giao trạng thái — UDP, cuối phiên 24/09/2026

Đọc tệp này trước khi làm tiếp. Nó nói: cái gì đã xong và có bằng chứng, cái gì đang dở,
bước kế tiếp là gì, và những cái bẫy đã tìm ra để lần sau không mất công tìm lại.

---

## 1. Plan #24 (Adapter framework) — **ĐÃ ĐÓNG TRỌN**

Bằng chứng, không phải lời hứa:

| Phép nghiệm thu                                                                               | Kết quả                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm -r test` (database dev)                                                                 | **2409 test xanh, 0 skip**, 16 package                  |
| `pnpm test:scratch` (đúng lệnh CI: database dựng mới từ chuỗi migration, seed, chạy hết, xoá) | **Xanh** — `Bộ test đầy đủ xanh trên database scratch.` |
| `pnpm typecheck`, `eslint .`                                                                  | 0 lỗi, 0 cảnh báo                                       |
| `pnpm db:verify-chain`                                                                        | Xanh; **0 migration mới** trong cả plan (N7)            |
| Đột biến P23                                                                                  | **56/56 đỏ**                                            |
| Quét bí mật                                                                                   | 0 khoá thật trong tệp được theo dõi                     |

Commit của phiên này (mới nhất trước, tất cả đều **local**, chưa push — theo quy ước
`user-pushes-git-himself`):

```
5441c48  P25 P0: response contract foundation with sendJson, explicit type slugs, traceId in logs
b1a861d  Widen the package-boundary and debt-ledger gates to .tsx + 18 Portal debt entries
0be8882  Fix CI: run workspace tests sequentially; stop the type-debt gate from hiding itself
91eb726  P23: mutation campaign + type-debt/skipped-test gates + AC-9.5 machine-checkable
ce96a9f  P21+P22: day-2 drift scan & upgrade, three-layer I32(c), E16 grid, design corrections, debt ledger
067a7bd  P20: SaaS adapter base, datadog, two-way drift comparison
e68a863  P19: Helm adapter base + prometheus-grafana
```

Sổ nợ kiểm chứng: `docs/measurements/kiem-chung-con-no.md`, **49 mục** (31 của Plan #24 +
18 của Portal), mỗi mục sáu trường, chốt ba nơi (`debt-ledger.test.ts`) xanh.

## 2. Plan #25 (Portal) — spec + plan xong, P0 **đang dở**

### Tài liệu

**Lưu ý:** những tệp dưới đây nằm trong scratchpad của phiên làm việc 24/09/2026, **không
nằm trong git** (chúng là bản nháp quy trình, không phải nguồn sự thật). Hai tệp trong thư
mục này là bản chắt lọc của chúng. Nếu cần nguyên văn, đọc lại transcript phiên đó; còn để
làm tiếp thì hai tệp ở đây là đủ.

| Tệp                                                     | Nội dung                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `plan25-spec-v2.md`                                     | SPEC đã qua QA vòng 1. **43 AC**, 14 mục sửa thiết kế (D-P), 18 mã sổ nợ, 25 quyết định                |
| `plan25-plan.md`                                        | PLAN theo R1..R11, mười pha P0..P9, mỗi hàng có làm-gì/ở-đâu/hệ-quả/lan-sang-đâu/ai-dùng               |
| `plan25-qa1.md`                                         | QA vòng 1: bốn reviewer (BA/QA/Tester/SysDesign), **50 phát hiện, 11 BLOCKER**, có bảng xử lý từng cái |
| `plan25-qa2.md`                                         | QA vòng 2 (lead tự làm vì ba agent treo do máy bận): **5 phát hiện, 3 BLOCKER**                        |
| `plan25-qa3.md`                                         | QA vòng 3: ba agent độc lập, **24 phát hiện, 5 BLOCKER**                                               |
| `p25_ledger.py`                                         | Script đã chạy — 18 mục nợ Portal (đã vào repo)                                                        |
| `p25_p0_wire.py`, `p25_p0_step1.py`, `p25_p0_step1b.py` | Script P0 đã chạy                                                                                      |
| `scratch-full2.log`                                     | Log đầy đủ của lượt CI xanh, để đối chiếu về sau                                                       |

**Tổng cộng ba vòng QA: 8 reviewer, 79 phát hiện.**

### P0 đã làm được gì (đã commit, có test)

Commit `5441c48`:

- `packages/shared-types/src/problem.ts`: hằng `CSRF_INVALID_SLUG` (tệp này **0 import**
  nên Portal dùng được; `@udp/http` thì Portal không được import vì barrel kéo Prisma).
- `packages/http/src/errors.ts`: `AppError.typeSlug` + `withTypeSlug()` (**ném** khi lỗi đã
  có `problemCode` — một hàm chỉ tác dụng ở nửa số ca mà im lặng là cái bẫy đắt hơn vấn đề
  nó sửa), và lớp `ResponseContractError` (500, kind `INTERNAL`).
- `packages/http/src/problem.ts`: `typeUriOf` nhận `override` và slug tường minh **thắng**
  slug suy từ mã; `traceIdOf` được export.
- `packages/http/src/error-handler.ts`: truyền slug ở **cả hai** nhánh (`AppError` và
  `RelayedProblemError`), và thêm `traceId` vào **mọi** dòng log (trước đây `traceId` người
  dùng đọc cho support không tra ra dòng log có stack).
- `packages/http/src/send-json.ts` + export ở barrel: `safeParse` → log → ném
  `ResponseContractError`; gửi `data` chứ không gửi bản parse.
- `services/core-backend/.../csrf.middleware.ts`: ném kèm `CSRF_INVALID_SLUG`.
- `packages/http/tests/send-json.test.ts`: 6 ô, trong đó ô quan trọng nhất khẳng định
  **500 chứ không phải 400**, và một ô đối chứng khẳng định `withTypeSlug` **ném** khi vô
  nghĩa.

Nghiệm thu: `@udp/http` **47/47**, `@udp/shared-types` **103/103**,
`auth.integration.test.ts` **16/16**, typecheck và lint sạch.

### P0 đang dở — dừng ở đâu và vì sao

**Đang có một tệp CHƯA commit:** `packages/shared-types/src/wire.ts` — schema mức dây cho
project / environment / member / user / quota, **mọi object `.strict()`**. Nó chưa được
khai trong `exports` nên **chưa ai import được**, cây vẫn biên dịch bình thường. Cố ý
không commit: R6 nói không thêm mã chưa có người dùng trong cùng đợt.

**Lệnh bị người dùng từ chối:** một script Python ghi đè **toàn bộ**
`packages/shared-types/package.json` bằng `json.dumps` để thêm hai subpath. Nó sẽ định
dạng lại cả tệp. **Cách đã dùng thay thế** (hiện đang nằm trong cây làm việc, chưa commit):
sửa đúng hai dòng trong `exports`, giữ nguyên thứ tự và định dạng các khoá còn lại:

```json
"./segment-api": "./src/segment-api.ts",
"./capability": "./src/capability.ts",
"./wire": "./src/wire.ts",
"./flag-api": "./src/flag-api.ts"
```

### Bước kế tiếp của P0, theo thứ tự

1. ~~Thêm hai subpath `./wire` và `./flag-api` vào `exports`.~~ **XONG** (chưa commit) —
   `pnpm --filter @udp/shared-types typecheck` xanh, `eslint wire.ts` xanh.
   Danh sách việc còn dở đầy đủ: xem `dang-do-2026-09-24.md`.
2. `myRole` — **hai đường, một miễn phí**:
   - `GET /projects/:id` và hai `PATCH`: đọc `req.projectRole` (middleware đã lưu sẵn ở
     `project-role.middleware.ts:126`).
   - `POST /projects`: **không** qua middleware đó, nên controller điền `myRole: "OWNER"`
     tường minh (repository tạo hàng OWNER trong cùng lệnh). Thiếu bước này thì tạo project
     commit xong rồi mới ném ⇒ người dùng bấm lại ⇒ **project thứ hai**.
   - `GET /projects`: thêm `members: { where: { userId }, select: { projectRole: true },
take: 1 }` vào `select`, và **khai kiểu trả về tường minh** — gán object Prisma rộng
     hơn cho kiểu hẹp hơn là hợp lệ trong TS, nên `members` sẽ biến mất khỏi kiểu mà vẫn
     còn ở runtime. `members[0]` là `| undefined` ⇒ **ném**, tuyệt đối không `?? "VIEWER"`.
   - **KHÔNG** thêm `myRole` vào `PublicProject`: kiểu đó là phép chiếu database, 7 chỗ
     dùng, thêm trường bắt buộc là vỡ cả bảy.
3. Đổi các controller Portal tiêu thụ sang `sendJson(res, schemaWire, data)`.
4. Golden capture: ghi một response THẬT cho mỗi schema vào
   `services/core-backend/tests/fixtures/wire/`, và một test khẳng định schema parse được
   nó — không có nửa này thì schema chỉ tự thoả chính nó.
5. Cổng P0: `pnpm --filter @udp/core-backend test` và
   `pnpm --filter @udp/shared-types test` xanh; `references.test.ts` vẫn xanh (24 mã lỗi).

---

## 3. Những cái bẫy đã tìm ra — đừng tìm lại

| Bẫy                                                         | Sự thật đã đo                                                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r test --workspace-concurrency=1`                    | **Sai**: pnpm chuyển mọi đối số sau tên script cho chính script. Cờ phải đứng **trước**: `pnpm -r --no-bail --if-present --workspace-concurrency=1 test`              |
| Chạy các package song song                                  | Vượt trần 60 kết nối Supabase ⇒ `wipeRows` hỏng ⇒ 18 ô lưới tầng 2 đỏ vì trùng khoá, và 19 ô `rollout.integration` **skip im lặng** (hook 90s quá hạn)                |
| Một cổng quét `git ls-files`                                | Nó **không thấy chính mình** khi tệp còn chưa được theo dõi. `type-debt.test.ts` xanh 5 ô ở lần đầu rồi đỏ ngay sau commit                                            |
| `".tsx".endsWith(".ts")`                                    | **false** — `package-boundaries` và `debt-ledger` từng mù hoàn toàn với mã React. Đã sửa ở `b1a861d`, **trước** khi có tệp `.tsx` đầu tiên                            |
| `z.object` mặc định                                         | **strip** khoá lạ ⇒ trường thừa lọt lên dây mà không nơi nào đỏ. Mọi schema wire phải `.strict()`                                                                     |
| `ZodError` thoát ra từ response                             | `errorHandler` bắt nó **trước** mọi nhánh ⇒ **400 "dữ liệu gửi lên không hợp lệ"** cho một bug của server, và **không log gì**                                        |
| `refresh()` của Service 1                                   | Có **phát hiện dùng lại token**: trình token cũ ⇒ `revokeFamily` ⇒ đăng xuất **mọi tab**. Nên single-flight phải kèm khoá giữa các tab (Web Locks)                    |
| `Idempotency-Key`                                           | Ràng vào `bodyHash`: cùng khoá + khác body ⇒ 422. Khoá phải sinh **tại lúc bấm gửi**, không phải lúc dựng hook                                                        |
| vitest 2.1.9                                                | **Không có** `test.projects` (đó là Vitest 3). Phải dùng `vitest.workspace.ts` + `defineWorkspace`                                                                    |
| `@tanstack/router-cli` 1.167.38 vs `router-plugin` 1.168.40 | **Không peer nào ràng chúng** ⇒ hai generator có thể sinh hai `routeTree.gen.ts` khác nhau. Phải ghim chính xác cả ba bản                                             |
| `Intl.Segmenter`                                            | Có sẵn trên Node v22.20.0 ⇒ đếm grapheme không cần thư viện                                                                                                           |
| `sendJson` parse                                            | Đã đo: 0,36 ms (20 item), 1,72 ms (200), 5,70 ms (1000) — khoảng 1-3% thời gian một response thật                                                                     |
| `.gitattributes`                                            | `* text=auto eol=lf` ⇒ tài liệu trong git là **LF**, bản làm việc là CRLF. Bất biến "chỉ CRLF" của `doc_integrity.py` là bất biến của **máy này**, không phải của kho |

---

## 4. Việc còn lại của Plan #25, sau P0

P1 scaffold + ba cổng đặt sớm → P2 hệ thống thiết kế + `copy.ts` + ba lint cưỡng chế →
P3 lớp HTTP + câu chuyện thất bại + auth → P4 AppShell + project + Tổng quan → P5 Flag →
P6 Segment → P7 Rollout → P8 SDK key/thành viên/audit/quota → P9 đo ngân sách + đột biến +
sửa thiết kế + hồi quy.

Hai thứ cần người dùng quyết trước khi tới P2:

1. **Font** (QĐ-2): bản mẫu đã duyệt dùng Geist, nhưng metadata npm không nói nó có phủ
   dấu tiếng Việt hay không. P2 sẽ **đo** (tải woff2, đọc bảng `cmap`, khẳng định phủ
   U+1EA0–U+1EF9); thiếu thì chữ chuyển sang Be Vietnam Pro, mono giữ Geist Mono.
2. **Tiền đề rollout** (§1.2 của SPEC): P7 chỉ chạy được đầu-cuối khi project đã có một
   cluster và một Prometheus có sẵn. Không có thì hạ P7 xuống chỉ ĐỌC với mã nợ
   `portal-rollout-create`.
