# Plan #64 - Kế hoạch: bốn lỗi của lượt CI #46, và hai lỗi lộ ra sau khi sửa chúng

Spec: `docs/plans/plan64-spec.md` (64a-64d). Tệp này ghi lại 64a-64d đã làm ngày 16-17/10/2026 và kế hoạch của ba
đợt đóng plan 64e-64g (21/10/2026). Mỗi đợt có cổng viết TRƯỚC, chạy cho thấy đỏ trên mã hiện tại, rồi mới sửa cho
xanh, rồi một commit một dòng tiếng Anh (chỉ ở máy, không push).

Đợt 64e-64g chạm khoảng 15 tệp, sửa một bất biến (I29) và một tuyên bố đóng góp (C2) trong thiết kế ⇒ **trên ngưỡng
R2**: ba vòng QA độc lập đã chạy lần lượt trên bản nháp trước dòng mã đầu; phần cuối ghi từng chỗ plan bị bẻ.

**Nối tiếp (R3):** Plan #63 (nhánh `p61-dong-goi`, PR #1) và 64a-64d (nhánh `p64-sua-loi-ci`, PR #2). Giữ nguyên:
`UDP_DB_TLS_MODE` hai giá trị, mặc định `verify-full`, rào host nội bộ cho `disable`; `DbIdentityMismatchError` và
`describeBootFailure`; catalog đồng bộ bằng danh tính owner qua `syncDomainCatalog` (`@udp/db`), chạy vô điều kiện
trong job `udp-migrate` dù `UDP_SEED` là gì (lý do tách của `5b4088a`); boot chỉ KIỂM registry ⊆ catalog;
`Kube` của installer đồng bộ; cổng 8099 của bồn nhận sao lưu trong lượt CI; mọi cổng của `design-lint`.

**Mốc lùi (R10):** đỉnh `340b316`, cây sạch. Mỗi đợt một commit ⇒ lùi từng đợt bằng `git revert`. Không đợt nào
đổi schema, migration hay `pnpm-lock.yaml`.

---

## 64a-64d - đã làm (16-17/10/2026)

