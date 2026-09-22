# UDP Portal: design system

Bản mẫu đã duyệt ngày 22/09/2026 nằm ở [`portal-prototype.html`](portal-prototype.html). Mở trực tiếp
bằng trình duyệt là bấm thử được, không cần build. Đây là **chuẩn** cho Plan #25 (Portal dùng React,
Tailwind và shadcn/ui theo §10 của thiết kế). Khi code Portal, mọi màu, chữ, khoảng cách và mẫu tương tác
lấy từ đây. Nếu cần lệch khỏi chuẩn thì sửa file này trước.

## 1. Tinh thần

- **Tham chiếu:**
  - khung ứng dụng theo Linear;
  - biểu đồ và danh sách theo Stripe;
  - bộ chọn môi trường theo Railway, LaunchDarkly và Vercel.
- **Kiềm chế:**
  - gần như toàn bộ là trắng và xám;
  - chỉ có một màu thương hiệu là xanh dương;
  - màu chỉ dùng để chỉ ra điều cần chú ý: đang rollout, cảnh báo, lỗi.
- **Chữ nhỏ và sắc:** chữ giao diện 13px, số liệu đậm, căn chỉnh chính xác.
- **Bàn phím là hạng nhất:** Ctrl K, phím tắt, xem nhanh.

## 2. Màu (OKLCH)

| Token                       | Sáng                                    | Tối                     | Dùng cho                                                     |
| --------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `--bg`                      | `oklch(96.6% .003 275)`                 | `oklch(16.5% .004 275)` | Nền ngoài cùng, thanh bên                                    |
| `--panel`                   | `oklch(99.7% .001 275)`                 | `oklch(19.5% .005 275)` | Tấm nội dung chính                                           |
| `--raised`                  | `oklch(100% 0 0)`                       | `oklch(22.5% .006 275)` | Thẻ, nút, popover                                            |
| `--sunk`                    | `oklch(97.4% .003 275)`                 | `oklch(18% .005 275)`   | Nền nhóm, ô code                                             |
| `--hover` / `--active`      | `96%` / `94.2%`                         | `23%` / `26%`           | Rê chuột / đang chọn                                         |
| `--line` / `--line-2`       | `92.6%` / `88.5%`                       | `26.5%` / `32%`         | Viền 1px, viền input                                         |
| `--ink` … `--ink-4`         | `21%` `44%` `60%` `72%`                 | `95%` `76%` `60%` `46%` | Chữ chính → phụ → mờ → rất mờ                                |
| `--accent`                  | `oklch(54% .2 262)`                     | `oklch(66% .17 258)`    | Màu thương hiệu: nút chính, mục đang chọn, rollout đang chạy |
| `--accent-soft`             | `oklch(95.6% .028 262)`                 | `oklch(28% .07 260)`    | Nền mục menu đang chọn                                       |
| `--green` `--amber` `--red` | `60% .14 152` `72% .15 72` `58% .19 25` | sáng hơn ~12%           | Chỉ cho trạng thái: ổn định, tạm dừng/cảnh báo, lỗi/rollback |

Màu hex tương đương của `--accent` (dùng cho favicon, ảnh): `#2B5BE0`.

**Không** dùng gradient trang trí, nền màu loang, màu kẹo nhiều sắc, hoặc màu để trang trí.

## 3. Chữ

- **Font:**
  - **Geist** (400/500/600/700) cho mọi chữ giao diện;
  - **Geist Mono** (400/500) cho key flag, phiên bản, commit, code.
  - Cả hai đều có đủ bộ chữ tiếng Việt trên Google Fonts.
- **Thang chữ:**
  - 13px cho chữ giao diện, 12px cho chữ phụ, 11.5px cho nhãn nhóm;
  - 15px cho tiêu đề hộp thoại;
  - 22px cho tiêu đề phân hệ, 24–28px cho con số chỉ số.
- **Độ đậm:** tiêu đề 650, nhãn 500. Không dùng 800/900, không chữ nghiêng ở tiêu đề.
- **Khoảng chữ:** tiêu đề khít `-.02em` đến `-.025em`.
- **Con số:** mọi con số trong bảng hoặc thẻ dùng `font-variant-numeric: tabular-nums`.

## 4. Khung và khoảng cách

- **Khung chính:** thanh bên 232px nằm trên `--bg`. Nội dung đặt trong một tấm `--panel` bo 10px, cách mép
  8px, viền `--shadow-panel`.
- **Thanh đầu trang (46px):**
  - bộ chọn môi trường;
  - dấu `/`;
  - breadcrumb;
  - nút hành động nằm bên phải.
- **Đầu phân hệ:**
  - ô icon 40px màu `--accent` đặc, icon trắng;
  - tiêu đề 22px và một câu mô tả;
  - ba chỉ số nhanh ở góc phải.
- **Bo góc:** 6px cho nút và input, 7px cho mục menu, 8–10px cho thẻ, 12px cho hộp thoại và bảng lệnh.
- **Khoảng cách:** dòng danh sách cao 44px, trang đệm 26–28px.

## 5. Icon và trạng thái

- **Bộ icon:** chỉ dùng **Lucide** (giấy phép ISC), lưới 24px, nét 1.75 ở cỡ 16px. Không tự vẽ icon, không
  trộn bộ icon khác. Icon phải nằm giữa ô chứa. Kiểm bằng số đo, không kiểm bằng mắt: một lần icon bị lệch
  vì trùng tên class CSS.
