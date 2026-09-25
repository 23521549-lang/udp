# Plan #32 — PLAN (theo `plan32-spec.md` v1.1) — XONG 26/09/2026

| Pha | Làm gì                                                                                                                                                                     | Cổng                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| P1  | Lớp nền Helm: `companions` (áp theo thứ tự, gỡ ngược, drift mọi release) và `secretKeys` (khoá phẳng trong `Secret` của release); mảnh fixture hợp đồng cho release đi kèm | bộ hợp đồng trên adapter tối thiểu hai release (AC-2) |
| P2  | Hợp đồng `logs.sink@1`: `attributes.protocol` + `secretName`/`secretKey`; ba provider ở Monitoring khai theo                                                               | test adapter, không thoái cấp                         |
| P3  | Backend trong cluster: Loki (+ Grafana), ELK (ECK), OpenSearch (+ Dashboards)                                                                                              | bộ hợp đồng (AC-1)                                    |
| P4  | Backend ngoài cluster: Splunk (OTel Collector → HEC), Datadog Logs (Agent)                                                                                                 | bộ hợp đồng (AC-1)                                    |
| P5  | Forwarder: Fluent Bit, Fluentd — output theo `protocol`, khoá qua `secretKeyRef`                                                                                           | bộ hợp đồng, test output (AC-4), validator (AC-5)     |
| P6  | Catalog/golden, §5.5/§5.3, sổ nợ `saas-logs-real`, bàn giao; cổng S1 đầy đủ                                                                                                | design-lint, golden, S1 đầy đủ                        |
