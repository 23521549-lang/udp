# Bàn giao - UDP, 21/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-09.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần Plan #63. Nguồn sự thật của thiết kế là `docs/UDP_design.md`; của phép đo là
`docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là `docs/plans/`.

**Trạng thái một câu:** Plan #64 (nhánh `p64-sua-loi-ci`, PR #2, đích `p61-dong-goi`) đã sửa bốn lỗi của lượt CI #46
(64a-64d, 16-17/10) và hai lỗi chỉ lộ ra sau đó (64e, 64f, 21/10), cùng với tài liệu (64g). **Mọi cổng chạy được trên
máy đều xanh, nhưng chưa có lượt CI nào chạy trên mã mới**: còn chờ chủ repo push. **53 mục nợ kiểm chứng.**

---

## 1. Nhánh và PR

| Nhánh            | Đỉnh          | Vai                                                              |
| ---------------- | ------------- | ---------------------------------------------------------------- |
| `main` (remote)  | `46a1049`     | Plan #15 (12/09) - lượt đêm vẫn chạy trên đây                    |
| `p61-dong-goi`   | `46d6ed6`     | Plan #16-#63, PR #1 vào `main`                                   |
| `p64-sua-loi-ci` | sau `caabeca` | Plan #64, PR #2 (nháp) vào `p61-dong-goi`; nhánh local chưa push |

`fix/catalog-sync-migrate-job` (remote) tách từ `main` cũ và đã được gộp vào `p64-sua-loi-ci` bằng squash (`340b316`);
không còn gì riêng trên đó.

## 2. Lượt CI gần nhất (17/10, `340b316`, run `39024324636`)

`check`, `python`, `i28`, `portal-demo`, `signing-e2e`, `kind` **xanh** (`signing-e2e`, `kind` lần đầu). Hai job đỏ:

- **`test` (G5):** `340b316` bỏ phần nạp catalog khỏi `seed.ts`, còn `sync-catalog.ts` chỉ chạy trong job migrate của
  cụm. `test:scratch`, `verify-chain` chạy migrate rồi seed ⇒ catalog rỗng ⇒ khoảng 40 test tích hợp chết ở FK
  `domain_configs_domain_type_fkey`. Lượt trước đó (`7b62f2e`, seed còn nạp catalog): 4570/4570 test xanh.
- **`vm` (G6):** lần đầu chạy tới test sao lưu. Bồn nhận là HTTP server trong tiến trình vitest; `kubectl wait` qua
  `spawnSync` đứng yên event loop 300 giây ⇒ server không đọc được upload ⇒ curl của CronJob thoát 56 đúng giây bồn
  đóng. Tái hiện trên máy: chờ đồng bộ nhận 0 byte, chờ bất đồng bộ nhận đủ 3 MiB.

## 3. Plan #64 đợt 64e-64g (spec và plan: `docs/plans/plan64-spec.md`, `plan64-plan.md`)

Ba vòng QA độc lập chạy lần lượt trên bản nháp; plan ghi từng chỗ bị bẻ.

| Commit    | Đợt      | Nội dung                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------ |
| `1b37b03` | 64e cổng | `packages/db/tests/invariants/catalog-seeded.test.ts` + `plan64-plan.md`                         |
| `9199499` | 64e      | seed gọi `syncDomainCatalog` (một hàm, hai chỗ gọi, cùng owner); chú thích `domains.ts` nói thật |
| `29f207d` | 64f cổng | `runAsync` trong `deploy/src/shell.ts`; ba ô trong `deploy/tests/shell.test.ts`                  |
| `4281e94` | 64f      | `pinnedKubectlAsync`, test sao lưu chờ bất đồng bộ và in log job khi hỏng; `startSink` đóng được |
| `caabeca` | 64g      | thiết kế, cổng ma trận writer nhận hàng `Owner`, số đo `test:scratch`, tiến độ `ci-github-green` |

Bằng chứng trên máy:

- `@udp/deploy`: 87/87 test. Cổng `runAsync` đỏ khi chờ bằng `run` (con thoát 2 sau 5,1 giây, server nhận 0 byte),
  xanh với `runAsync`; vòng đột biến khôi phục bằng `cp`, khớp từng byte.
- `@udp/config` 84/84; `@udp/design-lint` 31/34 tệp (ba tệp còn lại cần database - xem mục 4); `measurements` 16/16.
- typecheck `@udp/db`, `@udp/config`, `@udp/deploy`, `@udp/design-lint`; eslint và prettier theo tệp đổi.
- Ma trận writer bóc từ thiết kế mới: cả sáu hàng xác định được writer (`DomainCatalog` là `owner`).

## 4. Chưa chứng minh được - đọc trước khi tin mục 3

1. **Database Supabase dev không truy cập được** (21/10): mọi test chạm database trả
   `(ENOTFOUND) tenant/user postgres.<ref> not found` - kể cả `i22-writer-matrix` có sẵn, nên không phải lỗi của mã
   mới. Thường là project gói free bị tạm dừng vì không dùng. Hệ quả: `pnpm db:verify-chain` (bằng chứng đỏ rồi xanh
   của cổng `catalog-seeded`), `writer-matrix.test.ts` (đối chiếu hàng `Owner` với GRANT thật),
   `schema-conformance`, `ledger-row-conformance` **chưa chạy**. Khôi phục project trên Supabase rồi chạy lại hai lệnh:
   `pnpm db:verify-chain` và `pnpm --filter @udp/design-lint test`.
2. **CI.** Lượt `39495017234` (`786d7a7`, mã của mục 3): `check`, `python`, `i28`, `signing-e2e`, `kind`,
   `portal-demo` xanh. `vm` 10/11: sao lưu và khôi phục **chạy trọn** (64f đúng), nhưng đăng nhập 50 ms sau
   `rollout status` nhận 502 - nginx của Portal gọi `core-backend` khi endpoint của Service chưa tới kube-proxy. Sửa
   ở `9737605` (mục 3b), chưa chạy trên runner. Một rủi ro thấp còn đó: `ALTER DATABASE RENAME` trùng lúc
   readinessProbe nối vào `udp` (QA C).

## 3b. Sửa thêm trong lúc chờ CI (21/10)

| Commit    | Nội dung                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `786d7a7` | `verify-chain` in lý do lượt chạy hỏng (từng nuốt lỗi); `runFailureDetail` dùng chung với `test-scratch`     |
| `ec8f0fd` | Portal: ProblemDetails thiếu `type` ⇒ `about:blank` (RFC 9457) - màn báo lỗi từng ném `TypeError`            |
| `4bc160c` | Portal: trùng key React làm đỏ test; mock `GET /admin/jobs` lọc theo `state` như máy chủ                     |
| `456835d` | Portal: request không ai khai làm đỏ test (MSW `"error"` chỉ in); khai ba handler còn thiếu ở `project-ux58` |
| `9737605` | E2E máy ảo: đăng nhập sau khôi phục chờ qua 502/503/504 của tầng proxy, tối đa 60 giây                       |

Cả ba lỗi Portal chỉ lộ trong log của lượt CI xanh, không làm ô nào đỏ - nay mỗi loại có cổng. Portal 366/366 test,
demo 17/17.

## 5. Thiết kế đã đổi gì (D-P56) - cần biết trước khi bảo vệ

- **C2 nói thật một lần nữa:** thêm một TOOL vào domain đã có = **0** tệp ngoài thư mục adapter (I28 cưỡng chế, E1 đo
  0 trên 11 lô). Thêm một DOMAIN = **1** tệp (`packages/config/src/domains.ts`), thêm **1** nữa nếu cần capability
  mới. Bản trước ghi 0 cho domain, nhưng mã chưa bao giờ như vậy (từ 24-25/09): catalog do owner ghi từ bản khai
  `DOMAIN_CATALOG_SEED`, registry chỉ được kiểm khớp lúc khởi động. Đây là "đường rò thứ mười một" ở §5.3, cùng lý do
  với D-6 (giữ kiểm kiểu union `DomainType`) và với ma trận writer §1.2 (service không ghi dữ liệu nền tảng).
- **I29** viết lại theo mã; chiều ngược (domain còn dùng được mà không còn adapter) thành giới hạn §16.
- **T15** (nghe lén, MITM đường service → PostgreSQL) và giới hạn §16: máy công khai chạy plaintext trong mạng pod
  của k3s một node; điều kiện gỡ ghi trong hàng đó.

## 6. Việc tiếp

1. **Push và đọc CI:** `git push origin p64-sua-loi-ci`, rồi `gh run list --branch p64-sua-loi-ci --limit 1`. Đọc
   trước khi kết luận gì - bài học của 04/10.
2. Khôi phục project Supabase dev rồi chạy hai lệnh ở mục 4.1.
3. PR #2 xanh ⇒ gộp vào `p61-dong-goi` ⇒ PR #1 chạy lại ⇒ xanh thì gộp vào `main` ⇒ pha 2 của `ci-github-green`.
4. Rồi `sdk-publish-real`, và E5 (bằng chứng của C1, chưa chạy).
5. Ngoài phạm vi, đã ghi nhận: lượt đêm trên `main` (Plan #15) đỏ hai lần ở `test` (09/10, 17/10) - hết khi PR #1
   vào `main`. Nhánh local `main`, `ux58-prototype` đã nằm trọn trong `p64-sua-loi-ci`; nhánh remote
   `fix/catalog-sync-migrate-job` đã vào qua squash `340b316`, xoá khi PR #1 vào `main`.

## 7. Máy này

7,71 GiB RAM, còn khoảng 0,9-1 GiB trống trong phiên này; mọi phép kiểm ở mục 3 chạy được ở mức đó. Node 22.20.0
(repo đòi `>=22.22.2`). ESLint toàn repo vẫn hết bộ nhớ: lint theo tệp đã đổi.
