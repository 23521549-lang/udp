# Bàn giao — UDP, 01/10/2026

Tài liệu này đọc được mà không cần phiên làm việc nào. Nó thay `trang-thai-2026-09-30.md` ở vai "điểm bắt đầu cho
người tiếp theo"; tệp đó giữ nguyên các mục không đổi (Plan #53…#57, CI, bản xem thử). Nguồn sự thật của thiết kế là
`docs/UDP_design.md`; của phép đo là `docs/measurements/` (nợ trong `kiem-chung-con-no.md`); của từng plan là
`docs/plans/`.

**Trạng thái một câu:** hai portal đã qua một vòng tối ưu UX theo người dùng lần đầu, `/` là trang giới thiệu dựng sẵn,
tài khoản có điều khoản, quên mật khẩu và đăng nhập GitHub; còn 46 mục nợ kiểm chứng, mỗi mục cần hạ tầng, tài khoản
bên ngoài hay người thật. Hạ tầng của dự án tốn đúng 0 đồng và không chạy trên máy người dùng (D-P37, D-P41).

## 1. Ba plan của đợt này

| Plan | Tài liệu                          | Người dùng                                                                                                    |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| #58  | `docs/plans/plan58-de-xuat-ux.md` | "tối ưu UX của hai portal để nó dễ dùng và dễ hiểu … đề xuất trước cho tôi xem" ⇒ 41 mục UX, bản mẫu đã duyệt |
| #59  | `docs/plans/plan59-landing.md`    | "mình chưa có trang giới thiệu … dựng lên cho tôi xem" ⇒ bản mẫu đã duyệt                                     |
| #60  | `docs/plans/plan60-hoan-thien.md` | "oke duyệt nhé, bạn làm luôn những cái còn tồn đọng nhé" ⇒ H1–H9 của #58, L1–L6 của #59                       |

| Commit                            | Nội dung                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `a91b7f0`                         | Plan #58: đề xuất (chưa sửa mã)                                                                                             |
| `13c1523` … `75466ba` (12 commit) | Bản mẫu Plan #58: UX-1…UX-17, UX-19…UX-22, UX-24…UX-41 trên chính Portal; dữ liệu mẫu; cổng axe WCAG 2.2 AA đủ luật         |
| `4ab0766`                         | Bản mẫu Plan #59: trang giới thiệu, đăng nhập và đăng ký làm lại, vai Khách trong bản xem thử                               |
| `950e194`                         | H3 (UX-23): `Decision.detail` mã + số, `rollout_events.reason_detail`, Portal viết câu theo ngôn ngữ                        |
| `0097c15`                         | H2: nhật ký của Service 2 ghi `flagKey`                                                                                     |
| `999b556`                         | H1, H6, H8: lọc và sắp xếp ở máy chủ cho danh sách quản trị, `latestProblemJob`, khoá cache có kiểu                         |
| `f78a524`, `fd0f893`, `6ef73a5`   | H4 `CommandPalette` dùng chung; H5 gom `ux-*.css` vào `portal.css`; H7 đoạn mã OFREP đối chiếu gói 0.4.3                    |
| `6ac5ba2`                         | L2–L4 máy chủ: điều khoản và đồng ý, quên mật khẩu (SMTP), GitHub OAuth, `GET /auth/options`; migration; `UDP_design.md`    |
| `894c723`                         | L2–L4 Portal: `/terms`, `/privacy`, `/forgot-password`, `/reset-password`, ô đồng ý, nút GitHub; bản xem thử; DESIGN.md §8c |
| `93cf8ba`                         | L1, L5, L6: nhật ký thay đổi trên trang giới thiệu, dựng sẵn `/` lúc build, `llms.txt` + `index.md`, nginx và Dockerfile    |
| (commit này)                      | H9: ảnh trang giới thiệu chụp lại, sổ nợ, kết quả các plan, bàn giao                                                        |

