# Plan #33 — Service Mesh (4), Ingress (2), Progressive Delivery (3) — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §5.5 Service Mesh / Ingress / Progressive Delivery, §5.3
(`anyOf`, `exclusive`, `conflicts` tool-level, `CapabilityPreference`), §5.3 ví dụ khai báo Flagger
và Argo Rollouts, §12.2; tiền đề: Plan #32 (`companions`, `secretKeys` của lớp nền Helm).

## 1. Mục tiêu

1. **Service Mesh:** Istio (base + istiod + gateway), Linkerd (crds + control plane), Consul
   Connect, Kuma — mỗi tool `provides: mesh.traffic-split`.
2. **Ingress:** NGINX Ingress, Traefik — `provides: ingress.traffic-split`.
3. **Progressive Delivery:** Flagger, Argo Rollouts, Spinnaker — `provides: traffic.control`
   (EXCLUSIVE), `requires` đúng như ví dụ §5.3.
4. Mỗi adapter qua đủ 42 phép, 0 nới lỏng; validator bắt đúng những tổ hợp mà tool thật
   không chạy được, ở lúc cấu hình chứ không lúc deploy.

## 2. Quyết định

- **QĐ-1 — Binding traffic mang `attributes.provider`:** `mesh.traffic-split` và
  `ingress.traffic-split` nói bộ định tuyến nào (`istio`, `linkerd`, `consul`, `kuma`, `nginx`,
  `traefik`). Flagger đọc nó để đặt `meshProvider`, Argo Rollouts để chọn traffic router —
  không đoán từ tên tool.
- **QĐ-2 — Tổ hợp không chạy được là `conflicts` tool-level** (ngoại lệ §5.3 dành đúng cho việc
  này): Flagger không có router cho Consul Connect ⇒ `conflicts: ["service_mesh:consul-connect"]`.
  Argo Rollouts đi Consul và Kuma qua plugin Gateway API chính thức (argoproj-labs) nên không
  xung đột. Validator báo `CONFLICT` lúc lưu cấu hình, không phải deploy FAILED sau 20 phút.
- **QĐ-3 — Có cả mesh lẫn ingress thì MESH điều khiển canary** (sửa §5.5, D-P24): §5.5 hứa
  validator trả `AMBIGUOUS_PROVIDER` và người dùng chọn, nhưng (a) `anyOf` của §5.3 — và oracle
  E8 viết trước từ đó — định nghĩa "một nhánh thoả là đủ", (b) `CapabilityPreference` chọn
  PROVIDER cho MỘT capability, không chọn giữa hai capability khác nhau, nên lời hứa đó không có
  chỗ lưu. Luật tất định thay thế: mesh mịn tới từng phần trăm ở L7 giữa các pod, ingress chỉ
  chia ở mép cluster — canary luôn tốt hơn trên mesh. Người muốn canary ở mép chỉ cần không bật
  mesh cho project đó.
- **QĐ-4 — Chứng chỉ mTLS của Linkerd là cấu hình của người dùng:** chart đòi trust anchor và
  issuer; sinh ngẫu nhiên trong adapter làm mỗi lượt áp một chứng chỉ khác ⇒ drift giả vĩnh viễn và
  mất mTLS giữa hai lượt. Trust anchor và issuer certificate là PEM công khai, issuer key là bí
  mật của tool (Plan #31).
- **QĐ-5 — Gateway/ingress tạo LoadBalancer ⇒ tiêu thụ `maxLoadBalancers`**: Istio (gateway),
  NGINX, Traefik từ chối khi quota bằng 0; Linkerd, Consul, Kuma (không gateway mặc định) không.
- **QĐ-6 — Spinnaker:** `provides: traffic.control` (exclusive, cùng domain với Flagger/Argo),
  `requires: metrics.query >=1` (Kayenta hỗ trợ Prometheus lẫn Datadog/New Relic), KHÔNG đòi
  mesh/ingress (triển khai red/black qua Service của chính nó); lưu trữ Redis + MinIO ⇒ tiêu thụ
  `maxStorageGb`.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Chín adapter qua đủ 42 phép, 0 nới lỏng                                                                              |
| AC-2 | Flagger + Consul Connect ⇒ `CONFLICT`; Flagger + Datadog ⇒ `VERSION_MISMATCH`; Flagger + Istio + Prometheus ⇒ hợp lệ |
| AC-3 | Flagger/Argo không có mesh lẫn ingress ⇒ `MISSING_ANY_OF` kèm gợi ý; có cả hai ⇒ hợp lệ và router là của mesh        |
| AC-4 | Flagger/Argo cấu hình router theo `attributes.provider` của binding; router đổi ⇒ `onDependencyChanged` áp lại       |
| AC-5 | Linkerd: issuer key chỉ trong `Secret`; thiếu chứng chỉ ⇒ `configSchema` từ chối                                     |
| AC-6 | Không thoái cấp                                                                                                      |

## 4. Nợ kiểm chứng

Mesh, ingress và controller thật trên cluster: gộp vào `helm-real` / `I32-cluster` (không mục
mới — không có API ngoài cluster nào để đo riêng).
