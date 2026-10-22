# Plan #54 — kế hoạch thực hiện

Spec: `plan54-spec.md`. Mỗi đợt một commit, cổng của đợt xanh trước khi sang đợt sau.

| Đợt | Việc                                                                                                                                                                                                                                                                                                  | Cổng                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 54a | **Nền:** `src/i18n/` (store ngôn ngữ, `defineMessages`, `useMessages`, `count`), `lib/format.ts` theo ngôn ngữ, giao diện ba lựa chọn + nghe hệ điều hành, bộ chọn ở menu tài khoản và trang đăng nhập; chuyển khung (Shell, AppShell, AdminLayout, RouteError, component dùng chung, errors) làm mẫu | test i18n + theme, test Portal theo lô, typecheck, lint                       |
| 54b | **Chuyển chữ** của mọi phân hệ sang `*.messages.ts` với bản tiếng Anh (theo bảng thuật ngữ bên dưới); bốn luật lint của QĐ-2 bật                                                                                                                                                                      | design-lint của Portal, test Portal theo lô (tiếng Việt không đổi), typecheck |
| 54c | **Kiểm:** test tiếng Anh cho vài màn; cổng `portal-demo` thêm lượt tiếng Anh + tối + axe `color-contrast`; sửa tương phản ở nguồn                                                                                                                                                                     | Playwright bốn lượt ở máy dev (Edge), `test` của Portal                       |
| 54d | **Tài liệu:** DESIGN.md, `UDP_design.md` §10 + D-P46/47, bàn giao; mở bản xem thử cho người dùng                                                                                                                                                                                                      | design-lint, prettier                                                         |

## Bảng thuật ngữ tiếng Anh

Giữ nguyên (thuật ngữ của sản phẩm, đã là tiếng Anh trong bản Việt): Flag, Segment, Rollout, Deploy, Domain,
Environment, Workload, Cluster, Project, Tool, Capability, Drift, Canary, Webhook, SDK key, Namespace, Credential.

| Tiếng Việt               | English            | Tiếng Việt           | English           |
| ------------------------ | ------------------ | -------------------- | ----------------- |
| Tổng quan                | Overview           | Chủ sở hữu / OWNER   | Owner             |
| Trang chủ                | Home               | Người duy trì        | Maintainer        |
| Kiến trúc                | Architecture       | Nhà phát triển       | Developer         |
| Giám sát                 | Monitoring         | Người xem            | Viewer            |
| Hạ tầng                  | Infrastructure     | Ổn định              | Healthy           |
| Mã nguồn                 | Source code        | Cần xem              | Needs attention   |
| Cài đặt                  | Settings           | Lỗi                  | Error             |
| Bảng điều khiển nền tảng | Platform console   | Đang chạy            | Running           |
| Nhà phát hành            | Operator           | Tạm dừng             | Paused            |
| Việc cần xử lý           | Needs attention    | Chờ duyệt            | Awaiting approval |
| Tài nguyên mồ côi        | Orphaned resources | Lệch cấu hình        | Drifted           |
| Dựng hạ tầng             | Provision          | Bản nháp / Nháp      | Draft             |
| Gỡ hạ tầng               | Tear down          | Lưu trữ              | Archive           |
| Áp domain                | Apply domains      | Thử lại              | Retry             |
| Đang tải…                | Loading…           | Không tìm thấy trang | Page not found    |

Văn phong tiếng Anh: câu ngắn, viết hoa đầu câu (sentence case), không chấm cuối nhãn, dấu ba chấm là `…`.