- **Icon menu:** nằm trong ô 22px viền mảnh. Mục đang chọn có ô `--accent` đặc, icon trắng.
- **Icon theo phân hệ:**

  | Phân hệ   | Icon Lucide                       |
  | --------- | --------------------------------- |
  | Tổng quan | `layout-dashboard`                |
  | Flag      | `flag`                            |
  | Rollout   | `chart-no-axes-column-increasing` |
  | Deploy    | `rocket`                          |
  | Cài đặt   | `settings-2`                      |

- **Vòng tiến độ** (flag và rollout): rãnh xám `--line-2` cộng một cung dài đúng bằng %, nét 1.6, đầu tròn.
  Cung màu `--accent` nếu đang rollout, `--ink-3` nếu flag đang dùng bình thường. Flag nháp là vòng nét đứt.
- **Trạng thái kết thúc** dùng icon Lucide trong vòng tròn:

  | Trạng thái  | Icon           | Màu     |
  | ----------- | -------------- | ------- |
  | Tạm dừng    | `circle-pause` | cam     |
  | Hoàn tất    | `circle-check` | xanh lá |
  | Đã rollback | `circle-x`     | đỏ      |

- **Trạng thái hạ tầng hoặc deploy:** chữ ("Ổn định", "Cần xem") kèm `circle-check` hoặc `circle-alert`.
  **Không dùng chấm màu.**
- **Môi trường:**
  - chỉ là **chữ**, không icon, không chấm màu;
  - production có thêm `lock` màu xám vì mọi thay đổi ở đây cần xác nhận.

## 6. Thành phần

| Thành phần         | Quy tắc                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nút chính          | Nền `--accent`, chữ trắng, cao 28px, có thể kèm `kbd` phím tắt                                                                                                            |
| Nút phụ            | Nền `--raised`, viền `--line-2`. Nút nguy hiểm là chữ đỏ, bản đặc đỏ chỉ trong hộp thoại xác nhận                                                                         |
| Bộ chọn môi trường | Nút gọn trên thanh đầu trang: tên + khoá (production) + `chevrons-up-down`. Mở hộp có ô tìm, mỗi dòng gồm tên, mô tả ngắn, phiên bản cấu hình, dấu tích                   |
| Danh sách          | Nhóm theo trạng thái (tiêu đề nhóm `--sunk`, dính khi cuộn). Dòng 44px gồm vòng tiến độ, tên, key mono, ba vạch dev/staging/production, đường xu hướng, thời gian, avatar |
| Xem nhanh          | Bấm một dòng thì panel chi tiết trượt ra bên phải, rộng 520px, không chuyển trang. Esc để đóng                                                                            |
| Rule               | Thẻ viền mảnh: số thứ tự, tên sửa tại chỗ, hàng "Nếu" và hàng "Thì". Chia tỉ lệ gồm thanh xếp chồng, thanh trượt từng variant và dòng tổng (đỏ nếu khác 100%)             |
| Thanh lưu          | Nổi ở đáy panel khi có thay đổi: "N thay đổi ở {env}", nút Bỏ, nút Lưu (Ctrl S)                                                                                           |
| Biểu đồ            | Vùng mượt tô gradient nhạt `--accent`, đường ổn định nét đứt xám, ngưỡng nét đứt đỏ. Rê chuột hiện đường dọc, điểm và tooltip số canary so với ổn định                    |
| Bảng lệnh Ctrl K   | Tìm flag, rollout và lệnh (tạo flag, đổi môi trường, sáng/tối). Mũi tên để chọn, Enter để chạy                                                                            |
| Thông báo          | Viên thuốc tối ở giữa đáy màn hình. Thao tác đảo ngược được thì có nút "Hoàn tác" (5 giây)                                                                                |
| Hộp thoại xác nhận | Chỉ cho việc nặng: rollback, lên 100%, bật/tắt ở production                                                                                                               |

## 7. Tương tác

- **Phím tắt:**

  | Phím        | Việc                           |
  | ----------- | ------------------------------ |
  | Ctrl K      | Mở bảng lệnh                   |
  | `1` `2` `3` | Đổi môi trường                 |
  | `j` / `k`   | Lên xuống trong danh sách flag |
  | `c`         | Tạo flag                       |
  | Ctrl S      | Lưu                            |
  | Esc         | Đóng                           |

- **Hoàn tác thay vì hỏi lại** cho thao tác đảo ngược được: lưu, xoá rule, tạm dừng, kích hoạt.
- **Chuyển động:** ngắn (120–220 ms), `cubic-bezier(.2,.8,.2,1)`. Tôn trọng `prefers-reduced-motion`.
- **Chế độ tối:** có đủ bộ token tối. Chỉ đổi độ sáng, giữ nguyên sắc độ.

## 8. Logo

Logo "Công tắc": một viên thuốc viền trắng có núm tròn bên phải, đặt trong ô `--accent` bo 22%. Chữ `udp`
viết thường, đậm 600–700. Favicon dùng cùng hình trên nền `#2B5BE0`.

## 9. Không làm (rút từ các vòng duyệt)

- Gradient nhiều màu, ô icon cầu vồng, nền màu loang, chữ phồng 900, lưới thẻ lặp giống nhau, số liệu đặt ra
  cho đẹp. Đây là kiểu "SaaS do AI dựng".
- Ẩn dụ lạ và nặng trang trí (bàn trộn, cờ hiệu, giấy in nhiệt).
- Icon hình minh hoạ cho khái niệm trừu tượng (cửa sổ lệnh, bình thí nghiệm, quả địa cầu cho môi trường).
- Chấm màu, vòng tô đặc nét dày, ô icon màu cạnh tiêu đề mục.
- Em-dash trong chữ giao diện. Dùng "-" hoặc viết lại câu.
- Bất kỳ yếu tố nào của tổ chức bên ngoài: tên, logo, tài khoản. UDP là sản phẩm riêng.
