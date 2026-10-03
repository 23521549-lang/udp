# Bàn giao cuối — UDP, 29/09/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-09-27.md` ở vai "điểm bắt
đầu cho người tiếp theo"; tệp đó và `viec-con-lai-2026-09-28.md` vẫn giữ nhật ký chi tiết. Nguồn sự thật của
thiết kế là `docs/UDP_design.md`; của phép đo là `docs/measurements/` (số thô trong `raw/`, nợ trong
`kiem-chung-con-no.md`); của từng plan là `docs/plans/planNN-spec.md` + `planNN-plan.md`.

**Trạng thái một câu:** mọi thứ thiết kế hứa mà làm được bằng mã đã có mã và test; phần còn lại là 43 mục nợ
kiểm chứng, mỗi mục cần hạ tầng (cluster thật, cloud, SaaS, runner, máy Oracle) hay người thật — không mục nào chỉ
cần viết mã. Hạ tầng của dự án tốn đúng 0 đồng và không chạy trên máy người dùng (D-P37, D-P41, yêu cầu cứng):
cụm kind ở máy dev/CI, và một máy ảo Oracle Cloud Always Free cho bản công khai.

## 1. Đã làm — theo nhóm

| Nhóm              | Plan    | Nội dung                                                                                                                                                                                                                | Commit tiêu biểu                |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Nền → hoàn thiện  | #1–#42  | Xem `trang-thai-2026-09-27.md` §1: monorepo, ba service, 72/72 tool của §5.5, Portal, provisioning thật, E1/E8                                                                                                          | `354fcee` … `ab13620`           |
| Khoảng trống §9   | #43–#45 | Định dạng xanh lại; Luồng 4 đủ route (PUT variants, promote); route còn thiếu của Domain/Deployment, Tổng quan đủ §10.6 (D-P33)                                                                                         | `e5cc139`, `1d2e210`, `5d14ba7` |
| Luồng 5 mức flag  | #46     | ATTRIBUTE_SPLIT ở FLAG_LEVEL: không tự quyết, PROMOTE đổi default variant (D-P34)                                                                                                                                       | `985d8b7`                       |
| SDK Python        | #47     | `sdks/python` (`udp-openfeature`): lõi đánh giá viết lại, tương đương với Node qua vector + 20k probe + Service 2 thật; middleware ASGI/WSGI; ngữ pháp regex khả chuyển (D-P35)                                         | `e2c3512`                       |
| Golden Path       | #48     | Template Node/Python là dự án chạy được; quét repo Import Existing; `service.version` theo image (D-P36)                                                                                                                | `02254c8`                       |
| Hạ tầng chi phí 0 | #49     | `deploy/`: Dockerfile (service chạy `tsx`), Kustomize base + overlay kind, `pnpm deploy:up/down`; cấu hình cụm kiểm bằng schema env (D-P37)                                                                             | `2b300b6`                       |
| CI/CD §13.5       | #50     | Job `i28` (cổng git-diff), job `kind` (`deploy:up` + E2E rút gọn 7 kiểm tra), E9 ở làn đêm thành artifact, chẩn đoán cụm khi đỏ; kubectl ghim `kind-udp` (D-P38)                                                        | `8b94101`                       |
| SERVICE_LEVEL     | #51     | `@udp/cluster-access` dùng chung; route token cho S3 (chỉ `traffic`, I24c); RBAC `rollouts/status` (D-P39); S1 ghi Rollout/Canary theo ma trận §7.2 (I4); S3 promote/abort, gate Flagger (I5); Portal (D-P40)           | `75adb5d`, `e55c1e1`, `db01b7f` |
| Máy công khai     | #52     | Máy ảo Oracle Always Free + k3s, overlay `vm` (HTTPS, cert-manager, đúng bề mặt công khai của §9), sao lưu ra Object Storage + khôi phục, `bootstrap.sh`, workflow `Deploy` sau CI xanh, job `vm` diễn tập ở CI (D-P41) | `5a92dc1`, `523a7f0`            |

## 2. Cưỡng chế

Bất biến đánh số (I1…I40) ở §13.3, mỗi dòng nêu phép kiểm. Chốt cấu trúc ở `packages/design-lint/tests/` (25
tệp, đỏ là build đỏ) — bảng đầy đủ ở `trang-thai-2026-09-27.md` §2; thêm từ #50: `i28-gate` (cổng git-diff
trên repo git thật tạm). Chốt đáng nhớ trong mã ứng dụng:

