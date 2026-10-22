# Bàn giao — UDP, 09/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-10-04.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên phần Plan #61, #62 và đợt 62d. Nguồn sự thật của thiết kế là `docs/UDP_design.md`;
của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là `docs/plans/`.

**Trạng thái một câu:** bàn giao 04/10 kết luận "không còn việc nào plan được mà máy làm được" — nhưng **PR #1
(nhánh `p61-dong-goi`, Plan #16–#62) chưa từng xanh trên GitHub**: lượt CI đầu (03/10, run `37154337078`) đỏ bốn
job, và không ai đọc nó. **Plan #63** tìm năm gốc lỗi, mỗi cái hoá ra là một **loại** (phép quét cùng loại tìm thêm
bốn entry sẽ đỏ, một bất biến xanh giả, một rủi ro concurrency), sửa cả loại và thêm cổng cho từng loại — **mọi cổng
xanh tại chỗ**. Kết quả trên runner thật còn nợ một lượt push: sổ nợ `ci-github-green`. **53 mục nợ kiểm chứng.**

---

## 1. Đọc trước: lượt CI đầu nói gì

| Job           | Dòng lỗi                                                             | Gốc                                                                                |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `signing-e2e` | `Cannot find module '…/packages/db/src/generated/prisma/client.js'`  | script ký nạp `@udp/http` gốc → `@udp/db` và `@udp/config` gốc (parse env lúc nạp) |
| `test`        | `fixture-constants.test.ts:226`, rồi `timed out after 40 minutes`    | clone nông; bộ test cần ~64 phút                                                   |
| `kind`        | `ECONNREFUSED 127.0.0.1:8080` — `pnpm deploy:up` "xanh" sau 7,6 giây | `pnpm --filter @udp/deploy up` = `pnpm update` (`up` là bí danh có sẵn)            |
| `vm`          | pod: `CORE_BACKEND_PORT: Expected number, received nan`              | kubelet tiêm `CORE_BACKEND_PORT=tcp://…` từ Service `core-backend`                 |

Log đầy đủ: `gh run view 37154337078 --job <id> --log-failed`.

## 2. Plan #63 — sáu đợt, mỗi đợt một commit, cổng đỏ trước rồi mới sửa

Spec và plan: `docs/plans/plan63-spec.md`, `plan63-plan.md` (kèm mục "Ba agent QA đã bẻ gì").

- **63a — entry của CI đi qua subpath thuần.** `@udp/http` có hai subpath thuần mới (`/errors`, `/flagger-gate`);
  sáu chỗ import đổi sang subpath (`build-script.ts`, `sign-script.ts`, `signing-keys.ts`, `deploy/tests/vm.test.ts`,
  `deploy/e2e-vm/vm.e2e.test.ts`, `design-lint/tests/references.test.ts`). Cổng
  `design-lint/tests/ci-entry-purity.test.ts` (esbuild `metafile`, cả danh sách dưới một giây): **đỏ đúng năm entry** trên
  mã cũ, kèm đường import tới tệp bẩn; đỏ cả khi đồ thị có `import()` không literal — esbuild không đi theo cạnh đó và
  không cảnh báo (đo trên `domain-adapter.registry.ts`). Bộ đọc workspace của `design-lint` thành tệp dùng chung
  `tests/workspace.ts`.
- **63b — `kind-up`/`kind-down`.** Cổng `design-lint/tests/script-names.test.ts` dò 71 tên script bằng chính pnpm ghim,
  **qua script đánh dấu**: đỏ đúng `up` rồi xanh.
- **63c — service link.** `enableServiceLinks: false` ở chín pod template; `effectiveEnv` (`deploy/tests/kustomize.ts`)
  theo `pkg/kubelet` v1.34 — trên manifest cũ nó in **đúng nguyên văn** lỗi của pod CI, bốn khoá `*_PORT` ở cả hai
  overlay. Biến của Service `kubernetes` vẫn được tiêm (kubelet luôn tiêm service master) — `platform-probe.ts` không đổi.
