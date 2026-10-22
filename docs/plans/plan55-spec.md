# Plan #55 — Mời vào project bằng đường dẫn, và Nhóm dùng chung cho nhiều project

Người dùng (30/09/2026): "bạn lên kế hoạch và làm theo quy trình đi" — cho hai thứ còn thiếu đã nêu: mời người CHƯA
có tài khoản vào project, và nhóm (team) dùng chung cho nhiều project, có phân quyền.

## 1. Hiện trạng

| Việc            | Có                                                                                                  | Thiếu                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Thêm thành viên | OWNER thêm theo email + vai (`POST /projects/:id/members`), đổi vai, gỡ, chuyển quyền sở hữu; audit | Người được mời phải ĐÃ có tài khoản — không thì 404 "Chưa có tài khoản nào dùng email này" (§16)                   |
| Phân quyền      | 4 vai theo thứ bậc; `requireMinProjectRole` đọc MỘT hàng `project_members` cho mọi route (I10)      | Không có đơn vị nào lớn hơn một người: nhóm 10 người làm 5 project là 50 lần thêm tay, và rời nhóm là 5 lần gỡ tay |
| Gửi email       | Không có hạ tầng mail (§16)                                                                         | Yêu cầu cứng chi phí 0: một dịch vụ mail là một tài khoản có thể tính tiền, và một bí mật phải giữ                 |

## 2. Quyết định

### QĐ-1: Lời mời bằng đường dẫn, không gửi mail

OWNER tạo một **lời mời** cho một email và một vai (không phải OWNER). Máy chủ sinh một token 256 bit, chỉ lưu
**hash** (SHA-256, như refresh token và SDK key), trả **đường dẫn một lần** `/invite/<token>` để OWNER tự gửi qua
kênh nào cũng được (chat, mail của chính họ). Token chỉ hiện một lần.

- Hạn 7 ngày; dùng một lần; OWNER thu hồi được; mỗi (project, email) chỉ một lời mời còn hiệu lực (index duy nhất
  từng phần).
- **Nhận**: người mở đường dẫn thấy tên project, vai, người mời. Chưa đăng nhập ⇒ đăng nhập hay tạo tài khoản rồi
  quay lại đúng đường dẫn. Nhận chỉ được khi **email của tài khoản đang đăng nhập trùng email của lời mời** (không
  phân biệt hoa thường): đường dẫn lọt sang người khác cũng không dùng được.
- Đã là thành viên ⇒ lời mời đánh dấu đã nhận, vai GIỮ vai cao hơn (không bao giờ hạ quyền qua lời mời).
- Mọi thao tác ghi audit của project: `invitation.create`, `invitation.revoke`, `invitation.accept`.
- Thêm trực tiếp người đã có tài khoản vẫn giữ nguyên (không thoái cấp); Portal gợi ý "Tạo lời mời" khi email chưa
  có tài khoản.
- Đọc lời mời (`GET /invitations/:token`) không cần phiên, sau rate limiter chung; token sai, hết hạn, đã dùng hay
  bị thu hồi đều trả CÙNG 404 (không dò được token nào từng có thật).

Rủi ro còn lại (ghi ở §16): UDP chưa xác thực email lúc đăng ký, nên "email trùng" chưa phải bằng chứng sở hữu
email — ai cầm được đường dẫn và đăng ký TRƯỚC bằng đúng email chưa có tài khoản đó thì nhận được lời mời. Giảm
thiểu: token chỉ đi qua kênh người mời chọn, hạn 7 ngày, thu hồi được, audit ghi tài khoản đã nhận, không mời được
vai OWNER.

Vì sao không gửi mail: chi phí 0 do cấu trúc (không tài khoản dịch vụ, không bí mật SMTP), và một đường dẫn chép
được chạy ngay hôm nay qua mọi kênh người dùng đã có. Gửi mail tự động là bước sau, khi có máy chủ mail 0 đồng.

### QĐ-2: Nhóm (team) — đơn vị trao quyền cho nhiều project