| Chốt                                                                              | Ở đâu                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Mọi route JSON có schema `.strict()` + mẫu thật                                   | `services/core-backend/tests/wire-golden.test.ts`                        |
| I4 — udp-driven không `analysis` (sau merge patch)                                | `services/core-backend/tests/delivery.test.ts`                           |
| I5 — tool-driven: 0 lời ghi của S3 qua 10 vòng                                    | `services/pd-controller/tests/service-level.integration.test.ts`         |
| I24c — token cho S3 ≤ 1 giờ; chỉ `traffic`                                        | `services/core-backend/tests/internal-cluster-token.integration.test.ts` |
| I28 — thêm adapter không chạm tệp ngoài thư mục của nó                            | job CI `i28` + `packages/design-lint/tests/i28-gate.test.ts`             |
| Nối dây CI (thứ tự bước, làn đêm, artifact)                                       | `deploy/tests/ci-workflow.test.ts`                                       |
| Cấu hình cụm qua CHÍNH schema env                                                 | `deploy/tests/manifests.test.ts`                                         |
| Máy công khai: từng service qua `envSchema`, route công khai/nội bộ, TLS, sao lưu | `deploy/tests/vm.test.ts`                                                |
| Secret đang chạy chỉ được BỔ SUNG, không ghi đè                                   | `deploy/tests/install.test.ts`                                           |

## 3. CI và lượt đẩy đầu tiên

