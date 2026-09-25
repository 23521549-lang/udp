# Plan #36 — PLAN (theo `plan36-spec.md` v1)

| Pha | Làm gì                                                                                                                           | Cổng                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P1  | Lớp nền `CicdAdapter` (bọc ba hàm thuần + họ Helm/SaaS); cột `webhook_secret` niêm phong; sinh/xoay secret, audit                | test thuần, tích hợp (AC-5)               |
| P2  | `POST /webhooks/cicd/:projectId/:provider`: thân thô, giới hạn cỡ, verify, parse, idempotent, 401/413                            | tích hợp (AC-3)                           |
| P3  | Deploy: `DEPLOY_START`, patch image bằng `udp-workload`, job `DEPLOY_WATCH`, undo + FAILURE + ROLLBACK; `DEPLOY_PENDING` + duyệt | tích hợp (AC-4, AC-6)                     |
| P4  | Sáu adapter: GitHub Actions, GitLab CI, CircleCI (SaaS); Jenkins, Tekton, Drone (Helm)                                           | bộ hợp đồng + bộ CI/CD (AC-1), AST (AC-2) |
| P5  | Portal (secret webhook hiện một lần, duyệt deploy chờ), §8.3/§5.5, sổ nợ, bàn giao; cổng S1 + Portal                             | test Portal, design-lint, S1 đầy đủ       |
