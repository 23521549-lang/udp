# Plan #45 — SPEC v1: route còn thiếu của Domain và Deployment, Tổng quan đủ §10.6

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 4, 5, 6; §9 (Domain, Day-2, Deployments),
§8.2, §8.6, §10.6, §10.13 ("Drift badge", "Upgrade dialog").

## 1. Phạm vi

1. `POST /projects/:id/domains/:type/retry` — áp lại MỘT domain đang bật về đúng cấu hình đang lưu
   (domain ERROR/BLOCKED sau một lượt hỏng; domain đã trôi — "Áp lại cấu hình mong muốn").
2. `GET /projects/:id/domains/:type/versions` — bản đang chạy, bản máy chủ đang nạp, capability đổi gì,
   và KẾT QUẢ chạy lại validator với khai báo mới. `POST …/upgrade` nhận thêm `toVersion?`.
3. `GET /projects/:id/deployments/latest?envId=` và `GET /projects/:id/deployments/:deploymentId/logs`.
4. `GET /projects/:id` (và `POST /projects`) mang `cluster` — thẻ Cluster của Tổng quan (§10.6).
5. Portal: nút Thử lại / Áp lại ở chi tiết domain; hộp nâng cấp hiện phiên bản, thay đổi capability,
   kết quả validator; thẻ "Deploy gần nhất" và "Cluster" ở Tổng quan; nhật ký một lần deploy ở trang Deploy.

## 2. Quyết định

### QĐ-1: `retry` là job `DOMAIN_APPLY` loại `reapply`

Payload `change: { kind: "reapply", domainType }`. Không mang cấu hình: nguồn là CHÍNH hàng
`domain_configs` (thứ đang lưu và là mục tiêu của domain), khác `apply` mang trạng thái đích mới
(D-P21). Worker: đọc hàng, adapter theo registry, mở bí mật trong bộ nhớ → `DEPLOYING` →
`deploy` trên mọi environment (`callOnTargets`, cùng đường với CASE 1; adapter idempotent theo bộ
hợp đồng) → `healthcheck` → ghi binding (thay cả tập của domain) → báo consumer khi binding đổi
(`changedBindings`, như nâng cấp) → `ACTIVE`, xoá `last_error`. Hỏng ⇒ `ERROR` kèm bước.

Luật của route (MAINTAINER, cùng bậc với nâng cấp):

| Điều kiện                                                                     | Kết quả                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project không `ACTIVE`, domain tắt, không tool, tool không còn trong registry | 409 `domain-not-running`                                                                                                                         |
| Domain đang `DEPLOYING`/`PENDING`                                             | 409 `domain-not-retryable` (slug mới): đang có việc chạy trên nó, hoặc chưa từng triển khai                                                      |
| `adapter_version` khác bản registry đang nạp                                  | 409 `domain-not-retryable` — áp lại bằng bản mới hơn là nâng cấp lách validator (§8.6); dùng `upgrade`                                           |
| Có rollout sống ở project                                                     | 409 `ROLLOUT_IN_PROGRESS` — áp lại có thể khởi động lại nguồn metrics hay đường traffic giữa lúc canary so hai cửa sổ (cùng luật nâng cấp, §8.6) |
| Project có environment production mà `confirm` ≠ tên domain                   | 428 — chạm cluster dùng chung mọi env                                                                                                            |
| Job khác đang chạy ở project                                                  | 409 (unique index một job sống) — như `PUT /domains`                                                                                             |
| Còn lại                                                                       | 202 `{job}`                                                                                                                                      |

Không tự sửa drift (§8.6): nút này là người vận hành CHỌN ghi đè, có xác nhận — đúng chữ "Áp lại cấu
hình mong muốn kèm xác nhận" của §10.13.

### QĐ-2: `versions` tính từ registry và bảng, không gọi cluster

Registry nạp MỘT bản mỗi tool (nợ `upgrade-rollback-that`), nên "các bản nâng được" có tối đa một
phần tử: bản máy chủ đang nạp khi nó khác `adapter_version`. Mỗi phần tử mang:

- `provides`: capability và version bản mới cung cấp;
- `changes`: so với binding ĐANG lưu của domain (`capability_bindings`): capability thêm, bỏ, đổi version;
- `validation`: `POST /domains/validate` chạy trên trạng thái ĐANG lưu với adapter của registry — đúng
  phép `declarationsAfterUpgrade` mà worker chạy trước khi chạm cluster, nay Portal thấy TRƯỚC khi bấm.

Response `{ versions: { domainType, toolId, current, available: [...] } }`. `POST …/upgrade` nhận
`toVersion?`: có và khác bản đang nạp ⇒ 409 slug `domain-version-unavailable` (người dùng nâng lên một bản
mình đã thấy, không phải bản máy chủ vừa đổi sau khi họ mở hộp).

### QĐ-3: Deploy gần nhất và nhật ký dùng lại bộ gom có sẵn

`latest`: cùng bộ gom theo `deployment_id` của `GET /deployments`, lấy một; env không thuộc project ⇒
404; chưa có ⇒ `{ deployment: null }`. `logs`: mọi sự kiện của một `deployment_id` theo thời gian, mỗi sự
kiện mang cột của nó và `detail` = `metadata` đã qua `redact()` (lý do lỗi, image khôi phục, repo, ref).
`deployment_id` không thuộc project ⇒ 404.

### QĐ-4: `cluster` ở phong bì chi tiết project, không ở hàng danh sách

`projectDetailResponseWire` thêm `cluster: { clusterId, apiEndpoint, provider, region } | null` —
`clusterId`/`apiEndpoint` từ `projects.cluster_access` (KHÔNG `caData`, không token), `provider`/`region`
từ credential đang dùng. Danh sách project không mang nó: một trang 50 project không cần 50 endpoint.
VIEWER thấy được: đây là địa chỉ, không phải quyền vào (ADR-06 — không token nào lưu).

## 3. Tiêu chí chấp nhận

- **AC-1** `retry`: 202 kèm job `DOMAIN_APPLY`; worker áp lại, domain `ERROR` về `ACTIVE`, `last_error`
  xoá, binding ghi lại; adapter hỏng ⇒ `ERROR` và job `FAILED`; đủ các ca 409/428 của QĐ-1.
- **AC-2** `versions`: domain đã mới nhất ⇒ `available: []`; bản mới đổi `provides` ⇒ `changes` đúng và
  validator báo lỗi khi consumer không còn thoả; `upgrade` với `toVersion` lạ ⇒ 409.
- **AC-3** `latest` và `logs` đúng hình, đúng phạm vi project/env, `detail` đã che bí mật.
- **AC-4** `cluster` có trên chi tiết project khi project đã provision, `null` khi chưa; không `caData`.
- **AC-5** Portal: hai nút ở chi tiết domain theo trạng thái, xác nhận khi có production; hộp nâng cấp chặn
  bấm khi validator đỏ; Tổng quan hiện hai thẻ; trang Deploy mở nhật ký. Golden cho bốn route mới và hai
  route đổi hình; I38 xanh (khoá `deploymentLatest` mang `envId`).
- **AC-6** Không thoái cấp: typecheck, lint, prettier, test theo lô, design-lint.
