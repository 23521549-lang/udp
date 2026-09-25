# Plan #33 — PLAN (theo `plan33-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                                              | Cổng                                   |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1  | Hợp đồng binding traffic: `attributes.provider` cho `mesh.traffic-split` / `ingress.traffic-split`  | test thuần                             |
| P2  | Service Mesh: Istio (ba release), Linkerd (hai release, chứng chỉ người dùng), Consul Connect, Kuma | bộ hợp đồng (AC-1), AC-5               |
| P3  | Ingress: NGINX, Traefik                                                                             | bộ hợp đồng (AC-1)                     |
| P4  | Progressive Delivery: Flagger, Argo Rollouts, Spinnaker; router theo `provider`                     | bộ hợp đồng, AC-4, validator (AC-2, 3) |
| P5  | Catalog/golden, §5.5, bàn giao; cổng S1 đầy đủ                                                      | design-lint, golden, S1 đầy đủ         |
