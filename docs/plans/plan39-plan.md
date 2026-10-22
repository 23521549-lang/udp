# Plan #39 — PLAN (theo `plan39-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                                                                                    | Cổng                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| P1  | S1: `requireInternalCaller` dùng chung; `GET …/metrics-source`, `POST …/metrics` (một phép đo), mount ngoài `/api/v1`; §9 Internal của S1 | tích hợp S1 (AC-3/4)     |
| P2  | S1: nguồn `inCluster` qua `proxyService` với truy cập cluster được nhớ theo hạn token; probe của S1 dùng cùng đường                       | tích hợp S1 (AC-2)       |
| P3  | S3: `RemoteMetricsProvider`, `providerFor` theo environment của session; S1 chết ⇒ `hasData: false` ⇒ HOLD                                | tích hợp S3 (AC-1, AC-4) |
| P4  | §7.4/§16/ADR-06 (D-P30), bàn giao; cổng S1 + S3 + design-lint                                                                             | cổng đầy đủ (AC-5)       |
