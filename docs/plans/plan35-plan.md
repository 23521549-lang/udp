# Plan #35 — PLAN (theo `plan35-spec.md` v1)

| Pha | Làm gì                                                                                                                            | Cổng                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P1  | `packages.store` vào union `CapabilityId`; bootstrap tạo `udp-registry-pull` rỗng mỗi env; RBAC `resourceNames` + bộ kiểm (D-P26) | test bootstrap (AC-2)          |
| P2  | Export `pullCredential` (registry kiểm lúc nạp); pha DOMAINS / `DOMAIN_APPLY` phân phối khoá kéo; drift theo băm                  | tích hợp job (AC-3)            |
| P3  | Lớp nền `RegistryAdapter`; ECR, Artifact Registry, ACR, Docker Hub, GHCR, GitHub Packages                                         | bộ hợp đồng (AC-1)             |
| P4  | Họ Helm: Harbor, Artifactory, Nexus (`registry.oci` + `packages.store`)                                                           | bộ hợp đồng (AC-1, AC-4)       |
| P5  | Catalog/golden, §5.5/§12.2, bàn giao; cổng S1 đầy đủ                                                                              | design-lint, golden, S1 đầy đủ |
