# Plan #34 — PLAN (theo `plan34-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                         | Cổng                           |
| --- | ------------------------------------------------------------------------------ | ------------------------------ |
| P1  | GitOps: Argo CD (repo + Application gốc), Flux (`flux2` + `flux2-sync`)        | bộ hợp đồng, AC-2, AC-4        |
| P2  | Policy: Gatekeeper, Kyverno (+ `kyverno-policies`), miễn trừ `udp-system`      | bộ hợp đồng, AC-3              |
| P3  | Secrets: Vault, Sealed Secrets, ESO; AWS/GCP/Azure qua CSI + workload identity | bộ hợp đồng, AC-4              |
| P4  | Catalog/golden, §5.5, bàn giao; cổng S1 đầy đủ                                 | design-lint, golden, S1 đầy đủ |
