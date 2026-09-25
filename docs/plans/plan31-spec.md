# Plan #31 — Bí mật của tool, MetricsProvider theo nhà cung cấp, Monitoring (4) + Tracing (3) — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §5.2 (`configSchema`, `.describe("secret")`), §2.2
(`tool_config` — "trường đánh dấu secret được mã hóa như §4.3 TRƯỚC khi lưu"), §4.3 (envelope
AES-256-GCM), §5.4 (mỗi adapter `metrics.query` PHẢI kèm một `MetricsProvider`), §5.5
(Monitoring, Tracing); yêu cầu chủ dự án: đủ mọi tool của §5.5.

## 1. Mục tiêu

1. **Bí mật trong `tool_config`** — hiện CHƯA có dù §2.2 hứa. Trường `.describe("secret")`
   của `configSchema`: mã hoá envelope khi lưu (bảng và payload job), KHÔNG BAO GIỜ lên dây
   (Portal thấy "đã lưu"), gửi lại giá trị giữ chỗ ⇒ giữ bí mật cũ, giải mã CHỈ trong bộ
   nhớ worker ngay trước lời gọi adapter. Tiền đề của mọi tool SaaS còn lại.
2. **Bộ hợp đồng dùng chung cho test adapter:** mỗi `contract.test.ts` chỉ còn fixture;
   môi trường (cluster giả, egress giả theo `externalHosts`, context) dựng một chỗ. Hai
   adapter hiện có chuyển sang — 64 adapter sau không nhân bản 100 dòng khuôn.
3. **MetricsProvider theo nhà cung cấp (§5.4):** Datadog (metrics query API), New Relic
   (NRQL qua NerdGraph), Dynatrace (Metrics API v2); họ PromQL (Prometheus,
   VictoriaMetrics, Grafana Cloud/Mimir) dùng chung `PrometheusMetricsProvider`. Một
   registry `providedBy → MetricsProvider`. Service 1 `probe()` chọn nguồn theo binding
   `metrics.query` của environment thay vì `PROMETHEUS_URL` cố định.
4. **Monitoring còn 4 tool:** New Relic, Dynatrace, Grafana Cloud, VictoriaMetrics.
5. **Tracing đủ 3 tool:** Jaeger, Tempo, Zipkin (capability `traces.sink`).
6. **Portal:** ô bí mật (không hiện giá trị, nút "đổi"), tool mới hiện đúng trong catalog.

**Không thuộc plan này:** Service 3 chọn nguồn metrics theo binding (cần giải mã bí mật
ngoài Service 1 — quyết định kiến trúc riêng, lịch ở Plan #39 cùng `proxyService` của
ADR-06 cho Prometheus trong cluster).

## 2. Quyết định

- **QĐ-1 — Hình của bí mật đã mã hoá:** giá trị trường được thay bằng
  `{ "$udpSecret": 1, ...EncryptedCredential }` (dùng lại `encryptCredential`), AAD =
  `domain:<DOMAIN_TYPE>:<field> | projectId | dekVersion` — dán ciphertext sang trường hay
  project khác là thất bại xác thực. Trên dây: `{ "$udpSecret": "kept" }`; body mang đúng
  giá trị đó ⇒ giữ bản đã lưu, mang chuỗi ⇒ bản mới.
- **QĐ-2 — So cấu hình khi áp:** kế hoạch (`planDomainApply`) so trên cấu hình ĐÃ GIẢI
  MÃ trong bộ nhớ worker; ciphertext mới mỗi lần lưu không được thành "đổi cấu hình" giả.
- **QĐ-3 — Adapter SaaS có agent trong cluster** (New Relic, Dynatrace, Grafana Cloud):
  họ Helm (chart agent của nhà cung cấp) + `externalHosts` của API nhà cung cấp; khoá đi
  vào `values` qua Secret Kubernetes do adapter tạo, không vào ConfigMap.
- **QĐ-4 — Version capability theo ngôn ngữ truy vấn (§5.3):** PromQL = `metrics.query@2`
  (VictoriaMetrics 2.1.0, Grafana Cloud 2.0.0); New Relic, Dynatrace = `@1` (như Datadog).

- **QĐ-5 — Bí mật TRÊN cluster:** `HelmBasedAdapter` nhận thêm `secretValues(config)`; lớp nền
  ghi chúng vào một `Secret` trong namespace của release (`udp-system` với adapter cluster)
  và HelmRelease đọc qua `valuesFrom`, KHÔNG BAO GIỜ vào ConfigMap giá trị. ConfigMap mang
  băm SHA-256 của phần bí mật (đổi khoá ⇒ release thấy đổi); drift đọc lại Secret và so với
  thân mong muốn — xoá hay sửa tay Secret cũng là trôi — nhưng chi tiết drift chỉ nêu TÊN
  khoá, không bao giờ giá trị (v1.1, P1b: mạnh hơn bản "không đọc ngược Secret", vì bản đó
  bỏ sót đúng ca agent mất khoá mà ConfigMap vẫn nguyên). §12.2 cho phép
  `secrets` TRONG namespace của chính SA ("không `secrets` ngoài namespace của mình"), nhưng
  `bootstrap.ts` đang cấm tuyệt đối — sửa: Role `udp-tooling` trong `udp-system` có
  `secrets`; bộ kiểm RBAC vẫn đỏ với `secrets` trong ClusterRole hay namespace khác.
- **QĐ-6 — Lớp nền SaaS xác thực bằng bí mật:** `authHeaders(config)` gắn khoá vào lời gọi
  qua `ctx.fetch` (egress guard vẫn chặn host lạ). Datadog bỏ `credentialRef` (trỏ tới một
  kho không tồn tại) sang `apiKey`/`appKey` bí mật.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Bí mật không xuất hiện ở: response dây, `domain_configs.tool_config`, `provisioning_jobs.payload`, audit, log (quét chuỗi canh như I12)                   |
| AC-2 | Gửi lại `{ "$udpSecret": "kept" }` giữ đúng bí mật cũ; đổi ⇒ adapter nhận giá trị mới                                                                     |
| AC-3 | Mỗi tool mới qua đủ bộ hợp đồng 42 phép, 0 nới lỏng (`E1-relaxations.json`)                                                                               |
| AC-4 | Ba MetricsProvider SaaS: truy vấn đúng API, `hasData=false` khi rỗng (không coi là 0, I7), lỗi mạng ⇒ `queryFailed`                                       |
| AC-5 | `probe()` của Service 1 dùng provider theo binding `metrics.query` của environment                                                                        |
| AC-6 | Validator: Flagger (`^2`) + New Relic ⇒ VERSION_MISMATCH; + VictoriaMetrics ⇒ hợp lệ                                                                      |
| AC-8 | Khoá của agent nằm trong `Secret` của `udp-system`, không trong ConfigMap; bộ kiểm RBAC: `secrets` trong Role `udp-system` hợp lệ, trong ClusterRole ⇒ đỏ |
| AC-7 | Không thoái cấp                                                                                                                                           |

## 4. Nợ kiểm chứng

Chạy thật chart/API của từng nhà cung cấp cần tài khoản và cluster: gộp vào `helm-real` /
`I32-cluster` (chart) và một mục mới `saas-metrics-real` (API truy vấn thật của Datadog,
New Relic, Dynatrace).
