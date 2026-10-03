# Plan #40 — Vòng đời environment: tạo, sửa, xoá — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §9 "Environment" (`GET/POST/PATCH/DELETE
/projects/:id/environments`, "chặn nếu còn flag đang bật"), §4 (tạo environment gọi
`POST /internal/environments/:id/backfill` của Service 2), §2.2 (`DeploymentEvent`, `AuditLog` giữ
environment bằng `Restrict`), §8.1 bootstrap cluster, §5.2 `scope` và instance theo environment
(D-P29). Sổ nợ: `portal-env-crud`. Tiền đề: Plan #30 (`DOMAIN_APPLY`), Plan #38 (lớp nền Helm
`perEnvironment`).

## 1. Mục tiêu

1. Người dùng thêm environment thứ tư (vd. `qa`) cho project, ở MỌI trạng thái hợp lệ của project:
   nháp (chỉ database) hay đang chạy (database + cluster: namespace, RBAC, instance theo env).
2. Xoá environment tạo nhầm — mà không bao giờ xoá lịch sử (audit, DORA).
3. Flag, segment, SDK key, rollout và cache của Portal đúng với environment mới (I38).

## 2. Quyết định

- **QĐ-1 — Route (§9 S1)**: `GET` (VIEWER), `POST` (OWNER), `PATCH` (OWNER), `DELETE` (OWNER).
  `POST` trả `201 { environment, job }`, `DELETE` trả `200 { job }` — `job` là `null` khi project
  chưa có cluster. MỘT hình response mỗi route (bài học D-P21).
- **QĐ-2 — Tên**: nhãn DNS bắt đầu bằng chữ, tối đa 12 ký tự (`ENV_SLUG_MAX` — để tên KHÔNG bị
  cắt khi thành hậu tố namespace, tiền tố SDK key và tên instance Helm), duy nhất trong project.
  Tên là BẤT BIẾN: namespace, tiền tố khoá và tên release đều suy từ nó. Trần
  `MAX_ENVIRONMENTS = 8` mỗi project. `rank` = lớn nhất + 1.
- **QĐ-3 — `PATCH` chỉ `isProduction`, `autoDeploy`**. Bật `isProduction` mà không nói `autoDeploy`
  ⇒ `autoDeploy = false` (§8.3: production không tự deploy từ webhook).
- **QĐ-4 — Service 2 backfill** (§9 S2 Internal, thêm): `POST /internal/environments/:id/backfill`
  — một `FlagEnvConfig` TẮT cho mọi flag của project còn thiếu ở environment đó, qua ADR-05 (một
  version, `config_hash` tính trên snapshot, dòng change log `environment.backfilled`).
  Idempotent: gọi lại không tạo hàng thừa, không tăng version khi không thiếu gì. S1 gọi SAU khi
  commit hàng environment; S2 hỏng ⇒ S1 xoá hàng vừa tạo (chưa có lịch sử nào) và trả 503.
- **QĐ-5 — Xoá cứng, có điều kiện** (§2.2 giữ lịch sử bằng `Restrict`; SetNull là UPDATE trên
  bảng append-only). 409 kèm slug riêng cho từng lý do:
  `environment-last` (còn một environment), `environment-has-history` (đã có `audit_logs` hay
  `deployment_events` trỏ tới — gồm mọi environment từng có SDK key hay flag được bật tắt),
  `environment-flags-enabled` (§9: còn flag đang bật), `environment-rollout-active` (còn rollout
  sống). Environment đã có lịch sử thì giữ — lưu trữ (archive) là hướng tương lai (§17).
- **QĐ-6 — Project có cluster ⇒ job `ENVIRONMENT_APPLY`** (JobType thứ tư, **D-P31**): cùng
  hàng đợi, lease, fencing và outbox pg-boss với `DOMAIN_APPLY` (D-P19, D-P20); trạng thái
  `QUEUED → DOMAINS → DONE | FAILED`. Payload mang `action` và BẢN CHỤP environment (id, tên,
  namespace, production).
  - **ADD**: bootstrap cluster với MỌI environment (server-side apply, idempotent — namespace,
    SA, Role, NetworkPolicy, ResourceQuota của env mới), rồi theo bậc đồ thị: adapter
    `scope = namespace` deploy trên env mới; adapter cluster-scoped deploy lại với danh sách env
    mới (instance theo env của lớp nền Helm); binding ghi thêm; phân phối khoá kéo image.
  - **REMOVE**: hàng environment bị xoá TRONG CÙNG transaction tạo job (không khe nào cho lịch sử
    mới xuất hiện giữa lúc kiểm và lúc xoá); job gỡ adapter `scope = namespace` trên bản chụp, deploy
    lại adapter cluster-scoped với danh sách env còn lại, rồi xoá namespace bằng token quản trị.
  - Chạy khi không job nào khác đang chạy của project (`idx_one_active_job_per_project`) — có ⇒ 409
    `job-active`. Project đang dựng/xoá ⇒ 409 `project-busy`.
- **QĐ-7 — Lớp nền Helm tự dọn instance mồ côi**: mỗi release instance mang nhãn
  `udp.dev/instance-of=<releasePrefix>`; `deploy` liệt kê theo nhãn và gỡ instance của environment
  không còn trong danh sách. Deploy = hội tụ về ĐÚNG tập environment — không thêm hook vào interface
  adapter (đang khoá).
- **QĐ-8 — Thử lại**: `POST /projects/:id/jobs/:jobId/retry` (OWNER) CHỈ cho `ENVIRONMENT_APPLY`
  đã `FAILED` — job mới cùng payload (job idempotent). Loại job khác ⇒ 409 (PROVISION thử lại bằng
  `POST /provision`, DOMAIN_APPLY bằng `PUT /domains` — D-P19 giữ nguyên).
- **QĐ-9 — Portal**: tab "Environment" trong Cài đặt project: danh sách, tạo (tên, production), bật
  tắt `autoDeploy`/production, xoá (gõ lại tên để xác nhận); lỗi 409 hiện đúng lý do. Tạo/xoá xong
  ⇒ invalidate `project`, `environments`, ma trận flag; có job ⇒ liên kết tới trang job.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Project nháp: thêm `qa` ⇒ mọi flag có `FlagEnvConfig` tắt ở `qa`, snapshot `qa` có hash đúng (I15), SDK key tạo được, `job = null`                                            |
| AC-2 | S2 hỏng khi backfill ⇒ 503 và KHÔNG còn hàng environment nào; gọi backfill hai lần ⇒ không hàng thừa, version không tăng lần hai                                              |
| AC-3 | Tên sai dạng / trùng / quá 12 ký tự / quá trần 8 ⇒ 400/409 đúng lý do; tên không đổi được qua `PATCH`                                                                         |
| AC-4 | Bốn ô âm của xoá (AC 409 từng slug); environment sạch ⇒ xoá được, `FlagEnvConfig` và binding của nó đi theo                                                                   |
| AC-5 | Project đang chạy (thế giới mô phỏng): ADD dựng namespace + instance theo env + binding env mới; REMOVE gỡ đúng thứ của env đó, instance Helm mồ côi bị dọn, namespace bị xoá |
| AC-6 | `ENVIRONMENT_APPLY` FAILED ⇒ retry tạo job mới cùng payload; retry loại job khác ⇒ 409                                                                                        |
| AC-7 | Portal: tạo/sửa/xoá qua route thật (msw theo golden), query key đúng I38; lỗi 409 hiện lý do                                                                                  |
| AC-8 | Không thoái cấp: S1, S2, Portal, design-lint, golden                                                                                                                          |

## 4. Nợ kiểm chứng

Áp thật lên cluster (namespace, RBAC, instance Helm, xoá namespace): gộp `I32-cluster`.
