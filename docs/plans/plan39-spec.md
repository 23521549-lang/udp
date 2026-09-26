# Plan #39 — Service 3 đọc metrics theo binding của environment — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §7.4 (MetricsProvider, nguồn theo `metrics.query`), §16
hàng "Prometheus TRONG cluster và Service 3 còn đọc metric qua `PROMETHEUS_URL` chung", ADR-06
(`ClusterAccess.proxyService` là đường DUY NHẤT tới service trong cluster), §9 Internal, §12 T12.
Tiền đề: Plan #31 (`metricsSourceFor`, nguồn SaaS ở S1), Plan #38 (`withCluster`).

## 1. Mục tiêu

1. Canary analysis của Service 3 đọc metrics từ ĐÚNG nguồn của environment của session —
   Prometheus/VictoriaMetrics trong cluster của khách, Grafana Cloud, Datadog, New Relic,
   Dynatrace — thay cho một `PROMETHEUS_URL` chung.
2. Prometheus trong cluster tới được qua `proxyService` (ADR-06) — ở cả probe của S1.

## 2. Quyết định

- **QĐ-1 — S1 THỰC THI truy vấn thay S3** (**D-P30**): route nội bộ
  `POST /internal/environments/:envId/metrics` nhận MỘT phép đo (`errorRate`, `latencyP99`,
  `requestCount`, `errorCount`, `custom`, `probe`) cùng mục tiêu và cửa sổ, trả `MetricSample`
  hay kết quả probe; `GET /internal/environments/:envId/metrics-source` trả `providerId`,
  `capabilityVersion`, `scrapeLagSeconds`. Khoá SaaS (mở bằng KEK chỉ S1 có) và credential cloud
  (dựng token cluster) không bao giờ rời S1; S3 không giữ khoá nào. ADR-06 viết "S3 truy vấn
  Prometheus nội bộ qua proxyService" — đổi thành "qua S1, S1 đi proxyService": cùng một đường
  tới cluster, bớt một nơi giữ bí mật. `POST /internal/clusters/:id/token` vẫn dành cho đường
  traffic của S3 (executor SERVICE_LEVEL, chưa có).
- **QĐ-2 — `RemoteMetricsProvider` ở S3**: hiện thực `MetricsProvider` bằng lời gọi S1, cùng
  chữ ký — reconciler không đổi. Một provider mỗi (environment, `metricQueries`), siêu dữ liệu
  (`scrapeLagSeconds`) đọc một lần và nhớ theo nhịp làm mới. S1 không trả lời ⇒ mẫu `hasData: false`
  ⇒ HOLD (I7 — cùng luật với Prometheus chết), không bao giờ là 0; `DEPENDENCY_DOWN` (§7.6) vẫn
  dành riêng cho S2 không nhận lệnh rollback.
- **QĐ-3 — Prometheus trong cluster qua `proxyService`**: nguồn `inCluster` mang
  namespace/service/cổng (suy từ endpoint của binding); provider Prometheus nhận `fetch` đi qua
  proxy của API server. Truy cập cluster của project được NHỚ trong S1 theo thời hạn token (không
  gọi API cloud mỗi phép đo); project chưa có cluster ⇒ lỗi rõ. `PROMETHEUS_URL` chỉ còn cho môi
  trường dev (Prometheus docker) khi project không có binding.
- **QĐ-4 — Xác thực nội bộ**: cùng bí mật dùng chung và header với route nội bộ của S2
  (`requireInternalCaller`, so hằng thời gian); route mount NGOÀI `/api/v1`, trước CSRF và rate
  limiter người dùng, không bao giờ qua ingress công khai (§9 danh sách Internal của S1 được cập
  nhật, design-lint canh).

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| AC-1 | Hai environment với hai nguồn khác nhau ⇒ S3 hỏi đúng nguồn của từng session (tích hợp S1 thật + S3)                           |
| AC-2 | Nguồn trong cluster: truy vấn đi `proxyService` đúng namespace/service/cổng; truy cập cluster được nhớ, không gọi lại mỗi phép |
| AC-3 | Không có bí mật tool hay token cluster trong response nội bộ, log của S3 hay bảng nào                                          |
| AC-4 | Thiếu/sai bí mật nội bộ ⇒ 401 đồng nhất; S1 chết ⇒ `hasData: false` ⇒ S3 HOLD (I7)                                             |
| AC-5 | Không thoái cấp: S1, S3, design-lint                                                                                           |

Cách kiểm AC-1 (ghi lúc làm): S1 THẬT trong tiến trình test — route, database, registry và phép
chọn nguồn thật, gọi qua HTTP (`internal-metrics.integration`: hai environment, hai endpoint) — và
S3 kiểm lời gọi của nó trên CÙNG wire schema (`metrics-providers.test`). Không dựng S1 thành tiến
trình con cho test S3: `index.ts` của S1 luôn chạy hàng đợi, và lịch đối soát của nó sẽ nhận các
hàng job còn sót trên database dev dùng chung.

## 4. Nợ kiểm chứng

Truy vấn thật qua API-server proxy tới Prometheus trong cluster của khách: gộp `I32-cluster`;
nguồn SaaS thật: `saas-metrics-real` (đã có).