- **63d — job `test`, I35, runner, concurrency.** `fetch-depth: 0`; trần `test:scratch` 90 phút với căn cứ đo ngay
  cạnh; cổng thứ tự của `adapter-core` và I35 tự đỏ khi clone nông (chứng minh bằng một clone `--depth 1` thật: ba đường
  cùng "được thêm" ở một commit); concurrency có `event_name`, chỉ huỷ lượt PR; runner `ubuntu-24.04` trừ `build-smoke`,
  `signing-e2e` — hai job diễn tập pipeline sinh cho khách, chạy đúng nhãn của pipeline đó (`GITHUB_ACTIONS_RUNNER`
  mới ở `@udp/config/build-toolchain`; đầu ra cho khách không đổi một byte — wire golden 124 ô, contract 54 ô xanh).
- **63e — README** nói đúng Node `≥ 22.22.2`, pnpm `9.12.0`, đủ mọi package; cổng `design-lint/tests/readme.test.ts`.
- **63f — tài liệu.** §3.1, §13.1, §13.5, §15.1 (câu "cấu hình mà service từ chối là test đỏ, không phải pod crash" sai
  cho tới đợt này — đã ghi), §16 (dòng Plan #50 và dòng mới "bộ test ~64 phút, một chỗ chờ"), D-P55; mục nợ
  `ci-github-green`.

## 3. Ba điều phải biết trước khi sửa gì ở đường này

1. **Đừng dò "tên X có phải lệnh có sẵn của pnpm" trong một thư mục rỗng.** Tên không phải lệnh có sẵn rơi về `exec`
   và pnpm chạy chương trình cùng tên trên PATH qua shell — gốc repo có script `format`, mà trên Windows `format` là
   trình định dạng ổ đĩa. Phép dò khảo sát đầu tiên của đợt này đã chạy `format --help` một lần (thoát khác 0, không
   gây hại) trước khi QA C chỉ ra. Cổng hiện tại khai MỌI tên làm script đánh dấu nên không bao giờ rơi về `exec`.
2. **esbuild mù với `import()` mà đối số không phải chuỗi literal** — không cạnh, không cảnh báo. Cổng
   `ci-entry-purity` đỏ khi gặp nó; đừng "sửa" bằng cách thêm tệp đó vào danh sách miễn.
3. **Một entry mới mà CI chạy không có env** (script, test của cổng phát hành) phải import subpath thuần. Nếu cổng đỏ
   với `nạp packages/config/src/env.ts: <đường>`, sửa chỗ import đầu tiên trên đường đó, không cấp env cho job.

## 4. Việc tiếp

1. **Push và đọc CI** — sổ nợ `ci-github-green`, runbook hai pha. `git push origin p61-dong-goi`; PR #1 tự chạy lại.
   Lỗi kế tiếp (nếu có) chỉ lộ khi lỗi trước được sửa — nhất là ở `kind` và `vm`, nơi lượt đầu chưa từng đi qua
   bước dựng cụm.
2. Khi pha 1 xanh: **merge PR #1** vào `main`, rồi pha 2 (`build-smoke`, lượt chạy tay `toolchain.yml`,
   `publish-rehearsal.yml`).
3. Rồi `sdk-publish-real` (runbook năm bước, không đổi) và bật **Required reviewers** cho `release-npm`/`release-pypi`.
4. Hai hướng đã cân nhắc và cố ý KHÔNG làm trong đợt này (lý do ở spec §4): ghim nhãn runner cho pipeline sinh cho
   khách; chạy job `vm` trên runner arm64 (`ubuntu-24.04-arm`, máy thật là Ampere A1) — đổi một biến mỗi lần, sau khi
   x86 xanh.

## 5. Máy này

7,71 GiB RAM, thường còn 0,3–0,9 GiB trống trong phiên này. Mọi phép kiểm của đợt chạy được ở mức đó (typecheck
`core-backend` 19 giây khi còn ~0,9 GiB). Node ở máy 22.20.0 trong khi repo đòi `>=22.22.2` — vitest vẫn chạy, nhưng
nên nâng (việc của chủ máy). ESLint toàn repo vẫn hết bộ nhớ: lint theo tệp đã đổi.
