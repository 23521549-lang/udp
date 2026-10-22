# Plan #60: Hoàn thiện sau duyệt (Plan #58 H1–H9, Plan #59 L1–L6)

Ngày 01/10/2026. Người dùng duyệt hai bản mẫu (Portal tối ưu UX, trang giới thiệu) và nói: "bạn làm luôn những cái
còn tồn đọng nhé". Nhánh `ux58-prototype`; xong thì gộp vào `main` (commit cục bộ, người dùng tự push).

## 1. Phạm vi

| Mã         | Việc                                                                                | Quyết định |
| ---------- | ----------------------------------------------------------------------------------- | ---------- |
| H3         | Lý do quyết định rollout theo ngôn ngữ (UX-23)                                      | QĐ-1       |
| H2         | Nhật ký của Service 2 gọi tên flag                                                  | QĐ-2       |
| H1, H8, H6 | Bộ lọc thật cho danh sách quản trị; job gần nhất theo project; khoá cache có kiểu   | QĐ-3       |
| H4, H5     | Bảng lệnh Ctrl K dùng chung; gom `ux-*.css`                                         | QĐ-4       |
| H7         | Đối chiếu tuỳ chọn `headers` của `@openfeature/ofrep-web-provider` với mã nguồn gói | QĐ-5       |
| L2         | Điều khoản, Quyền riêng tư, đồng ý rõ ràng khi đăng ký                              | QĐ-6       |
| L3         | Quên mật khẩu                                                                       | QĐ-7       |
| L4         | Đăng nhập bằng GitHub                                                               | QĐ-8       |
| L1, L5     | Trang giới thiệu dựng sẵn thành HTML tĩnh; `llms.txt`                               | QĐ-9       |
| L6         | Nhật ký thay đổi có ngày trên trang giới thiệu                                      | QĐ-10      |
| H9         | `UDP_design.md`, quyết định D-P, bàn giao                                           | QĐ-11      |

## 2. Quyết định

**QĐ-1 (H3).** `Decision` (shared-types) thêm `detail`: một union có mã (`NO_DATA`, `WARMING_UP`, `SETTLING`,
`WITHIN_THRESHOLDS`, `BREACH`, `MANUAL_ONLY`), `BREACH` mang danh sách nguyên nhân có số (tỉ lệ lỗi tuyệt đối, tương
đối với z, p99) cùng chuỗi `streak/needed`. `decide()` và `settleGate()` sinh `detail` cùng lúc với câu `reason`;
`reason` giữ nguyên làm nhật ký máy chủ và lý do gửi Service 2. Sự kiện tự rollback ghi `detail` vào cột mới
`rollout_events.reason_detail` (JSONB, NULL được; S3 đã có INSERT cả bảng). Service 1 đọc cả hai qua CÙNG schema,
trả `lastDecision.detail` và `event.reasonDetail`. Portal viết câu theo ngôn ngữ từ `detail`; không có `detail`
(hàng cũ, lý do vận hành) thì hiện `reason` như trước. `last_decision` là JSONB nên không cần migration; hàng cũ
không có trường thì `detail = null` (default của schema).

**QĐ-2 (H2).** Service 2 ghi `flagKey` vào `details` của nhật ký `flag.env.update` và `flag.rule.update`; Portal đã
đọc trường này (bản mẫu).

**QĐ-3 (H1, H8, H6).** `/admin/users` nhận `platformRole`, `order`; `/admin/projects` nhận `search`, `order` và trả
`latestProblemJob` của từng project (job gần nhất ở một trong ba trạng thái của trang Job lỗi, một truy vấn
`DISTINCT ON`), thay cho việc Portal tự tìm trong trang đầu của danh sách job lỗi. `qk.adminUsers`/`qk.adminProjects`
nhận object bộ lọc có kiểu.

**QĐ-4 (H4, H5).** Một component `CommandPalette` dùng chung (khung listbox, bàn phím, nhóm), mỗi portal chỉ khai
nguồn mục. CSS của Plan #58 về đúng mục trong `portal.css`; `.alert.neutral`, `.alert.ok` thành kiểu chung.

**QĐ-5 (H7).** Đọc mã nguồn gói đã phát hành (npm) để chốt tên tuỳ chọn header; sửa đoạn mã mẫu nếu lệch.

**QĐ-6 (L2).** Hai trang công khai `/terms`, `/privacy`, viết đúng những gì hệ thống làm (dữ liệu nào, ở đâu, giữ
bao lâu, cookie nào). Đăng ký phải tích ô đồng ý (không tích sẵn): Nghị định 13/2023/NĐ-CP coi im lặng không phải
đồng ý. Service 1 nhận `acceptTerms: true` và lưu `terms_version`, `terms_accepted_at` trên người dùng.
**Trước khi mở công khai, hai trang cần luật sư đọc** (ghi ở sổ nợ, không giả là đã duyệt).