- **Nhóm** có tên và thành viên với vai nhóm **OWNER** (quản lý nhóm) hay **MEMBER**. Ai đăng nhập cũng tạo được
  nhóm và là OWNER của nhóm mình tạo. Nhóm luôn có ít nhất một OWNER.
- Thêm vào nhóm: trực tiếp theo email (đã có tài khoản) hoặc bằng **lời mời đường dẫn** — CÙNG cơ chế QĐ-1 (một
  bảng `invitations` cho hai đích, ràng buộc CHECK đúng một đích).
- **Trao quyền**: OWNER của project cấp cho một nhóm một vai trên project — VIEWER, DEVELOPER hay MAINTAINER, KHÔNG
  BAO GIỜ OWNER (chủ sở hữu luôn là một người cụ thể; chuyển quyền sở hữu giữ nguyên như cũ). Người cấp phải là
  thành viên của nhóm đó: nhóm là một đơn vị tin cậy, không trao project cho một nhóm người lạ.
- **Vai hiệu lực** của một người trên một project = vai CAO NHẤT trong: hàng `project_members` của họ, và vai của
  mọi nhóm họ thuộc mà project đã cấp. MỘT hàm tính (một câu SQL) dùng chung cho `requireMinProjectRole`, danh sách
  project, trang chủ và luồng SSE — không chỗ nào tự tính lại.
- Rời nhóm hay bị gỡ khỏi nhóm ⇒ mất quyền đến từ nhóm NGAY ở request kế tiếp (không cache vai).
- Trang Thành viên của project hiện hai phần: thành viên trực tiếp, và nhóm có quyền (tên, vai, số người). Mọi thay
  đổi trao/đổi/gỡ quyền nhóm ghi audit của project (`team.grant`, `team.grant.update`, `team.revoke`); thay đổi
  thành viên nhóm ghi audit nền tảng (`projectId = null`, như đổi vai nền tảng).

### QĐ-3: Database (một migration)

