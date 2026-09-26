# Plan #38 — PLAN (theo `plan38-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                                                                                      | Cổng                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P1  | `DomainAdapterContext.environments` (adapter-core, §5.2, D-P29; pha DOMAINS, DOMAIN_APPLY, drift, bộ hợp đồng hai env); `object.store` (18) | test thuần, design-lint        |
| P2  | Lớp nền Helm: `perEnvironment` (release mỗi env, `targetNamespace`), quota theo số env                                                      | test lớp nền (AC-2)            |
| P3  | Database: CloudNativePG, MongoDB, MySQL, Redis, K8ssandra (cert-manager dùng chung), MinIO                                                  | bộ hợp đồng (AC-1, AC-2)       |
| P4  | Cost: OpenCost, Kubecost (`requires metrics.query ^2`); `GET /projects/:id/cost` qua `proxyService`; thẻ chi phí trên Portal                | tích hợp + Portal (AC-3, AC-4) |
| P5  | §5.5, sổ nợ `db-cost-real`, bàn giao; cổng S1 + Portal + design-lint                                                                        | cổng đầy đủ (AC-5)             |