`.github/workflows/ci.yml` có sáu job: `check` (typecheck, lint, format), `python` (ruff, mypy, pytest + template
Golden Path), `test` (bộ test đầy đủ trên database dùng-một-lần — cần secret của project Supabase CI), `i28`,
`kind`, và [#52] `vm` (CHÍNH `deploy/vm/bootstrap.sh` + `release.sh` trên runner, rồi E2E qua HTTPS). Làn đêm
(18:00 UTC) chạy lại tất cả và thêm E9. [#52] `.github/workflows/deploy.yml` phát hành lên máy ảo sau khi CI xanh
cho một lần push lên `main` — thiếu secret của environment `vm` thì bỏ qua.

**Chưa từng chạy thật — lượt đẩy đầu tiên sẽ là lần đầu:** dựng image (Dockerfile của #49), `kind` +
`pnpm deploy:up`, E2E rút gọn, E9, và [#52] job `vm`. #52 đã sửa một lỗi sẽ làm job `kind` đỏ ngay lượt đầu:
bước kiểm công cụ gọi `kubectl version`, lệnh này thoát mã 1 khi chưa có cụm nào (runner mới) — nay hỏi
`kubectl version --client` (`deploy/tests/shell.test.ts`). Máy dev (7,7 GiB RAM, thường trống < 1 GiB) không chạy được Docker, nên các
bước này chỉ có test tại chỗ cho phần tĩnh (manifest, cấu hình, nối dây). Khi job `kind` đỏ, bước
`pnpm --filter @udp/deploy diagnose` in pod, sự kiện, `describe` và log — đọc nó trước khi đoán. Cổng `i28`
trên khoảng `origin/main..HEAD` hiện tại: 99+ commit, 11 lô adapter cũ được liệt kê là "trước cổng", 0 vi phạm.

**E9:** artifact `E9-<run_id>` của lượt đêm (hoặc chạy tay `workflow_dispatch`) → `gh run download <run_id> -n
E9-<run_id> -D docs/measurements/raw` → commit; khi đó số E9 mới tính là "đã đo" (luật của sổ nợ).

**Chi phí 0:** runner GitHub (repo public — miễn phí), không registry; máy công khai là Oracle Always Free trên tài
khoản Free Tier không nâng lên trả phí (bảng chi phí ở `docs/plans/plan52-spec.md` QĐ-12).

**Việc của người dùng để có bản công khai** (làm bằng trình duyệt, `deploy/README.md` §2.1): tạo tài khoản
Oracle Free Tier, máy ảo A1, mở 80/443 ở security list, tên DuckDNS, bucket + PAR chỉ-ghi, chạy `bootstrap.sh`,
điền `~/udp/vm.env`, bốn secret của environment `vm`, chạy workflow `Deploy`, rồi cất `UDP_KEK_V1`.

## 4. Còn nợ — 43 mục

Chi tiết từng mục (vì sao, tiền đề, lệnh, đạt/không đạt, ảnh hưởng tới kết luận):
`docs/measurements/kiem-chung-con-no.md`.

| Cần có                            | Mục                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster Kubernetes mà S1 vào được | `I32-cluster`, `clusteraccess-direct`, `helm-real`, `I24-cluster`, `I25-cluster`, `I34-cluster`, `E16`, `quota-lb-webhook`, `agent-mode`, `cicd-webhook-real`, `db-cost-real`, `portal-rollout-create`, `service-level-cluster` |
| Tài khoản cloud thật (tốn tiền)   | `E2`, `I31-aws`, `I31-gcp`, `I31-azure`, `E15`, `preflight-confidence`, `getkubeauth-that`, `k8s-managed-discovery`, `estimatecost-vs-bill`, `cred-federation`, `iac-security-real`                                             |
| Tài khoản SaaS dùng thử           | `saas-metrics-real`, `saas-logs-real`                                                                                                                                                                                           |
| Runner CI                         | `E4-ci`, `E4-segment`, `stale-perf`, `segment-cap-perf`, `portal-pagination`, `E9`                                                                                                                                              |
| Máy rảnh / Prometheus / Docker    | `E3-quiet`, `E3-stats`, `E5`, `E6`, `E14-prometheus`, `I31-localstack`, `upgrade-rollback-that`                                                                                                                                 |
| Trình duyệt thật, người thật      | `portal-e2e`, `portal-responsive`, `portal-dx`                                                                                                                                                                                  |
| Máy Oracle Free Tier (0 đồng)     | `vm-oracle-real`                                                                                                                                                                                                                |

Cụm kind của CI KHÔNG trả được nhóm đầu: route token và `ClusterAccess` của S1 cần một cluster do Cloud Adapter
dựng (có credential cloud). Một "cloud adapter cho kind" là đường rẻ nhất để trả nhóm đó mà vẫn giữ chi phí 0 —
đề xuất, chưa làm.

## 5. Chạy các cổng trên máy ít RAM

Chạy theo lô ở TIỀN CẢNH, mỗi lô dưới 10 phút, không chạy hai tiến trình vitest cùng lúc:

1. **Service 1** (`services/core-backend`): `src/**/*.test.ts` (72 bộ hợp đồng) một lô; `tests/*.test.ts` theo lô
   7–13 tệp; `provision-job.integration.test.ts` một lượt (~10 phút, chạy nền) hoặc hai lô `-t`;
   `grid-tier2.test.ts` cả tệp một lượt, không chạy gì khác cùng lúc.
2. **Service 2** hai lô ~19 tệp. **Service 3** một lượt (18 tệp, ~3 phút).
3. **Portal**: lô 4–5 tệp (lô lớn hơn đỏ vì hết hạn chờ khi nhiều worker jsdom chạy song song) + `vite build`.
4. **design-lint**, `shared-types`, `http`, `config`, `adapter-core`, `cluster-access`, `experiments`, `deploy`:
   mỗi package một lượt. `sdks/python`: `ruff check . && mypy && pytest -q` trong `.venv`.
5. `eslint` CẦN `NODE_OPTIONS=--max-old-space-size=6144`; chạy nó và `prettier --check` CHỈ trên tệp đã đổi,
   từ gốc repo — `prettier --write` cả thư mục (nhất là từ một thư mục con) đổi định dạng những tệp không liên
   quan, kể cả mẫu golden.
6. Mẫu golden: xoá đúng tệp cần ghi lại rồi `UDP_CAPTURE_WIRE=1` chạy tệp test sinh ra nó; hoàn nguyên mọi mẫu
   khác bị ghi đè ngoài ý muốn.

## 6. Bản xem thử Portal (không cần hạ tầng)

`apps/portal/demo/`: CHÍNH mã Portal (`src/`) chạy với một backend giả lập trong trình duyệt — chặn `fetch` tới
`/api/v1`, dữ liệu mẫu có trạng thái dựng theo mẫu response thật (`services/core-backend/tests/fixtures/wire/`),
hash history cho trang tĩnh. Khu `/app` và trang quản trị `/admin` đều bấm được; thao tác chỉ sống trong trang.
Dữ liệu: 10 người dùng, 8 project ở đủ trạng thái; `checkout-service` có 16 flag, 6 segment, 6 rollout (một
canary tự tiến theo thời gian), ~90 lần deploy/30 ngày cho DORA; `notification-worker` có job dựng hạ tầng chạy
dần. Mọi số là minh hoạ — trang ghi rõ "Bản xem thử · dữ liệu mẫu".

- Đang publish ở một trang Artifact riêng tư của người dùng: https://claude.ai/artifact/768yrS8CTn8zVpmjrmPGko
- Build lại: `pnpm --filter @udp/portal demo:build` ⇒ `apps/portal/demo/dist/` (một tệp JS + một tệp CSS).
- Hợp đồng: `demo/contract.check.ts` gọi MỌI hàm API của Portal qua lớp giả lập — nằm trong `test` của Portal,
  nên API đổi mà bản xem thử lệch là CI đỏ; `typecheck` của Portal kiểm cả `demo/`.
- Lỗi Portal lộ ra khi có dữ liệu thật và đã sửa: cột thời gian của danh sách Flag/Rollout gãy ba dòng (cột 26px
  của bản mẫu — ghi đè ở `portal.css`, `prototype.css` giữ nguyên văn); trang Domain dùng nhầm class `.sect` nên
  tên domain và form nằm ngang, lệch phải; một test của trang Domain chập chờn vì đọc kết quả kiểm trước debounce.

Commit chỉ ở máy; người dùng tự đẩy lên GitHub. Không đọc hay commit `.env*`.
