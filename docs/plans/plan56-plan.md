# Plan #56 — kế hoạch thực hiện

Spec: `plan56-spec.md`. Mỗi đợt một commit, cổng của đợt xanh trước khi sang đợt sau.

| Đợt | Việc                                                                                                                                                               | Cổng                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 56a | **Số đo:** schema của tệp thô (`@udp/shared-types/measurements`); E7 chuyển sang `@udp/experiments`, ghi `raw/E7-*.json`; test mọi tệp thô parse được              | test `@udp/experiments`, `@udp/shared-types`; typecheck                                                                                                                                                                                                  |
| 56b | **Service 1:** `GET /admin/evidence/dora?days=` (cùng `computeDora`); wire + golden; test tích hợp                                                                 | typecheck, lint, test S1 (admin, deployment, wire-golden)                                                                                                                                                                                                |
| 56c | **Portal:** `CategoryChart`; sổ thí nghiệm + chữ hai ngôn ngữ; trang `/admin/evidence` với biểu đồ từng phép đo, nguồn, tải JSON/CSV; phép kiểm "không trôi"; test | test Portal, design-lint, typecheck, lint                                                                                                                                                                                                                |
| 56d | (commit này)                                                                                                                                                       | `contract.check` 8/8 (E10 đủ ngày lịch ở ba cửa sổ); cổng `portal-demo` năm lượt xanh; sau khi đổi nhãn trục E14 (`T0·V2`), lượt chạy lại xanh ở máy tính rồi bị hệ thống dừng vì máy thiếu RAM — bốn lượt còn lại chưa chạy lại trên nhãn mới; prettier |

## Kết quả

| Đợt | Commit       | Cổng đã chạy                                                                                                            |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 56a | `0e410f5`    | `@udp/shared-types` 125 test (mọi tệp thô qua schema); `@udp/experiments` 21; E7 chạy thật (N = 1 000 000); design-lint |
| 56b | `8c23e33`    | S1: `wire-golden`, DORA, deployment, admin, wire-routes — 157 test; typecheck, lint                                     |
| 56c | `c2d8ae4`    | Portal 29 tệp / 241 test (kể cả luật hai ngôn ngữ, I38, SVG đã khai); build: tệp thô ở chunk riêng 81 KB                |
| 56d | (commit này) | `contract.check` 8/8 (E10 đủ ngày lịch ở ba cửa sổ); cổng `portal-demo` năm lượt; prettier                              |
