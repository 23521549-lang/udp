# Bàn giao cuối — UDP, 30/09/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-09-29.md` ở vai "điểm bắt
đầu cho người tiếp theo"; tệp đó giữ nguyên các mục không đổi (cưỡng chế, CI, chạy cổng trên máy ít RAM). Nguồn
sự thật của thiết kế là `docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong
`kiem-chung-con-no.md`); của từng plan là `docs/plans/planNN-spec.md` + `planNN-plan.md`.

**Trạng thái một câu:** mọi thứ thiết kế hứa mà làm được bằng mã đã có mã và test; phần còn lại là 44 mục nợ
kiểm chứng, mỗi mục cần hạ tầng (cluster thật, cloud, SaaS, runner, máy Oracle) hay người thật. Hạ tầng của dự
án tốn đúng 0 đồng và không chạy trên máy người dùng (D-P37, D-P41).

## 1. Plan #53 — Portal hai khung, màn tổng hợp, bản xem thử đầy đủ

Spec: `docs/plans/plan53-spec.md` (QĐ-1…QĐ-12); kế hoạch: `plan53-plan.md`.

| Đợt | Commit       | Nội dung                                                                                                                                                                                                                                                                  |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 53a | `c519f0c`    | Chuẩn thiết kế sửa ở nguồn (DESIGN.md, bản mẫu, `prototype.css` chép lại): trạng thái ba sắc, màu dữ liệu tách khỏi trạng thái, token `--console-*`, đầu trang gọn. Hai khung (`Shell`), component dùng chung (PageHead, StatusLabel, Meter, LineChart, BarChart, Pager…) |
| 53b | `6a8b3ac`    | API: `/architecture` (cạnh từ `capabilityEdges` trên `chosen` của resolver), `/metrics/red` (`MetricsSeriesProvider`), `/home`, `/admin/overview`, `/admin/platform`; `offset` + `total` cho danh sách quản trị và nhật ký; `cost.daily`                                  |
| 53c | `be1bce8`    | RBAC chỉ-đọc cho `/admin/platform` (ServiceAccount `core-backend`), `UDP_RELEASE` theo commit                                                                                                                                                                             |
| 53d | `df0b1af`    | Màn: Trang chủ, Tổng quan mới (thẻ Cloud, lưới sức khoẻ, sơ đồ thu nhỏ), Kiến trúc, Giám sát, Tổng quan của Bảng điều khiển; trang và bộ lọc trên URL                                                                                                                     |
| 53e | `1dbac9c`    | Bản xem thử: 130 người dùng, 24 project trên ba cloud; route giả cho mọi API mới; cổng CI `portal-demo` (Playwright)                                                                                                                                                      |
| 53f | (commit này) | Thiết kế §9, §10.6, §10.11, §10.13, §10.14, D-P42…D-P45, §16; DESIGN.md; sổ nợ; bàn giao                                                                                                                                                                                  |

Quyết định mới trong bảng D-P của §10.15: **D-P42** hai khung + Bảng điều khiển nền tảng, **D-P43** sơ đồ kiến
trúc từ CHÍNH resolver, **D-P44** chuỗi RED qua `MetricsSeriesProvider`, **D-P45** bản xem thử + cổng
`portal-demo`.

## 2. Cưỡng chế thêm

| Chốt                                                                                           | Ở đâu                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Cạnh của sơ đồ bằng đúng quan hệ `chosen` (kể cả `anyOf`, preference); provider trước consumer | `services/core-backend/tests/capability-resolver.test.ts`    |
| Route mới: 401/403/404, VIEWER, lọc theo membership, `unavailable` kèm lý do                   | `services/core-backend/tests/dashboards.integration.test.ts` |
| RBAC của `/admin/platform` chỉ đọc (không `secrets`, không verb ghi)                           | `deploy/tests/manifests.test.ts`                             |
| Mỗi màn mới của Portal (msw + mẫu golden), mô hình thuần của tín hiệu nền tảng                 | `apps/portal/tests/dashboards.test.tsx`                      |
| Không em-dash trong chữ giao diện VÀ trong dữ liệu mẫu; `<svg>` chỉ ở tệp đã khai              | `apps/portal/tests/design-lint.test.ts`                      |
| Mọi API của Portal qua lớp giả lập, số liệu khớp nhau (tổng quan = danh sách)                  | `apps/portal/demo/contract.check.ts`                         |
| 34 màn × 2 khung: không lỗi console, không tràn ngang, một `main`, một `h1`…                   | `apps/portal/demo/screens.pw.ts` (job CI `portal-demo`)      |
| Nối dây job `portal-demo` (build → Chromium → chụp; artifact kể cả khi đỏ; không secret)       | `deploy/tests/ci-workflow.test.ts`                           |

Cổng Playwright bắt được ngay hai lỗi mà jsdom không thể thấy, đã sửa: lớp cạnh của sơ đồ không vẽ (đo trong
layout effect của con, trước khi ref của khung cha được gắn — nay nhận khung qua callback ref) và trang đăng
nhập/đăng ký thiếu vùng `main`.

## 3. CI

`.github/workflows/ci.yml` có bảy job: `check`, `python`, `test`, `i28`, `kind`, `vm`, và [#53] `portal-demo`
(build bản xem thử tĩnh, `playwright install --with-deps chromium`, chụp và kiểm mọi màn; ảnh chụp là artifact
`portal-demo-screens-<run_id>`, giữ 7 ngày). Job này không cần database hay secret. Chi phí 0: repo public.

Chạy ở máy dev (Edge sẵn có, không tải trình duyệt):

```
pnpm --filter @udp/portal demo:build
pnpm --filter @udp/portal demo:screens      # ảnh ở apps/portal/demo/screens/<desktop|mobile>/
```

## 4. Còn nợ — 44 mục

Đã trả: `portal-responsive` (cổng `portal-demo`). Thêm: `monitoring-real-cluster`, `monitoring-saas-real`.
Chi tiết từng mục: `docs/measurements/kiem-chung-con-no.md`.

| Cần có                            | Mục                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster Kubernetes mà S1 vào được | `I32-cluster`, `clusteraccess-direct`, `helm-real`, `I24-cluster`, `I25-cluster`, `I34-cluster`, `E16`, `quota-lb-webhook`, `agent-mode`, `cicd-webhook-real`, `db-cost-real`, `portal-rollout-create`, `service-level-cluster`, `monitoring-real-cluster` |
| Tài khoản cloud thật (tốn tiền)   | `E2`, `I31-aws`, `I31-gcp`, `I31-azure`, `E15`, `preflight-confidence`, `getkubeauth-that`, `k8s-managed-discovery`, `estimatecost-vs-bill`, `cred-federation`, `iac-security-real`                                                                        |
| Tài khoản SaaS dùng thử           | `saas-metrics-real`, `saas-logs-real`, `monitoring-saas-real` (chạy chung lượt với `saas-metrics-real`)                                                                                                                                                    |
| Runner CI                         | `E4-ci`, `E4-segment`, `stale-perf`, `segment-cap-perf`, `portal-pagination`, `E9`                                                                                                                                                                         |
| Máy rảnh / Prometheus / Docker    | `E3-quiet`, `E3-stats`, `E5`, `E6`, `E14-prometheus`, `I31-localstack`, `upgrade-rollback-that`                                                                                                                                                            |
| Người thật                        | `portal-e2e`, `portal-dx`                                                                                                                                                                                                                                  |
| Máy Oracle Free Tier (0 đồng)     | `vm-oracle-real`                                                                                                                                                                                                                                           |

## 5. Bản xem thử Portal — chạy ở máy, không publish

`apps/portal/demo/`: CHÍNH mã Portal chạy với backend giả lập trong trình duyệt (chặn `fetch` tới `/api/v1`),
dữ liệu tất định (mulberry32, hạt cố định) nên mở lại vẫn cùng id, cùng số. Người xem đăng nhập sẵn là quản trị
viên nên thấy cả hai khung.

- **Dữ liệu:** 130 người dùng (10 người của nhóm thương mại điện tử có tên riêng, 120 người của sáu công ty sinh
  từ họ, đệm, tên Việt); 24 project trên AWS, GCP, Azure ở mọi trạng thái (9 project người xem là thành viên,
  15 chỉ Bảng điều khiển thấy); bảy bộ công cụ phủ gần hết catalog §5.5; nhiều workload mỗi project; chuỗi RED
  theo nhịp ngày có một đợt sự cố lỗi và độ trễ, có điểm trống; job lỗi, dọn chưa hết, đang hủy; 6 tài nguyên
  mồ côi trên ba cloud; máy A1 2 OCPU / 12 GB cho Tổng quan nền tảng. Mọi số là minh hoạ.
- **Mở ở máy** (trong `apps/portal`): `pnpm demo:build`, rồi
  `node node_modules/vite/bin/vite.js preview --config demo/vite.config.ts --port 4173`, rồi mở
  `http://127.0.0.1:4173/#/app/home` (Portal) hay `http://127.0.0.1:4173/#/admin/overview` (Bảng điều khiển).
- Trang Artifact cũ đã xoá theo yêu cầu của người dùng; bản xem thử chỉ chạy ở máy.

Commit chỉ ở máy; người dùng tự đẩy lên GitHub. Không đọc hay commit `.env*`.