Quyết định mới trong bảng D-P của §10.15: **D-P51** tối ưu UX theo người dùng lần đầu (Plan #58 + H1–H8), **D-P52**
trang giới thiệu dựng sẵn và bản cho agent đọc, **D-P53** điều khoản, quên mật khẩu, GitHub OAuth.

## 2. Cho người tiếp theo

- **Bật quên mật khẩu và đăng nhập GitHub** trên một bản chạy thật: đặt `SMTP_URL` + `MAIL_FROM` (dịch vụ SMTP có gói
  miễn phí) và `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` (OAuth App của GitHub, callback
  `<CORS_ORIGIN>/api/v1/auth/github/callback`) — xem `.env.example`. Thiếu biến nào thì tính năng đó tắt và Portal ẩn
  link (`GET /auth/options`); `env-schema` từ chối cấu hình nửa vời (có ID mà thiếu secret). Kiểm thật: sổ nợ
  `auth-external-real`.
- **Sửa Điều khoản hay Quyền riêng tư:** sửa `features/legal/legal.messages.ts`, rồi đổi CÙNG lúc `LEGAL.termsVersion`
  (`packages/config/src/constants.ts`) và `LEGAL_VERSION` (`features/legal/LegalPage.tsx`) — test của Portal đỏ khi
  hai số lệch. Trước khi mở đăng ký công khai: sổ nợ `legal-review`.
- **GitHub không tự liên kết theo email** (chặn chiếm tài khoản đặt trước vì UDP chưa xác minh email lúc đăng ký): email
  GitHub trùng một tài khoản mật khẩu thì người dùng được bảo đăng nhập bằng mật khẩu. Muốn liên kết từ trang Cài đặt
  là việc mới (chưa làm), phải đi qua một phiên đã đăng nhập.
- **Trang giới thiệu dựng sẵn:** `pnpm --filter @udp/portal build` (hay `build:static` trong Docker) chạy hai lượt Vite
  rồi `scripts/prerender.mjs`. `dist/index.html` là trang ĐÃ VẼ bằng tiếng Việt; mọi đường khác nhận `dist/app.html`
  (`deploy/docker/nginx.conf`). Component của trang giới thiệu phải vẽ được trong Node (không đọc `window` lúc render):
  `prerender.test.tsx` và lượt build bắt chỗ vỡ. `llms.txt` và `index.md` sinh từ chính `landing.messages.ts`, không
  sửa tay.
- **Thêm một mục nhật ký thay đổi:** `features/landing/changelog.messages.ts` (song ngữ, có ngày); trang hiện bốn mục mới
  nhất, `index.md` có đủ.
- **Thêm một mã lý do quyết định rollout:** `decisionDetailSchema` (`@udp/shared-types`) ⇒ `decide()`/`settleGate()`
  của Service 3 ⇒ `features/rollout/decision-reason.ts` của Portal (`switch` không `default`: mã chưa có câu là lỗi
  biên dịch).
- **Ảnh trang giới thiệu** là ảnh chụp thật của bản xem thử: `pnpm --filter @udp/portal demo:build` rồi `demo:shots`
  (sáng, tối × Việt, Anh; WebP).

## 3. Cưỡng chế thêm

| Chốt                                                                                                                                                                                                          | Ở đâu                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Quyết định rollout có `detail` đúng mã cho mọi nhánh; sự kiện tự lùi ghi `reason_detail`                                                                                                                      | `services/pd-controller/tests/decision.test.ts`, `reconciler.integration.test.ts` |
| Service 1 trả `detail`/`reasonDetail` qua cùng schema; hàng sai hình bị bỏ và log                                                                                                                             | `services/core-backend/tests/rollout.integration.test.ts`                         |
| Lọc vai, sắp xếp, tìm theo tên hay email chủ, `latestProblemJob` đúng một job mỗi project                                                                                                                     | `services/core-backend/tests/admin.integration.test.ts`                           |
| Đăng ký thiếu ô đồng ý ⇒ 400; quên mật khẩu luôn 202; token một lần, hết hạn, thu hồi mọi phiên; GitHub: tạo, đăng nhập lại, email trùng tài khoản mật khẩu, `state` sai, từ chối, không email, open redirect | `services/core-backend/tests/auth-recovery.integration.test.ts`                   |
| `state` ký và hết hạn; chỉ email chính ĐÃ XÁC MINH; phạm vi xin quyền                                                                                                                                         | `services/core-backend/tests/github-oauth.test.ts`                                |
| Cấu hình SMTP và GitHub phải đủ cặp                                                                                                                                                                           | `packages/config/tests/env-auth.test.ts`                                          |
| `password_reset_tokens`, `user_identities` trong ma trận writer (chỉ Service 1)                                                                                                                               | `packages/db/tests/invariants/i22-writer-matrix.test.ts`                          |
| Trang Quên/Đặt lại mật khẩu, ô đồng ý, nút GitHub theo `/auth/options`, phiên bản điều khoản khớp máy chủ                                                                                                     | `apps/portal/tests/auth-recovery.test.tsx`                                        |
| `llms.txt` đúng khuôn, `index.md` hai ngôn ngữ với số domain và công cụ đếm được                                                                                                                              | `apps/portal/tests/prerender.test.tsx`                                            |
| Năm lượt Playwright × màn mới của khách (quên, đặt lại mật khẩu, điều khoản, quyền riêng tư), axe đủ luật                                                                                                     | `apps/portal/demo/screens.pw.ts`                                                  |

## 4. Còn nợ — 46 mục

Thêm: `legal-review` (luật sư đọc hai trang trước khi mở công khai; chưa có pháp nhân và địa chỉ liên hệ thật),
`auth-external-real` (SMTP và OAuth App thật). Chi tiết: `docs/measurements/kiem-chung-con-no.md`; bảng phân nhóm
44 mục cũ ở `trang-thai-2026-09-30.md` §4 không đổi.

Ba điều biết rõ, không phải nợ kiểm chứng:

- Trang giới thiệu tải phông Geist từ Google Fonts; trang Quyền riêng tư nói rõ điều đó. Tự phục vụ phông (gói
  `geist` trên npm) bỏ được bên thứ ba này và nhanh hơn cho trang dựng sẵn — chưa làm, cần duyệt vì đổi trang
  Quyền riêng tư.
- Open Graph chưa có `og:image`: thẻ đó cần địa chỉ tuyệt đối, tức tên miền công khai (chưa có, `vm-oracle-real`).
- Bản build của bản xem thử (một tệp JS, cố ý) vượt ngưỡng cảnh báo 1 200 KB của Vite từ trước Plan #59.

## 5. Bản xem thử — chạy ở máy, không publish

Như `trang-thai-2026-09-30.md` §5, thêm: vai **Khách (chưa đăng nhập)** mở thẳng bằng `?as=visitor#/` (trang giới
thiệu, đăng nhập, đăng ký, quên mật khẩu, hai trang pháp lý); nút GitHub được giả lập (bấm là "đăng nhập" ngay);
đăng nhập rồi tải lại trang không mất phiên trong thẻ đó. Dữ liệu mẫu: 161 người dùng (7 quản trị), 37 project ở mọi
trạng thái, 54 flag ở `checkout-service`, 13 rollout ở mọi kết cục.

## 6. Đang chờ người dùng

Câu hỏi "đóng gói ứng dụng thành container": Golden Path hôm nay chỉ có Dockerfile mẫu cho Node.js và Python. Hai
hướng đã nêu: Cloud Native Buildpacks (đề xuất — nhận diện ngôn ngữ, không cần Dockerfile) hay thêm Dockerfile mẫu cho
từng ngôn ngữ. Chưa làm cho tới khi người dùng chọn.

Commit chỉ ở máy; người dùng tự đẩy lên GitHub. Không đọc hay commit `.env*`.