| Bảng                  | Cột chính                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teams`               | id, name (1–80 ký tự, CHECK không rỗng), created_at — người tạo là OWNER đầu tiên, audit ghi `team.create`                                                                                                                                                                                          |
| `team_members`        | team_id, user_id, team_role (enum `TeamRole`: `OWNER`/`MEMBER`), created_at; duy nhất (team_id, user_id)                                                                                                                                                                                            |
| `project_team_grants` | project_id, team_id, project_role (CHECK ≠ OWNER), created_at; duy nhất (project_id, team_id)                                                                                                                                                                                                       |
| `invitations`         | id, project_id NULL, team_id NULL, email (CHECK chữ thường), project_role NULL, team_role NULL (CHECK: đúng một đích, vai đúng kiểu của đích, không OWNER project), token_hash duy nhất, invited_by, expires_at, accepted_at, revoked_at, created_at; duy nhất từng phần (đích, email) khi đang chờ |

Cùng migration phát hiện một lệch I22 có từ Plan #51: `rollout_sessions.traffic_match` (cột cấu hình của S1) thiếu
UPDATE của `udp_s1` — danh sách cột của `service_roles` đóng băng lúc chạy. Sửa bằng một migration riêng
(`rollout_traffic_match_grant`).

Quyền database: `udp_s1` đủ bốn quyền trên bốn bảng; S2 và S3 KHÔNG có quyền nào (không nhiệm vụ nào của hai
service đó đọc thành viên) — I22 khai thêm bốn hàng. Xoá project hay nhóm ⇒ cascade grant và lời mời.

### QĐ-4: API (Service 1)

| Route                                                    | Quyền                          |
| -------------------------------------------------------- | ------------------------------ |
| `GET/POST /projects/:id/invitations`, `DELETE …/:invId`  | OWNER của project              |
| `GET/POST /projects/:id/teams`, `PATCH/DELETE …/:teamId` | GET: VIEWER; ghi: OWNER        |
| `GET /teams`, `POST /teams`                              | đăng nhập (nhóm của mình)      |
| `GET/PATCH/DELETE /teams/:teamId`                        | thành viên; ghi: OWNER nhóm    |
| `POST/PATCH/DELETE /teams/:teamId/members[/:userId]`     | OWNER nhóm; tự rời: chính mình |
| `GET/POST /teams/:teamId/invitations`, `DELETE …/:invId` | OWNER nhóm                     |
| `GET /invitations/:token`                                | không phiên, sau rate limiter  |
| `POST /invitations/:token/accept`                        | đăng nhập, email trùng         |

Người ngoài nhóm hỏi một nhóm nhận 404 như project (không dò được). Mọi route JSON có schema dây `.strict()` và mẫu
golden; `/teams/*` có guard thành viên nhóm riêng (`requireTeamRole`), không đi qua I10.

### QĐ-5: Portal (hai ngôn ngữ ngay từ đầu)

- `/app/teams`: danh sách nhóm của tôi, tạo nhóm; `/app/teams/:teamId`: thành viên (thêm, mời, đổi vai, gỡ, rời
  nhóm), project được cấp, lời mời đang chờ.
- Cài đặt → Thành viên: thêm "Tạo lời mời" (đường dẫn chép được, hiện một lần), lời mời đang chờ (thu hồi), và phần
  "Nhóm có quyền" (cấp nhóm của tôi, đổi vai, gỡ).
- `/invite/:token`: trang công khai (cùng khung với đăng nhập): nói rõ mời vào đâu, vai gì, ai mời; nút Nhận khi đã
  đăng nhập đúng email; không thì Đăng nhập / Tạo tài khoản và quay lại. `safeRedirect` nhận thêm `/invite/`.
- Thanh bên Portal thêm mục "Nhóm". Mọi chữ ở `*.messages.ts(x)` hai bản (Plan #54).

### QĐ-6: Bản xem thử và cổng

Seed: nhóm thật (ví dụ "Nhóm thanh toán", "Nhóm di động", "Nền tảng") với thành viên, grant trên vài project, lời
mời đang chờ; route giả cho mọi API mới; `contract.check` gọi hết; cổng `portal-demo` thêm màn Nhóm, chi tiết nhóm,
trang lời mời.

### QĐ-7: Chi phí 0

Không dịch vụ mail, không bí mật mới, không hạ tầng mới: bốn bảng trong PostgreSQL đang có, route trong Service 1
đang chạy.

## 3. Ngoài phạm vi

- Gửi email tự động (QĐ-1 giải thích); SSO/nhóm đồng bộ từ nhà cung cấp danh tính.
- Nhóm lồng nhóm; vai tuỳ biến ngoài bốn vai của §2.2.

## 4. Tiêu chí chấp nhận

- **AC-1** Lời mời: tạo (chỉ OWNER, không vai OWNER), đọc công khai bằng token, nhận đúng email, một lần, hết hạn,
  thu hồi; token sai/hết hạn/đã dùng/thu hồi cùng 404; không hạ quyền người đã là thành viên; audit.
- **AC-2** Nhóm: tạo, thêm/mời/gỡ thành viên, luôn còn một OWNER, rời nhóm; người ngoài 404.
- **AC-3** Trao quyền nhóm: chỉ OWNER project, người cấp phải thuộc nhóm, không vai OWNER; vai hiệu lực = cao nhất;
  gỡ khỏi nhóm ⇒ mất quyền ngay; danh sách project, trang chủ, SSE và mọi route project dùng CÙNG hàm vai hiệu lực.
- **AC-4** I22 có bốn bảng mới; migration có đường lùi; golden cho mọi route mới; `wire-golden` xanh.
- **AC-5** Portal: màn mới có test (msw + golden) ở hai ngôn ngữ; design-lint (luật hai ngôn ngữ) xanh.
- **AC-6** Bản xem thử có dữ liệu nhóm và lời mời; `contract.check` và cổng `portal-demo` năm lượt xanh.
- **AC-7** Không thoái cấp: test cũ của S1, Portal, `@udp/db` xanh; thêm thành viên trực tiếp giữ nguyên.
- **AC-8** Tài liệu: `UDP_design.md` §2.2, §9, §10, §16 (gỡ giới hạn "người được mời phải có tài khoản", ghi
  giới hạn mail), D-P48; bàn giao.