| Đợt | Gốc lỗi (lượt CI #46, run `38879844829`)                                      | Sửa                                                                       |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 64a | `signing-e2e`: skopeo từ chối ref vừa tag vừa digest                          | `BASE` chỉ ghim digest, cổng âm trong `ci-workflow.test.ts`               |
| 64b | `kind`, `vm`: ba đường mở kết nối ép TLS, postgres kèm cụm không có SSL       | `UDP_DB_TLS_MODE` qua env-schema, rào host nội bộ, ConfigMap của cụm      |
| 64c | log boot dán nhãn mọi lỗi là "danh tính sai"                                  | `DbIdentityMismatchError` + `describeBootFailure` ở ba service            |
| 64d | I34 và test thu hồi khoá flaky trong lúc Service 2 tắt êm                     | chờ tới khi chính lúc đọc thấy `stale=true`                               |
| -   | `vm`: core-backend không lên vì catalog rỗng (`RegistryCatalogMismatchError`) | `5b4088a`: `scripts/sync-catalog.ts` trong job migrate, gộp vào `340b316` |

Lượt `39024324636` (`340b316`): `signing-e2e`, `kind` xanh lần đầu; còn hai job đỏ - hai gốc lỗi dưới đây.

## Hai gốc lỗi mới

**G5 - `test`: database dùng một lần có catalog rỗng.** `340b316` bỏ phần nạp catalog trong `seed.ts`, còn
`sync-catalog.ts` chỉ được gọi trong `migrate.Dockerfile`. `test-scratch.ts:96` và `verify-chain.ts:100` chạy
`migrate deploy` rồi `seed.ts` ⇒ khoảng 40 test chết ở FK `domain_configs_domain_type_fkey`, test sync của
`domain-registry.test.ts` đọc bản khai rỗng từ chính database. Lượt trước đó (`7b62f2e`, seed còn nạp catalog):
`test` xanh 157/157 tệp, 4570/4570 test. Thân `syncDomainCatalog` cũ và mới giống hệt từng dòng (diff bỏ chú thích).

**G6 - `vm`: tiến trình test tự khoá chết.** Bồn nhận sao lưu (`startSink`) là HTTP server trong tiến trình vitest;
`kube.run(["wait", …, "--timeout=300s"])` đi qua `spawnSync` (`deploy/src/shell.ts`) và chặn event loop 300 giây
⇒ server không đọc được upload. Log: curl bắt đầu 11:28:55, kết thúc 11:33:53 - đúng giây `wait` hết giờ và
`sink.close()` ngắt kết nối ⇒ mã 56. Tái hiện trên máy (Node 22.20, curl 8.10.1, 3 MiB): sync ⇒ 0 byte, curl 56
`Recv failure: Connection was reset`; async ⇒ 3 145 733 byte, curl 0.

---

## 64e - Catalog có ở mọi đường seed

### 64e-1. Cổng `catalog-seeded.test.ts` (viết trước)

- **Làm gì:** sau seed, mỗi mục của `DOMAIN_CATALOG_SEED` có một hàng `domain_catalog` cùng `tier`, `display_name`,
  `default_order` và `is_available = true`. Không khẳng định "tập hàng available bằng bản khai": database dev có thể
  còn hàng tạm của test core-backend.
- **Ở đâu:** `packages/db/tests/invariants/catalog-seeded.test.ts` (mới), dùng `openClient` của `helpers/db.ts`,
  bản khai từ `@udp/config/domains` (subpath thuần).
- **Hệ quả:** chạy trong `pnpm db:verify-chain` và trong `test:scratch` của CI, cả hai trên database mới dựng ⇒ đỏ
  trên `340b316`, xanh sau 64e-2. Trên database dev nó xanh ngay (catalog còn từ lần seed cũ) - bằng chứng đỏ chỉ
  lấy từ `verify-chain`.
- **Lan sang:** không.
- **Ai dùng hôm nay:** `verify-chain` bước 3/4, `test:scratch`.

### 64e-2. Seed gọi `syncDomainCatalog`

- **Làm gì:** đầu `main()` của `seed.ts` gọi `syncDomainCatalog(prisma, DOMAIN_CATALOG_SEED)` và in số domain đã
  đồng bộ; bỏ hai chú thích "catalog do sync-catalog đồng bộ riêng".
- **Ở đâu:** `packages/db/prisma/seed.ts`.
- **Hệ quả:** `test:scratch`, `verify-chain`, `pnpm db:seed` và `prisma db seed` đều có catalog. Một hàm, một bản
  khai, một danh tính (owner) cho cả hai chỗ gọi. Job migrate có `UDP_SEED=true` đồng bộ hai lần - upsert, vô hại.
  Khác seed trước `340b316` ở một điểm: hàng không còn trong bản khai bị đánh dấu `is_available = false` - đúng ngữ
  nghĩa I29; trên database mới dựng không có hàng nào như vậy.
- **Lan sang:** chú thích đầu `deploy/docker/migrate.Dockerfile` và `deploy/k8s/base/migrate-job.yaml`; chú thích
  `packages/config/src/domains.ts:3-16` (câu "SCAFFOLD TẠM THỜI… không được thành đường ghi thứ hai" đã sai từ 25/09:
  bản khai này là nguồn ghi duy nhất của bảng).
- **Kiểm thoái cấp (R11):** `sync-catalog.ts` vẫn chạy vô điều kiện trong job migrate ⇒ ý đồ của `5b4088a` giữ
  nguyên. Không thêm bước vào từng script dựng database: bốn chỗ phải nhớ là đúng loại lỗi vừa xảy ra.

## 64f - Bồn nhận sao lưu không bị chặn event loop

### 64f-1. `runAsync` và cổng của nó (viết trước)

- **Làm gì:** `runAsync(command, args): Promise<void>` cạnh `run`: gọi `spawn` trong executor của Promise (lỗi đồng
  bộ như `EINVAL` thành reject), nghe `error` (ENOENT không phát `exit`) và `close`, ném kèm câu lệnh và mã thoát
  hoặc tên tín hiệu. Không `shell` (đường `node.exe` có dấu cách). Lệnh gọi qua nó phải tự có hạn - vitest 2.1.9
  không có tín hiệu huỷ để truyền xuống.
- **Ở đâu:** `deploy/src/shell.ts`; cổng ở `deploy/tests/shell.test.ts`: một HTTP server trong tiến trình test, tiến
  trình con (`process.execPath`) PUT 3 MiB tới nó với `AbortSignal.timeout`, chờ bằng `runAsync` ⇒ server nhận đủ.
  Cổng, đường tệp truyền vào con qua `argv`. Thêm ô `runAsync` của lệnh không tồn tại ⇒ reject, và thoát khác 0 ⇒
  thông điệp có mã.
- **Hệ quả:** bản đỏ (cùng ô chờ bằng `run`) kết thúc sạch với mã 2 của con và 0 byte, không treo.
- **Lan sang:** không.
- **Ai dùng hôm nay:** `pinnedKubectlAsync` (64f-2), cổng shell.

### 64f-2. kubectl bất đồng bộ cho test sao lưu

- **Làm gì:** `pinnedKubectlAsync(pin)` cạnh `pinnedKubectl` (ghép pin một chỗ); `kubeAsync` trong
  `deploy/e2e-vm/support.ts`; test sao lưu `create job` và `wait` đổi sang `await kubeAsync.run(…)`; khi `wait`
  hỏng thì in `kubectl logs job/<job> --all-containers` trước khi ném.
- **Ở đâu:** `deploy/src/install.ts`, `deploy/e2e-vm/support.ts`, `deploy/e2e-vm/vm.e2e.test.ts`.
- **Hệ quả:** server phục vụ upload trong lúc chờ job. `Kube` của installer giữ đồng bộ - không ai khác đổi.
- **Lan sang:** không.
- **Ai dùng hôm nay:** `vm.e2e.test.ts`.

### 64f-3. `startSink` đóng được khi còn upload dở, và không im lặng nghe cổng ngẫu nhiên

- **Làm gì:** `close` gọi `server.closeAllConnections()`; ném khi URL không có cổng (`Number("")` là 0 ⇒ cổng ngẫu
  nhiên). Cổng 8099 của lượt CI không đổi (ghi vào `vm.env` và Secret `udp-backup` trước khi test chạy).
- **Ở đâu:** `deploy/e2e-vm/support.ts`.
- **Hệ quả:** ở nhánh hỏng, `finally` của test không kẹt tới hết 15 phút của bước CI.

## 64g - Tài liệu (R4)

- `docs/UDP_design.md`:
  - **C2 nói thật (A1).** Bảng C2 ở §5.3: một DOMAIN dùng capability đã có = **1** tệp
    (`packages/config/src/domains.ts`: union `DomainType` và bản khai catalog), cần capability mới = **2**. Đây là
    đường rò thứ mười một, cùng lý do với D-6: giữ kiểm kiểu lúc biên dịch của union `DomainType`. Thêm TOOL vẫn là
    0 (E1 đã đo: 0 trên 11 lô). Sửa theo: dòng C2 ở bảng đóng góp, §2.2, ER, §5.3, §14 E1, phát biểu cuối của C2.
  - **Catalog (A2, A3, A8, A9):** catalog đồng bộ từ `DOMAIN_CATALOG_SEED` bằng owner (job migrate luôn, seed);
    boot chỉ kiểm registry ⊆ catalog. Viết lại I29 theo mã; chiều ngược (domain còn available mà không còn adapter)
    không được kiểm - ghi thành giới hạn §16. Thêm hàng `DomainCatalog` vào ma trận writer §1.2.
  - **TLS (A4, A5, A6):** mối đe doạ mới T15 (nghe lén, MITM đường service tới Postgres) với `UDP_DB_TLS_MODE`,
    CA ghim, gỡ tham số TLS khỏi chuỗi kết nối, rào host nội bộ; mã trích T15 thay T2. §15: máy công khai chạy
    plaintext trong mạng pod của k3s một node. §16: giới hạn đó nói thẳng phạm vi rủi ro, biện pháp bù hiện có (không
    có NetworkPolicy - postgres chỉ có Service ClusterIP), điều kiện gỡ. Hàng `sslmode=require` cập nhật.
  - **§13.5 và D-P56 (A7):** đoạn "[Plan #64]" nêu G5, G6 và cổng cho từng loại; bài học "tiến trình chờ đồng bộ
    không được giữ server trong cùng tiến trình".
- `docs/measurements/kiem-chung-con-no.md` mục `ci-github-green`: trạng thái CI sau 64a-64d. Câu mới ở §16 không trích
  `Sổ nợ:` nên số mục giữ 53.
- `docs/ban-giao/trang-thai-2026-10-21.md`.

## Kiểm cuối (R9) và kiểm thoái cấp (R11)

`pnpm db:verify-chain` (đỏ trước 64e-2, xanh sau); `pnpm --filter @udp/deploy test` (cổng shell đỏ với `run`, xanh
với `runAsync`); `pnpm --filter @udp/design-lint test`; typecheck `@udp/db`, `@udp/deploy`; eslint và prettier theo
danh sách tệp đổi (eslint toàn repo hết RAM trên máy 7,7 GiB). Kết quả trên runner: lượt CI sau khi chủ repo push.
Kiểm thoái cấp: với mỗi chỗ sửa, hỏi vì sao bản cũ viết như thế (đã ghi ở từng mục).

## Ba vòng QA đã bẻ gì (một vòng, chạy lần lượt)

- **A (thiết kế):** 64g ban đầu chỉ sửa câu "đồng bộ lúc khởi động" ⇒ thiết kế sẽ vừa nói catalog từ
  `DOMAIN_CATALOG_SEED` vừa nói "thêm domain 0 tệp" (A1); I29 chỉ được kiểm một chiều (A2); thiếu mười dòng cần sửa
  (A3); T2 không nói về MITM mà mã trích T2 (A4); máy công khai là production, không được giảm nhẹ (A5).
- **B (mã và plan trước):** bản đỏ của cổng 64f bằng `spawnSync` sẽ **treo** cả bộ test, không đỏ - con phải tự có
  hạn (B-7, blocker); cổng 64e đặt ở `invariants/` và chỉ đỏ trên database mới (B-4); trích `Sổ nợ:` ở §16 sẽ đòi mục
  thứ 54 (B-13); khuôn plan và kiểu commit (B-14).
- **C (đúng kỹ thuật):** Prisma 7.10 `migrate reset` không chạy seed - câu đó trong bản nháp sai (C-1); hợp đồng sự
  kiện của `spawn` đo trên Node 22.20 (C-2); `server.close()` treo khi còn upload dở (C-7); không được đổi cổng 8099
  của lượt CI (C-8). Đã đo: Node tự trả `100 Continue`, client chết giữa chừng không để lại hàng rác, `vm-restore`
  chạy trong pod nên không vướng TLS.
