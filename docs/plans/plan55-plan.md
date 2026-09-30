# Plan #55 — kế hoạch thực hiện

Spec: `plan55-spec.md`. Mỗi đợt một commit, cổng của đợt xanh trước khi sang đợt sau.

| Đợt | Việc                                                                                                                                                      | Cổng                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 55a | **Database:** migration bốn bảng + grant `udp_s1` + đường lùi; Prisma schema; I22 khai bốn bảng                                                           | `@udp/db` (I22 và các bất biến), `prisma generate`, typecheck              |
| 55b | **Service 1:** hàm vai hiệu lực dùng chung (middleware, danh sách project, trang chủ, SSE); route lời mời, nhóm, trao quyền; wire + golden; test tích hợp | typecheck, test S1 theo lô (chạm project/member/home/wire), `wire-golden`  |
| 55c | **Portal:** `/app/teams`, chi tiết nhóm, Thành viên (lời mời + nhóm có quyền), `/invite/:token`, thanh bên; hai ngôn ngữ; test                            | test Portal, design-lint, typecheck, lint                                  |
| 55d | **Bản xem thử + cổng:** seed nhóm/lời mời, route giả, `contract.check`, màn mới trong `portal-demo`; **tài liệu**: §2.2, §9, §10, §16, D-P48, bàn giao    | `test` của Portal (kể cả demo), Playwright năm lượt, design-lint, prettier |

Sau Plan #55 là Plan #56 (người dùng, 30/09): trang biểu đồ bằng chứng thực nghiệm trong Bảng điều khiển nền tảng
cho các benchmark và metric của §14.