**QĐ-7 (L3).** `POST /auth/password/forgot` luôn trả 202 (không lộ email nào có tài khoản); token 32 byte ngẫu nhiên,
lưu băm SHA-256, sống 30 phút, dùng một lần; link ở fragment (`/reset-password#<token>`, như lời mời) nên token
không vào log máy chủ. `POST /auth/password/reset` đặt mật khẩu mới và thu hồi mọi phiên. Gửi thư qua SMTP
(`nodemailer`), cấu hình bằng `SMTP_URL` + `MAIL_FROM`; dịch vụ SMTP có gói miễn phí (Brevo, Resend…) nên giữ chi
phí 0. Không cấu hình thì tính năng tắt và Portal ẩn link (đọc `GET /auth/options`).

**QĐ-8 (L4).** OAuth của GitHub (app OAuth miễn phí): `GET /auth/github/start` đặt `state` (cookie httpOnly, 10
phút) và chuyển sang GitHub; `GET /auth/github/callback` đổi `code`, đọc email chính ĐÃ XÁC MINH, đăng nhập người có
liên kết GitHub đó, hoặc tạo người mới khi email chưa có tài khoản và người dùng đã đồng ý điều khoản ở trang đăng
ký. Email đã có tài khoản mật khẩu thì KHÔNG tự liên kết (chặn chiếm tài khoản đặt trước, vì UDP chưa xác minh
email khi đăng ký): báo đăng nhập bằng mật khẩu. Bảng `user_identities (provider, provider_user_id)`; người tạo bằng
GitHub có `password_hash` NULL và đặt được mật khẩu qua Quên mật khẩu. Không cấu hình `GITHUB_CLIENT_ID/SECRET` thì
nút ẩn.

**QĐ-9 (L1, L5).** Build Portal thêm một lượt SSR của Vite và script dựng sẵn: `dist/index.html` là trang giới thiệu
đã vẽ (tiếng Việt) với `title`, `meta description`, Open Graph và CSS của trang; `dist/app.html` là vỏ SPA cho mọi
đường khác (nginx: `location = /` ⇒ `index.html`, còn lại ⇒ `app.html`). Script sinh luôn `llms.txt` và
`index.md` từ CHÍNH chữ của trang. Ảnh hero dùng `<picture>` theo giao diện hệ thống khi người xem chưa chọn tay.

**QĐ-10 (L6).** Danh sách thay đổi có ngày lấy từ lịch sử thật của các plan (một tệp dữ liệu có kiểu, song ngữ),
bốn mục gần nhất hiện trên trang giới thiệu.

**QĐ-11 (H9).** `UDP_design.md` (§2.2 bảng, §9 wire, §10 màn, §16), D-P mới, `DESIGN.md`, bàn giao.

## 3. Cổng

Typecheck và lint toàn repo đụng tới; test của `@udp/db`, Service 1, 2, 3 theo lô chạm; `wire-golden`; Portal
(Vitest, demo contract); Playwright năm lượt (chạy từng lượt để máy đủ bộ nhớ); `deploy` test; design-lint.

## 4. Kết quả (01/10/2026)

| Commit    | Mục                                                                                          |
| --------- | -------------------------------------------------------------------------------------------- |
| `950e194` | H3 — lý do quyết định rollout dạng mã + số                                                   |
| `0097c15` | H2 — `flagKey` trong nhật ký của Service 2                                                   |
| `999b556` | H1, H6, H8 — lọc và sắp xếp ở máy chủ, `latestProblemJob`, khoá cache có kiểu                |
| `f78a524` | H4 — `CommandPalette` dùng chung                                                             |
| `fd0f893` | H5 — gom `ux-*.css`                                                                          |
| `6ef73a5` | H7 — đoạn mã OFREP đối chiếu `@openfeature/ofrep-web-provider` 0.4.3                         |
| `6ac5ba2` | L2–L4 máy chủ — điều khoản, quên mật khẩu, GitHub OAuth, `GET /auth/options`, migration      |
| `894c723` | L2–L4 Portal — hai trang pháp lý, ô đồng ý, quên và đặt lại mật khẩu, nút GitHub             |
| `93cf8ba` | L1, L5, L6 — dựng sẵn `/`, `llms.txt` + `index.md`, nhật ký thay đổi                         |
| (sau đó)  | H9 — ảnh trang giới thiệu chụp lại, sổ nợ, bàn giao `docs/ban-giao/trang-thai-2026-10-01.md` |

**Cổng đã chạy:** typecheck (Portal, bản xem thử, Service 1, `@udp/config`, `@udp/db`, `@udp/shared-types`,
`deploy`); eslint và prettier trên mọi tệp đổi; Service 1 đủ bộ 4 245 ô (lượt chạy chung có 8 ô của `grid-tier2`
quá giờ vì máy tải nặng, chạy riêng tệp đó đạt 45/45); `@udp/db` 355/355 (I22 có hai bảng mới); `@udp/config`
26/26; `@udp/shared-types` 125/125; design-lint 158/158; `deploy` 61/61; Portal 352/352; hợp đồng bản xem thử
17/17; Playwright năm lượt 15/15 với đủ luật axe WCAG 2.2 AA, gồm bốn màn mới của khách; `build:static` sinh
`index.html` dựng sẵn 26 KB, `app.html`, `llms.txt`, `index.md`.

**Nợ mới:** `legal-review`, `auth-external-real` (`docs/measurements/kiem-chung-con-no.md`).
