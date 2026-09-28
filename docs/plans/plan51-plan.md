# Plan #51 — PLAN (theo `plan51-spec.md` v1)

Bốn đợt, mỗi đợt một commit xanh.

| Đợt | Làm gì                                                                                                                                                                                                  | Cổng                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 51a | `packages/cluster-access` (chuyển từ S1, thêm subresource); RBAC `rollouts/status`, `canaries`, `analysistemplates`; route `POST /internal/clusters/:id/token`; S3 `RemoteTokenSource` + cache truy cập | test cluster-access, S1 (cluster, token route), S3, design-lint |
| 51b | Bộ dựng CR (`modules/rollout/delivery/`: Argo, Flagger, AnalysisTemplate) + I4; migration `traffic_match`; S1 tạo SERVICE_LEVEL (ma trận, áp CR, bù trừ); Luồng 3 chặn/khôi phục                        | test S1 rollout, deploy job, wire golden, db                    |
| 51c | S3: driver Argo/Flagger, nhánh SERVICE_LEVEL của reconciler (soi gương, promote có điều kiện, abort, intent), webhook gate Flagger; I5                                                                  | test S3                                                         |
| 51d | Portal (tạo + chi tiết SERVICE_LEVEL); thiết kế §7.3, §9, §12.2, §16, D-P39; sổ nợ; tiến độ; bàn giao cuối                                                                                              | test Portal, design-lint, lint, prettier                        |
