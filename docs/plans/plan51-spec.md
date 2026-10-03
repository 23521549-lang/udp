# Plan #51 — SPEC v1: SERVICE_LEVEL của Luồng 5 (Argo Rollouts, Flagger; udp-driven và tool-driven)

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 7 (việc #51); ADR-01, ADR-06, §7.2 (ma trận chiến lược ×
scope), §7.3 (ai điều khiển cái gì), §8.5, §9 Internal, §12.2 (ba ServiceAccount), §13.3 I4, I5, I24, I25,
§16 hàng "Lát cắt Luồng 5".

## 1. Phạm vi

| Thiết kế hứa                                                                            | Hôm nay                                     | Plan này                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /internal/clusters/:id/token` (ADR-06, §9) — S3 lấy bound token của `udp-traffic` | Chưa có (design-lint khai "chưa hiện thực") | Có; chỉ cấp `traffic`; `expiresAt` ≤ 1 giờ (I24c)                              |
| Client Kubernetes dùng chung `@udp/cluster-access` (§3 cây thư mục)                     | `DirectClusterAccess` nằm trong S1          | Gói riêng, S1 và S3 cùng dùng; thêm subresource `status`                       |
| S3 executor SERVICE_LEVEL: udp-driven (promote/abort từng bậc), tool-driven (soi gương) | S1 trả 422 cho mọi SERVICE_LEVEL            | Argo Rollouts và Flagger, đủ ô của ma trận §7.2 mà công cụ làm được            |
| Flagger udp-driven qua webhook gate (§7.3)                                              | Không có                                    | S3 mở `POST /webhooks/flagger/:sessionId/:gate`, trả lời từ trạng thái session |
| I4: udp-driven không sinh khối `analysis`                                               | Không có CR nào được sinh                   | Test trên bộ dựng CR                                                           |
| I5: tool-driven không bị S3 ghi đè                                                      | —                                           | 10 vòng reconciler trên CR tool-driven: 0 lời gọi ghi                          |
| Portal tạo rollout SERVICE_LEVEL (§10.9)                                                | Chỉ FLAG_LEVEL                              | Chọn workload, image mới, chế độ, chiến lược theo tool của env                 |

## 2. Quyết định

### QĐ-1: `@udp/cluster-access` — một client cho cả S1 và S3

`createDirectClusterAccess`, `objectPath`, `pluralOf`, `KubeTransport`, `TokenSource`, hai nguồn token và
`ClusterCallFailedError` chuyển nguyên từ `services/core-backend/src/modules/cluster/` sang `packages/cluster-access`
(test chuyển theo). `ObjectRef` (adapter-core) thêm trường tuỳ chọn `subresource: "status"` — `objectPath` nối
`/status`. Không đổi hành vi nào của S1.

### QĐ-2: Route token — chỉ `traffic`, id là project

`POST /internal/clusters/:id/token`, body `{ serviceAccount }`, trả `{ apiEndpoint, caData, token, expiresAt }`.
UDP không có bảng cluster: mỗi project BYOC có đúng một cluster, định danh bằng id project (cùng khoá mà
`ClusterAccessCache` của S1 đang dùng). Xác thực nội bộ vẫn là bí mật dùng chung (§16 đã ghi giới hạn đó so
với TokenReview) — nên S1 KHÔNG phân biệt được S2 với S3, và vì thế route chỉ cấp `traffic`: `workload` và
`tooling` bị từ chối 403 với MỌI bên gọi (không bên nội bộ nào cần chúng qua đường này; S1 tự dùng
`ClusterAccess` của mình). `expiresAt` kẹp ≤ now + 1 giờ (I24c). Token không ghi log, không ghi database.

### QĐ-3: S3 nói với cluster bằng `@udp/cluster-access` + token của S1

`RemoteTokenSource` gọi route trên; truy cập nhớ theo project tới trước hạn token; transport ghim CA của cluster
(`caData`) — S3 không bao giờ giữ credential cloud (ADR-06).

### QĐ-4: Ai ghi gì — §12.2 sửa cho khớp công cụ thật (D-P39)

| Bên                 | Ghi                                                                                                                                       | Đọc                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| S1 (`udp-workload`) | `Rollout.spec` (strategy + template), `Canary.spec` (Flagger), `AnalysisTemplate`, `Deployment.spec.template`, Service preview            | workload, CR        |
| S3 (`udp-traffic`)  | `rollouts/status` (promote, promote-full, abort, retry — đúng các patch `kubectl argo rollouts` gửi); route header trong `VirtualService` | `Rollout`, `Canary` |

RBAC cũ cấp `rollouts/promote|abort|retry` — CRD của Argo Rollouts KHÔNG có các subresource đó; trên cụm thật S3
sẽ không promote được. Sửa thành `rollouts/status: patch`. S3 vẫn không có `patch` trên `rollouts` (spec) hay
`deployments`: API server chặn S3 sửa `spec.template` (I25). Thêm `canaries` (flagger.app) và
`analysistemplates` (argoproj.io) cho `udp-workload`, `canaries` đọc cho `udp-traffic`.

### QĐ-5: Ma trận làm được

| Tool          | CANARY udp                                       | CANARY tool | BLUE_GREEN udp  | BLUE_GREEN tool | ATTRIBUTE_SPLIT udp          | ATTRIBUTE_SPLIT tool |
| ------------- | ------------------------------------------------ | ----------- | --------------- | --------------- | ---------------------------- | -------------------- |
| Argo Rollouts | ✔                                                | ✔           | ✔               | ✔               | ✔ khi router là Istio (§7.2) | 422 — dùng Flagger   |
| Flagger       | ✔ (gate)                                         | ✔           | 422 — dùng Argo | 422 — dùng Argo | ✔ (A/B + gate promotion)     | ✔ (A/B)              |
| Spinnaker     | 422 — chưa có executor (§7.2 chỉ vẽ hai công cụ) |

Tool lấy từ binding `traffic.control` của environment (bản env thắng bản cluster, cùng luật với
`metricsSourceFor`). ATTRIBUTE_SPLIT không tự quyết (§7.2) ở mọi scope: số đo ghi cho người đọc, promote/rollback
bằng tay.

### QĐ-6: Hình CR

- **Argo, udp-driven, CANARY**: bậc `setWeight: k` + `pause: {}` theo `stepPercent` tới 100, KHÔNG `analysis` (I4).
- **Argo, tool-driven, CANARY**: bậc `setWeight: k` + `pause: {duration: stepIntervalSeconds}`, `analysis` nền trỏ
  `AnalysisTemplate` `udp-<workload>` (Prometheus, tỉ lệ lỗi theo `service_version`, cùng ngưỡng của session). Nguồn
  metrics không phải PromQL ⇒ 422.
- **Argo, BLUE_GREEN**: `activeService` = workload, `previewService` = `<workload>-preview` (S1 tạo);
  udp-driven `autoPromotionEnabled: false` (S3 chỉ chuyển khi người dùng PROMOTE — §7.2 "không tự động");
  tool-driven `autoPromotionSeconds: stepIntervalSeconds`.
- **Argo, udp-driven, ATTRIBUTE_SPLIT**: `setCanaryScale: {replicas: 1}` + `pause: {}`; S3 chèn route
  `udp-attribute-split` (khớp header) trước route chính của `VirtualService` — Argo chỉ sửa trọng số của route
  có tên trong `trafficRouting.istio.virtualService.routes`, nên hai bên không ghi cùng một route.
- **Flagger**: `Canary` trỏ `Deployment`; udp-driven gắn webhook `confirm-traffic-increase`, `confirm-promotion`,
  `rollback` tới S3 và KHÔNG metrics (S3 là bên phân tích); tool-driven dùng metrics dựng sẵn
  `request-success-rate` / `request-duration` theo ngưỡng của session, cộng webhook `rollback` (đường duy nhất để
  ROLLBACK bằng tay tới được Flagger). ATTRIBUTE_SPLIT = A/B (`analysis.match` header, `iterations`).
- Mọi CR mang `udp.io/session-id`, `udp.io/control-mode`.

### QĐ-7: Tạo rollout SERVICE_LEVEL ở S1

Kiểm: env có binding `traffic.control`, ô ma trận được hỗ trợ, workload tồn tại (Rollout với Argo, Deployment với
Flagger), có container cùng tên, `versionNew` khác phiên bản đang chạy, ATTRIBUTE_SPLIT có `trafficMatch`, không
session nào đang chạy trên workload (409), probe pha 1. Rồi: áp CR (Argo: MỘT merge patch strategy + template có
`resourceVersion`; Flagger: server-side apply `Canary` — `Canary` chưa khởi tạo xong ⇒ 409 `DELIVERY_NOT_READY`, thử
lại sau; rồi patch image `Deployment`), ghi session (`versionOld`, `versionNew`, `controlMode`, `trafficMatch`), ghi
`DeploymentEvent` DEPLOY_START trỏ session. Áp CR hỏng sau khi INSERT ⇒ bù trừ như FLAG_LEVEL (xoá hàng vừa tạo).
Cột mới `rollout_sessions.traffic_match JSONB` `{ header, value }` (migration).

### QĐ-8: S3 — một nhánh SERVICE_LEVEL dùng chung khung vòng

Lease, fence, intent, hết hạn, nhịp phân tích giữ nguyên; `run` rẽ theo scope. Driver theo tool đọc trạng thái CR
thành một hình chung `{ weight, phase: progressing|paused|done|failed, stepIndex, pausedAtStep, resourceVersion }`.

- **Soi gương (cả hai chế độ)**: `currentTrafficPercentage` ← trọng số canary của CR (đổi ⇒ `lastStepAt`); CR xong
  ⇒ DONE; CR tự huỷ/hỏng ⇒ FAILED `AUTO_ROLLBACK` với lý do "công cụ tự rollback".
- **udp-driven Argo**: phân tích version mới vs cũ (`service_version`); PROMOTE + đủ dwell ⇒ patch
  `status.pauseConditions: null` kèm `metadata.resourceVersion`, CHỈ khi `currentStepIndex` bằng bậc session đang
  chờ; ROLLBACK ⇒ bỏ pause TRƯỚC rồi `status.abort: true` (argo-rollouts #3756, §7.3).
- **udp-driven Flagger**: không ghi gì — webhook của S3 trả 200/403 từ `last_decision` và intent (QĐ-9).
- **tool-driven**: không ghi gì ngoài ý định người dùng (Argo: PROMOTE ⇒ `promoteFull`, ROLLBACK ⇒ `abort`;
  Flagger: ROLLBACK qua webhook) — I5.
- PAUSE/RESUME ở SERVICE_LEVEL: udp-driven chỉ dừng S3 promote (trạng thái session); tool-driven ⇒ từ chối kèm lý
  do (dừng công cụ cần sửa `spec`, S3 không có quyền).

### QĐ-9: Webhook gate của Flagger

`POST /webhooks/flagger/:sessionId/:gate` trên S3, `gate ∈ {confirm-traffic-increase, confirm-promotion, rollback}`;
`metadata.token` = HMAC-SHA256(bí mật nội bộ, `flagger-gate:<sessionId>`) — S1 ghi vào CR, S3 kiểm. Trả lời chỉ
ĐỌC database (không giữ lease): mở tăng traffic ⇔ session đang chạy, quyết định gần nhất PROMOTE, đủ dwell; mở
promotion ⇔ như trên (CANARY) hoặc có ý định PROMOTE (ATTRIBUTE_SPLIT); mở rollback ⇔ quyết định ROLLBACK, ý định
ROLLBACK, hay session FAILED. Session đã DONE ⇒ gate xác nhận mở (UDP không còn điều khiển workload), rollback
đóng. URL gốc của S3 nhìn từ cluster tenant: biến `PD_CONTROLLER_WEBHOOK_URL` của S1; thiếu ⇒ Flagger udp-driven 422.

### QĐ-10: Deploy thường (Luồng 3) không cướp canary

`watchDeploy` từ chối (FAILURE kèm lý do) khi workload đang có session SERVICE_LEVEL chạy. Rollout mang
`udp.io/control-mode: udp-driven` của session đã kết thúc ⇒ patch image kèm khôi phục strategy trước session
(S1 lưu nó ở annotation `udp.io/previous-strategy` lúc tạo) — không thì deploy kế dừng vĩnh viễn ở `pause: {}`.

### QĐ-11: Portal

Tấm tạo rollout có bước SCOPE (§10.13): SERVICE_LEVEL chọn workload, image tag mới, chế độ, chiến lược — chỉ những ô
ma trận mà tool của env làm được; ATTRIBUTE_SPLIT hỏi header + giá trị. Chi tiết rollout hiện tool, chế độ, hai
phiên bản.

## 3. Tiêu chí chấp nhận

- **AC-1** `@udp/cluster-access` thay mã trong S1, test S1 xanh không đổi hành vi; subresource `status` có test.
- **AC-2** Route token: 403 cho `workload`/`tooling`; `expiresAt` ≤ 1 giờ kể cả khi cluster cấp dài hơn (I24c);
  design-lint `internal-routes` gỡ miễn trừ.
- **AC-3** RBAC: `udp-traffic` có `rollouts/status` patch, KHÔNG `rollouts` patch/update và không subresource bịa.
- **AC-4** Bộ dựng CR: I4 (udp-driven không `analysis`), bậc đúng `stepPercent`, BLUE_GREEN hai service, Flagger
  gate có token.
- **AC-5** S1 tạo SERVICE_LEVEL: đủ ô ma trận, 422 đúng lý do cho ô không làm được, 409 khi đang có session, bù trừ.
- **AC-6** S3: soi gương, promote có điều kiện `currentStepIndex`, abort sau unpause, I5 (10 vòng, 0 ghi),
  webhook gate đúng bảng QĐ-9.
- **AC-7** Luồng 3 từ chối khi có session chạy; khôi phục strategy sau session.
- **AC-8** Portal tạo/đọc rollout SERVICE_LEVEL, test msw theo fixture golden.
- **AC-9** Thiết kế: D-P39 (RBAC, id cluster, chỉ `traffic`), §16 hàng "Lát cắt Luồng 5" đóng, §9 webhook S3.
  Chạy với Argo/Flagger thật: sổ nợ (cụm có Istio + Argo/Flagger).
