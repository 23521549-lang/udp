# Plan #56 — kế hoạch thực hiện

Spec: `plan56-spec.md`. Mỗi đợt một commit, cổng của đợt xanh trước khi sang đợt sau.

| Đợt | Việc                                                                                                                                                               | Cổng                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 56a | **Số đo:** schema của tệp thô (`@udp/shared-types/measurements`); E7 chuyển sang `@udp/experiments`, ghi `raw/E7-*.json`; test mọi tệp thô parse được              | test `@udp/experiments`, `@udp/shared-types`; typecheck              |
| 56b | **Service 1:** `GET /admin/evidence/dora?days=` (cùng `computeDora`); wire + golden; test tích hợp                                                                 | typecheck, lint, test S1 (admin, deployment, wire-golden)            |
| 56c | **Portal:** `CategoryChart`; sổ thí nghiệm + chữ hai ngôn ngữ; trang `/admin/evidence` với biểu đồ từng phép đo, nguồn, tải JSON/CSV; phép kiểm "không trôi"; test | test Portal, design-lint, typecheck, lint                            |
| 56d | **Bản xem thử + tài liệu:** route giả DORA, `contract.check`, màn mới trong `portal-demo`; §10.11, §14, D-P49, DESIGN.md, bàn giao                                 | test Portal (kể cả demo), Playwright năm lượt, design-lint, prettier |
