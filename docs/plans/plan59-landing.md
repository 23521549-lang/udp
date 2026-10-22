# Plan #59: Trang giới thiệu, đăng nhập và đăng ký

Ngày 01/10/2026. Nhánh `ux58-prototype`, bản mẫu để duyệt trước khi thành mã sản phẩm (cùng quy trình Plan #58).

## 1. Vì sao

UDP sẽ thành sản phẩm thương mại, bản đầu miễn phí. Người lạ mở địa chỉ gốc hiện bị chuyển thẳng tới `/login`: không biết UDP
làm gì, chạy ở đâu, có tốn tiền không. Trang đăng nhập và đăng ký là một thẻ trơn, không đường về, không cho xem mật khẩu.

## 2. Đọc yêu cầu (skill design-taste-frontend, hallmark)

- **Loại trang:** landing SaaS cho developer và DevOps của nhóm nhỏ, Việt Nam trước, song ngữ.
- **Ngôn ngữ thiết kế:** minimal kỹ thuật (trường phái Linear, Vercel), dùng NGUYÊN token đã duyệt của Portal
  (`docs/design/DESIGN.md`: Geist, một màu nhấn xanh, đường kẻ mảnh, Lucide), sáng và tối. Không thêm font, không thêm màu.
- **Ba núm:** độ lệch bố cục 6, chuyển động 5, mật độ 4.
- **Hallmark:** thể loại modern-minimal; macrostructure **05 Workbench** (ảnh thật của sản phẩm là nội dung chính); thanh
  điều hướng **N1b** (logo, cụm link giữa, Đăng nhập và nút chính); chân trang **Ft1** (logo, câu định vị, vài link, chọn
  ngôn ngữ và giao diện).

## 3. Tham khảo (agent nghiên cứu, 15 trang, lấy ngày 01/10/2026)

Điểm chung của các trang đẹp nhất: ảnh thật của sản phẩm là hình chính (Linear, GitHub Actions), một màu nhấn dùng dè
xẻn (Supabase, Resend), đường kẻ mảnh thay bóng đổ, tiêu đề ngắn và một câu phụ, mỗi phần một việc kèm một hiện vật thật,
số liệu kiểm chứng được, nói rõ giới hạn của bản miễn phí và "không cần thẻ" (Clerk, Statsig, PostHog), nói thật điều
chưa hợp (PostHog). Trang đăng nhập: thẻ giữa màn là chuẩn; bằng chứng đặt ở panel bên (Clerk), không trong form; luôn có
đường về trang chủ.

## 4. Luật trung thực (hallmark gate 46, 47)

- Không lời chứng thực, không logo khách hàng, không số liệu bịa. Chỉ dùng số đếm được trong mã: **16 domain, 72 công
  cụ** (thư mục adapter của Service 1, khớp catalog golden), **3 cloud** (AWS, Google Cloud, Azure; EKS, GKE, AKS), **3
  cách dùng SDK** (Node.js, Python, trình duyệt qua OFREP).
- Ảnh là ảnh chụp THẬT của Portal (bản xem thử), trong `figure` có viền mảnh; không vẽ lại khung trình duyệt.
- Danh sách công cụ trên trang có test đối chiếu catalog golden của Service 1: thêm hay bỏ công cụ mà quên trang là đỏ.
- Không nút cho thứ chưa có: không "Quên mật khẩu", không đăng nhập GitHub/Google, không link Điều khoản (chưa có trang).

## 5. Phạm vi bản mẫu

1. `/` là trang giới thiệu cho người chưa đăng nhập; người đã đăng nhập vẫn vào thẳng `/app/home` như trước.
2. Các phần: điều hướng, hero (tiêu đề trái, câu phụ và hai nút phải, ảnh Kiến trúc tràn mép phải), dải số liệu thật, ba
   khối tính năng xen kẽ (domain, rollout có chú thích đánh số, flag với mã SDK thật theo tab), "hạ tầng là của bạn"
   (UDP giữ gì, tài khoản của bạn giữ gì), bảng 16 domain và 72 công cụ theo bốn nhóm việc, ba bước bắt đầu, miễn phí
   và "chưa hợp với bạn nếu", câu hỏi thường gặp, lời mời cuối, chân trang.
3. Đăng nhập: thẻ giữa, logo về trang chủ, nút hiện mật khẩu. Đăng ký: thêm panel bên (màn rộng) với ba điều được miễn
   phí, một câu về BYOC và một mẩu ảnh sản phẩm; điện thoại thì panel xuống dưới form.
4. Bản xem thử: vai mới **Khách (chưa đăng nhập)** ở dải Bản xem thử; đăng ký xong là người mới (chưa project).
5. Ảnh chụp: script `demo/landing-shots.mjs` chụp lại từ bản xem thử (sáng, tối, tiếng Việt, tiếng Anh), xuất WebP.
6. Cổng Playwright: thêm `landing`, `login`, `register` của vai Khách vào năm lượt (axe WCAG 2.2 AA đầy đủ).

## 6. Việc sau khi duyệt (chưa làm trong bản mẫu)

| Mã  | Việc                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| L1  | Dựng sẵn (prerender) `/` thành HTML tĩnh lúc build, thêm `meta description`, Open Graph: SPA không tốt cho tìm kiếm |
| L2  | Trang Điều khoản và Quyền riêng tư, rồi dòng đồng ý dưới nút Đăng ký                                                |
| L3  | Quên mật khẩu (cần API ở Service 1 và gửi email)                                                                    |
| L4  | Đăng nhập bằng GitHub (developer quen dùng nhất), khi backend có OAuth                                              |
| L5  | `/llms.txt` và bản Markdown của trang cho agent đọc (Vercel, Supabase, Clerk đều có)                                |
| L6  | Nhật ký thay đổi có ngày trên trang chủ, khi có bản phát hành công khai                                             |

## 7. Kết quả bản mẫu (01/10/2026)

**Đã dựng:** `/` là trang giới thiệu cho khách (chunk lười: 26 KB JS + 11 KB CSS, người dùng app không tải); đăng nhập
và đăng ký làm lại; vai **Khách chưa đăng nhập** ở dải Bản xem thử, mở thẳng bằng `?as=visitor#/`; 16 ảnh WebP chụp
thật (`demo:shots`, 1,6 MB cả bốn bản, mỗi lượt xem chỉ tải bản đang hiện).

**Công cụ đã dùng và đóng góp:**

| Công cụ                     | Đóng góp                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent ux-researcher         | Soi 15 trang (Linear, Vercel, Supabase, Stripe, Clerk, LaunchDarkly, Statsig, Unleash, GitHub…): ảnh thật làm hero, một màu nhấn, "không cần thẻ", "chưa hợp với bạn nếu", panel bên chỉ ở trang đăng ký, luôn có đường về trang chủ |
| Skill design-taste-frontend | Đọc yêu cầu và ba núm (6/5/4), cấm div giả giao diện, cấm số liệu bịa, tiêu đề ≤ 2 dòng                                                                                                                                              |
| Skill hallmark              | Macrostructure Workbench, nav N1b, footer Ft1, luật trung thực (gate 46, 47), tự chấm P4 H4 E4 S5 R4 V4                                                                                                                              |
| Skill ui-ux-pro-max         | Khung Hero + tính năng + CTA, danh sách kiểm trước khi giao (tương phản, focus, giảm chuyển động, 375–1440px). Bộ màu và glassmorphism nó gợi ý KHÔNG dùng: trái DESIGN.md đã duyệt                                                  |

**Cổng đã chạy:** tsc (app, demo), eslint, Vitest 336/336 (thêm 9 ô `landing.test.tsx`: bảng công cụ khớp catalog
golden, trần an toàn khớp `DEFAULT_RESOURCE_QUOTA`, `/` theo trạng thái đăng nhập, đổi ngôn ngữ, tab mã SDK, logo về
trang chủ, nút hiện mật khẩu, panel bên), hợp đồng bản xem thử 17/17, Playwright: ba màn của khách đạt ở cả năm lượt
(axe WCAG 2.2 AA đầy đủ), lượt "mọi màn" ở máy tính vẫn đạt. Luật "chỉ token màu" mở rộng sang `landing.css`.

**Còn biết:** ảnh rollout bản tiếng Anh còn câu lý do tiếng Việt "Không vượt ngưỡng": đó là chữ Service 3 trả về, sửa
bằng mã lý do (UX-23, mục H3 của Plan #58), rồi chạy lại `demo:shots`. Bản build của bản xem thử (một tệp JS cố ý) vượt
ngưỡng cảnh báo 1.200 KB từ trước (phần trang mới chỉ khoảng 30 KB).

> **Đã làm (01/10/2026, Plan #60):** L1–L6 — `docs/plans/plan60-hoan-thien.md`, quyết định D-P52, D-P53. Luật "không
> nút cho thứ chưa có" (§4) giữ nguyên ở dạng mới: link Quên mật khẩu và nút GitHub chỉ hiện khi máy chủ đã cấu hình
> tính năng đó (`GET /auth/options`). Ảnh rollout bản tiếng Anh đã chụp lại với lý do theo ngôn ngữ.
