# Plan #38 — Database Operators (6 tool) và Cost Management (2 tool) — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §5.5 "Database Operators", "Cost Management" (mục đích:
chi phí ước tính theo project trên Portal), §5.2 (`scope` — "operator cluster-scoped, chỉ CR theo
namespace của environment"), §4.4 (quota `maxDatabases`, `maxStorageGb`), §2.2 (`CapabilityBinding`
có `environmentId`). Tiền đề: Plan #37 (cert-manager dùng chung).

## 1. Mục tiêu

1. **Tám adapter** qua đủ 42 phép: CloudNativePG, MongoDB Operator, MySQL Operator, Redis Operator,
   K8ssandra (Cassandra), MinIO Operator; OpenCost, Kubecost.
2. **Database theo từng environment** — operator cài MỘT lần vào `udp-system`, mỗi environment
   nhận một instance riêng trong namespace của nó (dữ liệu `dev` không bao giờ là dữ liệu `prod`).
3. **Chi phí trên Portal** — `GET /projects/:id/cost` đọc `cost.query` qua proxy của API server,
   chia theo environment (namespace).

## 2. Quyết định

- **QĐ-1 — `DomainAdapterContext.environments`** (sửa §5.2, **D-P29**): danh sách environment của
  project (id, tên, namespace, production) cho adapter cluster-scoped cần dựng thứ THEO environment
  (CR của operator). Không có nó, adapter cluster-scoped không biết namespace nào tồn tại; biến
  database thành namespace-scoped thì operator bị cài ba lần.
- **QĐ-2 — Instance theo environment ở lớp nền Helm**: `perEnvironment` (release mẫu) được dựng
  cho MỖI environment — release `<tên>-<env>`, bản ghi ở `udp-system` với `targetNamespace` là
  namespace của environment (§12.2: `udp-tooling` không ghi gì ở namespace env ngoài
  `udp-registry-pull`). Áp sau operator, gỡ trước operator; drift trên mọi instance.
- **QĐ-3 — `db.instance@1` theo environment**: mỗi binding mang `environmentId`, endpoint là DNS
  của service trong namespace env, `attributes` = `engine`, `port`, TÊN `Secret` thông tin đăng nhập
  mà operator sinh (không bao giờ giá trị). `resolvedFor` đã chọn binding đúng environment.
- **QĐ-4 — Quota**: một instance mỗi environment ⇒ `maxDatabases ≥ số environment` và
  `storageGb × số environment ≤ maxStorageGb`, kiểm TRƯỚC khi ghi gì (§4.4 lớp 1).
- **QĐ-5 — Production có HA**: environment production nhận số bản sao cấu hình (mặc định 3),
  environment khác một bản — cấu hình một trường, không bảng theo từng env.
- **QĐ-6 — MinIO là kho đối tượng, không phải database**: capability mới `object.store@1`
  (S3-compatible; endpoint + TÊN Secret khoá) — 18 capability.
- **QĐ-7 — Cost đọc `metrics.query` PromQL** (§5.5 v4: Light, "đọc từ metrics.query"): OpenCost và
  Kubecost `requires: metrics.query ^2` (Datadog/New Relic/Dynatrace không nói PromQL ⇒ validator
  chặn lúc lưu), Kubecost tắt Prometheus đi kèm. `cost.query@1` exclusive — một cluster một bộ tính.
- **QĐ-8 — Route chi phí**: S1 hỏi API `/allocation` của bộ tính qua `ClusterAccess.proxyService`
  (không mở ra Internet), cửa sổ 1–30 ngày, gom theo namespace ⇒ theo environment; chưa bật Cost
  ⇒ 409 kèm slug; cluster không trả lời ⇒ 503. Portal: thẻ chi phí ở trang Hạ tầng.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | 8 adapter qua đủ 42 phép; bộ hợp đồng chạy với HAI environment                                                                     |
| AC-2 | Database: operator một lần, instance mỗi env đúng namespace, binding mỗi env; gỡ instance trước operator; quota chặn trước khi ghi |
| AC-3 | `object.store`, `CAPABILITY_IDS` 18; Cost thiếu PromQL ⇒ `VERSION_MISMATCH` hay `MISSING_CAPABILITY` lúc lưu                       |
| AC-4 | `GET /cost`: đúng cửa sổ, đúng namespace ⇒ environment, 409/503 có nghĩa; Portal hiện số và nguồn                                  |
| AC-5 | Không thoái cấp: S1 đầy đủ, Portal, design-lint                                                                                    |

## 4. Nợ kiểm chứng

Operator và instance thật, số chi phí thật từ OpenCost/Kubecost trên cluster có tải: gộp
`I32-cluster`, `helm-real`; mục mới `db-cost-real`.
