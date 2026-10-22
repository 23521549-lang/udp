# Plan #37 — PLAN (theo `plan37-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                                                                                                   | Cổng                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1  | `infra.provision`, `security.scan` (shared-types, §5.3, oracle E8); `PipelineStep` + `PipelineTemplateParams.steps` (adapter-core, §5.2, D-P28)          | test thuần, design-lint                |
| P2  | Export `pipelineSteps` (registry kiểm lúc nạp); lớp nền bước pipeline trên lớp nền mô tả; sáu CI adapter dựng bước theo pha; `pipelineTemplate` gom bước | test thuần + bộ CI/CD mở rộng (AC-3/4) |
| P3  | Lớp nền Helm: `HelmChartRef.installer`, companion `before`; export `cloud` + `CLOUD_MISMATCH` ở kiểm/lưu domain                                          | test lớp nền (AC-5)                    |
| P4  | IaC: Crossplane, ACK, Config Connector, ASO (Helm); Terraform, Pulumi, Ansible (bước pipeline)                                                           | bộ hợp đồng (AC-1)                     |
| P5  | Security: Trivy, Snyk, Aqua, Falco (Helm); Checkov, Grype, ZAP (bước pipeline)                                                                           | bộ hợp đồng (AC-1)                     |
| P6  | §5.5, sổ nợ `iac-security-real`, bàn giao; cổng S1 + Portal + design-lint                                                                                | cổng đầy đủ (AC-6)                     |
