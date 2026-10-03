# Plan #32 — Logging đủ bảy tool, lớp nền Helm nhiều release, hợp đồng `logs.sink` — SPEC

Trạng thái: **v1.1, 26/09/2026 — XONG** (QĐ-4 thêm `readsSecretValues`; phép d14 dựng binding cùng hình). Nguồn: §5.5 Logging (sáu dòng; dòng "Fluentd / Fluentbit" là HAI
tool), §5.2 (`HelmBasedAdapter`), §5.3 (capability, binding `attributes`), §12.2 (`secrets` chỉ
trong `udp-system`), Plan #31 (bí mật của tool, `Secret` của release); yêu cầu chủ dự án: đủ
mọi tool của §5.5.

## 1. Mục tiêu

1. **Bảy adapter Logging:** Loki (+ Grafana), ELK (Elasticsearch + Kibana qua ECK), OpenSearch
   (+ Dashboards), Splunk (qua Splunk OTel Collector tới HEC), Datadog Logs (Datadog Agent thu
   log), Fluent Bit, Fluentd. Mỗi adapter qua đủ 42 phép của bộ hợp đồng, 0 nới lỏng.
2. **Lớp nền Helm nhiều release:** phần lớn backend log là 2–3 chart (máy chủ lưu trữ, giao
   diện, bộ thu log). Lớp nền nhận `companions` — release đi kèm theo thứ tự — và giữ vòng đời
   cho cả nhóm: áp theo thứ tự, gỡ ngược thứ tự, drift trên MỌI release. Tiền đề của Service
   Mesh (Linkerd hai chart), Istio (ba chart) ở Plan #33.
3. **Hợp đồng dây của `logs.sink@1`:** binding mang `attributes.protocol` (loki, elasticsearch,
   opensearch, splunk-hec, datadog, newrelic, dynatrace) và, khi cần xác thực, `secretName` +
   `secretKey` — TÊN của một `Secret` trong `udp-system`, không bao giờ giá trị. Nhờ vậy bộ
   forwarder (Fluent Bit, Fluentd) gửi được tới BẤT KỲ provider `logs.sink` nào, kể cả ba
   provider ở domain Monitoring (Datadog, New Relic, Dynatrace).
4. **Khoá dạng phẳng trong `Secret` của release:** `secretKeys(config)` cạnh `secretValues`
   — khoá mà workload khác mount bằng `secretKeyRef` (mật khẩu OpenSearch, HEC token, license
   key) chứ không đọc được từ `values.yaml` lồng nhau.

## 2. Quyết định

- **QĐ-1 — "Fluentd / Fluentbit" là HAI tool** (`fluent-bit`, `fluentd`): hai chart, hai cách
  chạy (DaemonSet nhẹ; aggregator có buffer), cùng vai forwarder. Gộp thành một tool là một cấu
  hình đổi chart — lớp nền không có (chart là dữ liệu tĩnh của adapter, điều kiện của drift).
- **QĐ-2 — Forwarder `requires: logs.sink`, không `provides` gì**: hai forwarder cùng domain với
  các backend nên KHÔNG ghép được với Loki/ELK/OpenSearch trong cùng project (mỗi domain một
  tool); chúng dành cho sink ở domain khác (Datadog, New Relic, Dynatrace của Monitoring). Mỗi
  backend tự mang bộ thu log của nó (promtail, Beats, Fluent Bit của OpenSearch).
- **QĐ-3 — `logs.sink` giữ major 1** và giao thức nằm trong `attributes.protocol`: consumer của
  log là bộ forwarder đa giao thức, không phải SDK một giao thức như trace (khác QĐ-8 của Plan
  #31). Forwarder gặp giao thức nó không có output ⇒ `values()` NÉM (deploy FAILED), không đoán.
- **QĐ-4 — `companions` KHÔNG mang bí mật riêng:** chỉ release chính có `Secret`; release đi kèm
  đọc nó trong cùng namespace — qua `secretKeyRef` (khoá phẳng), hay qua `readsSecretValues`
  (nhận `values.yaml` bí mật, cho chart chỉ nhận bí mật dưới dạng giá trị Helm, ví dụ issuer key
  của Linkerd ở Plan #33). Một bí mật, một chỗ niêm phong, một chỗ xoá khi tắt.
- **QĐ-5 — ELK qua ECK** (`eck-operator` + `eck-stack`): chart `elastic/elasticsearch` cũ đã
  ngừng; mật khẩu `elastic` do ECK sinh trong `Secret` `<cluster>-es-elastic-user` — UDP không
  giữ bí mật nào cho ELK.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Bảy adapter qua đủ 42 phép, 0 nới lỏng (`E1-relaxations.json`)                                                                        |
| AC-2 | Lớp nền nhiều release: áp theo thứ tự, gỡ ngược thứ tự, xoá/sửa tay BẤT KỲ release hay ConfigMap nào ⇒ drift; `switch` giữ ConfigMap  |
| AC-3 | Mọi provider `logs.sink` (3 ở Monitoring + 5 ở Logging) khai `attributes.protocol`; khoá chỉ là TÊN `Secret` + khoá, không giá trị    |
| AC-4 | Fluent Bit / Fluentd + mỗi provider có xác thực: output đúng plugin, khoá qua `secretKeyRef`; sink đổi ⇒ `onDependencyChanged` áp lại |
| AC-5 | Validator: Fluent Bit không có `logs.sink` ⇒ `MISSING_CAPABILITY` kèm gợi ý domain Monitoring                                         |
| AC-6 | Không thoái cấp                                                                                                                       |

## 4. Nợ kiểm chứng

Chart và output thật trên cluster: gộp vào `helm-real` / `I32-cluster`; Splunk HEC và Datadog
intake thật: mục mới `saas-logs-real`.
