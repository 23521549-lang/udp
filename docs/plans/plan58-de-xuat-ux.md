# Plan #58 — Đề xuất tối ưu UX hai portal (CHỜ DUYỆT, chưa sửa mã)

Người dùng (30/09/2026): "tôi muốn bạn sử dụng các skill, các plugin của mình để tối ưu UX của hai portal để nó dễ
dùng và dễ hiểu … bạn đề xuất trước cho tôi xem nhá, nhớ tự review trước khi đề xuất … tham khảo thêm kiến thức từ
nhiều nguồn uy tín trên mạng". Bối cảnh: UDP sẽ thành sản phẩm thương mại, bản đầu **miễn phí, tự phục vụ** —
người mới phải tự hiểu và tự làm được, không có ai hướng dẫn.

## 0. Cách làm và công cụ đã dùng

Đánh giá trên 42 màn × 5 lượt chụp (sáng, di động, tối, tối di động, tiếng Anh) của bản xem thử, đối chiếu từng điều
với mã nguồn. Mức nghiêm trọng theo thang 0–4 của NN/g; nguyên tắc theo 10 heuristic của Nielsen.

| Công cụ                          | Đóng góp                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `superpowers:brainstorming`      | Quy trình: khảo sát → đề xuất → duyệt; chưa đụng mã trước khi duyệt                                                                                                                                                                              |
| `ui-ux-pro-max`                  | Nguyên tắc tra được: trạng thái trống có hành động, lỗi có lối sửa, chỉ báo bước cho quy trình nhiều bước, xác nhận việc phá huỷ; KPI có ngưỡng nên là biểu đồ bullet                                                                            |
| `web-design-guidelines` (Vercel) | Rà cơ chế giao diện: đạt phần lớn (link bỏ qua, focus-visible có thay thế, màu thanh địa chỉ theo giao diện, không `transition: all`); lỗi nhỏ: ~22 ô nhập thiếu `autocomplete`                                                                  |
| `redesign-existing-projects`     | Phát hiện: gần như KHÔNG có trợ giúp trong sản phẩm (1 chuỗi chữ nhắc tài liệu), 142 chỗ giải thích bằng `title=` chỉ hiện khi rê chuột, chưa có link pháp lý. Các gợi ý thẩm mỹ (đổi font, hạt nhiễu, bỏ Lucide) bị loại — xung đột `DESIGN.md` |
| `dataviz` (chạy bộ kiểm màu)     | Giao diện tối: màu dữ liệu v3/v4 lệch ΔE 3,8 với người mù màu đỏ–lục (dưới ngưỡng 6) — không phân biệt được chuỗi. Giao diện sáng: v3 chỉ 2,49:1 trên nền trắng                                                                                  |
| Agent `ux-researcher`            | Nguồn uy tín đã mở và đối chiếu (NN/g, W3C WCAG 2.2, GOV.UK, Carbon, Primer, Atlassian, Baymard, LaunchDarkly, Unleash, Flagsmith, Vercel, Argo CD, Grafana); 12 khuyến nghị                                                                     |
| Agent `accessibility-tester`     | 15 lỗ hổng WCAG 2.2 AA mà cổng kiểm tự động chưa bắt                                                                                                                                                                                             |
| 2 agent đánh giá heuristic       | Portal nhà phát triển: 25 phát hiện (8 nặng); Bảng điều khiển: 16 phát hiện (3 nặng) — mỗi phát hiện có ảnh và dòng mã làm chứng                                                                                                                 |

## 1. Kết luận ngắn

Phần kỹ thuật của giao diện đã tốt (trạng thái bằng biểu tượng + chữ, tải/lỗi riêng từng nguồn, hoàn tác thay xác
nhận, bảo vệ production, hai ngôn ngữ, giao diện tối). Chỗ yếu nằm ở **luồng và nội dung**: người mới không được dẫn
đường, thuật ngữ không được giải thích, vài trạng thái nói sai, và Bảng điều khiển không đẩy việc gấp lên đầu. Có vài
lỗi hiển thị thật (một trang vỡ dòng, danh sách flag trên điện thoại mất trạng thái).

## 2. Đề xuất theo đợt

Mức: **3** nặng · **2** vừa · **1** nhẹ. Công sức: **S** nhỏ · **M** vừa · **L** lớn. Mã nguồn nêu ở cột "Chứng" đã
được kiểm; mã `D-Fn` là phát hiện của Portal nhà phát triển, `A-Fn` của Bảng điều khiển, `a11y-n` của rà trợ năng.

### Đợt 1 — Sửa hiển thị và trạng thái nói sai (không cần bản mẫu)

| #     | Người dùng gặp gì                                                                                                                                                        | Đề xuất                                                                        | Mức | Công | Chứng / nguồn                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --- | ---- | ----------------------------------------------------- |
| UX-1  | Trang **Dọn dẹp flag** hiện mọi hàng dính thành một đoạn văn — gần như không dùng được                                                                                   | Thêm kiểu hàng cho `label.it` trong danh sách                                  | 3   | S    | D-F7; `CleanupPage.tsx`, ảnh `flags-cleanup.png`      |
| UX-2  | Trên điện thoại, danh sách flag **mất chữ Bật/Tắt**, dòng "5 ngày trước" trôi xuống như thuộc hàng sau; Tổng quan bị cắt mép phải                                        | Giữ chữ Bật/Tắt, ẩn cột phụ; sửa lưới `minmax(0,1fr)`                          | 3   | S    | D-F8, a11y-7; `prototype.css`, ảnh `mobile/flags.png` |
| UX-3  | Danh sách **job lỗi** (Bảng điều khiển) bị căn giữa, khó dò                                                                                                              | Sửa bộ chọn CSS (`.lst > li.it` đang đè `.job-it`)                             | 2   | S    | A-F5; `portal.css`                                    |
| UX-4  | Flag **nháp** hiện "Bật" dù SDK chưa thấy nó                                                                                                                             | Hiện "Nháp, chưa phục vụ"; trong panel có dải báo kèm nút Kích hoạt            | 3   | S    | D-F4; `FlagsPage.tsx` lấy chữ từ `isEnabled`          |
| UX-5  | Project ghi **"Ổn định"** trong khi domain của nó đang lỗi                                                                                                               | Đổi thành "Đang hoạt động"; thêm huy hiệu sức khoẻ riêng ("3 việc cần xử lý")  | 3   | S    | D-F5; nguồn: Argo CD tách "đồng bộ" và "sức khoẻ"     |
| UX-6  | Dải quyết định của rollout **luôn màu cam cảnh báo**, kể cả khi mọi thứ trong ngưỡng; "đủ thời gian sau 0 giây"                                                          | Màu và biểu tượng theo đúng quyết định; 0 giây thì "Có thể lên bậc tiếp"       | 2   | S    | D-F11                                                 |
| UX-7  | **Mã kỹ thuật thay tên**: "Domain GITOPS lệch cấu hình", tiêu đề trang "MONITORING", "AZURE", "BYOC"                                                                     | Một hàm tên hiển thị dùng chung                                                | 2   | S    | D-F9, A-F9                                            |
| UX-8  | **Một trạng thái nhiều tên, một tên nhiều nghĩa**: drift có 3 tên; "Đang chạy" vừa là domain khoẻ vừa là rollout; "Cần xem" lúc đỏ lúc cam; "Không rảnh" là phủ định kép | Một bảng từ cho mỗi khái niệm (mở rộng bảng thuật ngữ Plan #54)                | 2   | S    | D-F10, A-F11; NN/g heuristic 4                        |
| UX-9  | Toast "Rollout **716f9487** đã kết thúc. Mở trang Rollout…" — mã thô, không có link, tự mất sau 5 giây, che nội dung                                                     | Dùng tên; nút "Xem"; toast có hành động không tự tắt; không che vùng đang dùng | 2   | S    | D-F22, a11y-6; WCAG 2.2.1                             |
| UX-10 | Biểu đồ ở **giao diện tối**: hai màu dữ liệu không phân biệt được với người mù màu                                                                                       | Chỉnh token tối của v3/v4 tới khi bộ kiểm `dataviz` đạt                        | 2   | S    | Bộ kiểm `validate_palette.js`: ΔE 3,8 < 6             |

### Đợt 2 — Lần đầu dùng, cho bản free (cần bản mẫu duyệt trước)

| #     | Người dùng gặp gì                                                                                                                  | Đề xuất                                                                                                                                           | Mức | Công | Chứng / nguồn                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | ---------------------------------------------- |
| UX-11 | Người mới thấy "Chào X", ba số 0 và "**Bạn chưa tham gia project nào**" (nghe như phải chờ được mời); không câu nào nói UDP làm gì | Ẩn số khi toàn 0; một câu giới thiệu + 3 bước: tạo project → flag chạy ngay, chưa cần cloud → kết nối cloud sau                                   | 3   | S    | D-F1; Carbon, Primer, NN/g về trạng thái trống |
| UX-12 | Tạo project xong chỉ gặp ngõ cụt ("Chưa có cluster", "Chưa có lần deploy nào")                                                     | Thẻ **"Bắt đầu"**: danh sách việc tự đánh dấu (SDK key, flag đầu tiên, kết nối cloud, chọn domain, deploy đầu tiên), làm thứ tự nào cũng được     | 3   | M    | D-F2; GOV.UK task list, hiệu ứng goal-gradient |
| UX-13 | Không nơi nào nói **cài SDK thế nào**: đoạn mã giả định đã có `client`, hộp "Key đã tạo" chỉ có key                                | Ngay sau khi tạo key: 3 dòng cài gói → khởi tạo với key và địa chỉ → gọi flag, cho Node và Python                                                 | 3   | S–M  | D-F3                                           |
| UX-14 | Bước **chọn domain** là 16 công tắc chỉ có tên; "domain" trong tiếng Việt thường hiểu là tên miền                                  | Mỗi domain một câu giải thích; câu "Domain là một loại công cụ hạ tầng, không phải tên miền"; gói **"Khuyến nghị cho người mới"**; nhóm theo việc | 3   | M    | D-F6; luật Hick, NN/g về menu                  |
| UX-15 | Wizard chỉ ghi "Bước 2/5" ở breadcrumb, không có Quay lại; ở bước xem trước, nút Bắt đầu bị đẩy dưới 16 tên tài nguyên thô         | Thanh 5 bước có Quay lại; nút bước 1 "Tạo và tiếp tục"; danh sách tài nguyên gọn vào "Xem chi tiết"                                               | 2   | S–M  | D-F14; NN/g về wizard                          |
| UX-16 | Bước cloud: vùng phải **gõ tay**; hướng dẫn quyền là JSON thô; lựa chọn "Tài khoản của UDP" bị khoá vẫn hiện                       | Vùng chọn từ danh sách; hướng dẫn thành các bước đánh số có link tới console; ẩn lựa chọn đang tắt                                                | 2   | M    | D-F15                                          |
| UX-17 | Trạng thái trống chỉ có một tiêu đề (Rollout, Segment, SDK key, Kiến trúc; lọc ra rỗng ở Bảng điều khiển)                          | Mỗi trạng thái trống: vì sao trống + điều kiện cần + một nút; bộ lọc rỗng có "Xoá bộ lọc"                                                         | 2   | S    | D-F16, A-F13; Carbon empty states              |
| UX-18 | _(tuỳ chọn, cần bạn quyết)_ Người mới chưa thấy sản phẩm đầy đủ khi chưa có cloud                                                  | Đặt bản xem thử (đã có, dữ liệu mẫu) thành trang "Xem thử không cần đăng ký" trên cùng máy chủ — tệp tĩnh, **0 đồng**                             | 1   | S    | Nguồn: bản demo dùng chung của Unleash         |

### Đợt 3 — Giải thích khái niệm và trợ giúp

| #     | Người dùng gặp gì                                                                                                                                             | Đề xuất                                                                                                                                    | Mức | Công | Chứng / nguồn                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --- | ---- | ------------------------------------------------ |
| UX-19 | Thuật ngữ không được giải thích (canary, baseline, drift, segment, OFREP, BYOC, workload, capability…); 142 chỗ giải thích bằng tooltip chỉ hiện khi rê chuột | Thành phần "giải thích" **bấm được** (dùng được bàn phím và điện thoại); chữ thường trước, thuật ngữ trong ngoặc: "Phát hành dần (canary)" | 3   | M    | D-F13; NN/g về thuật ngữ và tooltip              |
| UX-20 | Một khái niệm nhiều tên: "baseline", "đối chứng", "Mốc rollback"                                                                                              | Bảng thuật ngữ vi/en một khái niệm một từ, cho cả hai portal                                                                               | 2   | S    | D-F13; W3C i18n, Fluent content                  |
| UX-21 | Không có trợ giúp nào trong sản phẩm                                                                                                                          | Nút **"Trợ giúp"** ở cùng một chỗ trên mọi trang: bảng thuật ngữ + hướng dẫn nhanh                                                         | 2   | M    | WCAG 3.2.6, NN/g về trợ giúp                     |
| UX-22 | Chữ lộ chi tiết nội bộ: "(§4.4)", "(DNS-1123)", "Không khai UDP_RELEASE", "ServiceAccount của Service 1", lịch "30 19 * * *", "teardown"                      | Viết lại bằng lời thường: "Hằng ngày 02:30 (giờ VN)"; lý do = nguyên nhân + việc cần làm                                                   | 2   | S    | D-F21, A-F10                                     |
| UX-23 | Bản tiếng Anh hiện câu tiếng Việt: lý do quyết định rollout do Service 3 viết sẵn (còn có dấu gạch dài), lỗi kiểm ô ở trang đăng ký                           | Máy chủ trả **mã + số**, Portal viết câu theo ngôn ngữ (đúng quy tắc của thiết kế)                                                         | 2   | M    | D-F12; `decision.ts`                             |
| UX-24 | Lỗi chưa nói cách sửa; tiếng Anh chỗ còn lạ ("Burning", "Machine running UDP"); lời chào tiếng Anh dùng họ                                                    | Lỗi = nguyên nhân + cách sửa + link; sửa chữ tiếng Anh; chào bằng tên riêng                                                                | 1   | S    | A-F16, D-F23; GOV.UK, Atlassian về thông báo lỗi |

### Đợt 4 — Điều hướng và đưa việc cần làm lên trước

| #     | Người dùng gặp gì                                                                                                                                     | Đề xuất                                                                                                                                                                                                                   | Mức | Công | Chứng / nguồn                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | -------------------------------- |
| UX-25 | Menu project **11 mục phẳng**, việc thiết lập nằm dưới cùng                                                                                           | Nhóm: **Phát hành** (Flag, Segment, Rollout, Deploy) · **Hạ tầng** (Kiến trúc, Giám sát, Domain, Hạ tầng, Mã nguồn) · Cài đặt                                                                                             | 2   | S    | D-F18; NN/g về menu              |
| UX-26 | Menu Bảng điều khiển **10 mục phẳng**, việc gấp đứng thứ 5–6; "Hệ thống" lặp Tổng quan; trang Bằng chứng dùng icon bình thí nghiệm mà `DESIGN.md` cấm | Nhóm **Vận hành** (Tổng quan, Job lỗi, Tài nguyên mồ côi, Kiến trúc nền tảng — có huy hiệu số) · **Khách hàng** (Người dùng, Project, Credential) · **Tham chiếu** (Catalog domain, Bằng chứng); gộp "Hệ thống"; đổi icon | 2   | S    | A-F6, A-F14                      |
| UX-27 | Tổng quan Bảng điều khiển: màn đầu toàn thẻ xanh, **việc gấp nằm dưới nếp gấp** (8 job lỗi, 3 chưa dọn xong, 6 tài nguyên mồ côi đang tốn tiền)       | Mở đầu bằng dải **"Cần xử lý"**, mỗi dòng dẫn tới chỗ sửa; thẻ xanh gọn lại; hết việc thì "Mọi thứ ổn"                                                                                                                    | 3   | M    | A-F1; NN/g về dashboard vận hành |
| UX-28 | Nút "Mọi job lỗi" mở tab chỉ có 5/8 job; 3 job **đang tốn tiền** nằm ở tab phụ                                                                        | Số trên từng tab; tab "Dọn chưa hết" đứng đầu khi > 0; nút mở đúng tab                                                                                                                                                    | 2   | S    | A-F4                             |
| UX-29 | Việc chính khó với tới: muốn rollout một flag phải sang trang Rollout tìm lại; mời thành viên chỉ trong Cài đặt; tên workload phải gõ tay             | Nút "Phát hành dần" ngay trong trang flag; số thành viên là link mời; lệnh Ctrl K "Mời", "Tạo SDK key"; chọn workload từ danh sách                                                                                        | 2   | S–M  | D-F17                            |
| UX-30 | Ctrl K chỉ có ở Portal nhà phát triển                                                                                                                 | Ctrl K cho Bảng điều khiển: tới trang, tìm người dùng theo email                                                                                                                                                          | 1   | M    | A-F15; GitHub command palette    |
| UX-31 | **42 màn cùng một tiêu đề** "UDP Portal" trên thẻ trình duyệt và trong lịch sử                                                                        | Tiêu đề theo màn: "Flag · checkout-service · UDP"                                                                                                                                                                         | 3   | S    | a11y-4; WCAG 2.4.2 (mức A)       |

### Đợt 5 — Bảng và việc của người quản trị

| #     | Người dùng gặp gì                                                                                                           | Đề xuất                                                                                                                | Mức | Công | Chứng / nguồn                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --- | ---- | ---------------------------------------- |
| UX-32 | Mọi danh sách của Bảng điều khiển là **ngõ cụt**: không mở được project, job, người dùng                                    | Tên project/job mở panel chỉ-đọc: trạng thái, chủ, job cuối và lỗi, tài nguyên mồ côi                                  | 3   | L    | A-F2                                     |
| UX-33 | Trang **tài nguyên mồ côi** cho thấy tiền đang mất nhưng không có việc gì làm được                                          | Cột chủ sở hữu và "từ khi nào"; sắp theo chi phí; nút chép ID; link tới console cloud (sau: "Thử dọn lại" có xác nhận) | 3   | M    | A-F3                                     |
| UX-34 | Bảng không sắp xếp được; không lọc được danh sách admin; không tìm project; trên điện thoại cột chi phí/trạng thái bị khuất | Sắp xếp cột; lọc vai trò; tìm theo tên/chủ; cột quan trọng đứng cạnh tên trên điện thoại                               | 2   | M    | A-F7, A-F8; NN/g, Carbon về bảng dữ liệu |
| UX-35 | Nhật ký audit chỉ có mã hành động (`flag.rules.replace`) và tên model nội bộ; lọc bằng cách gõ mã                           | Hiện ai làm + câu dễ đọc + đối tượng; lọc bằng danh sách nhóm hành động                                                | 2   | M    | D-F19; LaunchDarkly change history       |
| UX-36 | Đổi vai: 130 hàng mỗi hàng một nút; "Hạ quyền" không có dáng nguy hiểm; thông báo "Đã đổi vai" không nói ai                 | Nhãn nút và thông báo nói rõ ai, vai gì; "Hạ quyền" kiểu nguy hiểm; đánh dấu "(bạn)"                                   | 1   | S    | A-F12; NN/g về hộp xác nhận              |

### Đợt 6 — Trợ năng (làm song song các đợt)

| #     | Người dùng gặp gì                                                                                                                                                        | Đề xuất                                                                                                     | Mức | Công | Chứng / nguồn                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --- | ---- | ----------------------------------------------------------- |
| UX-37 | Đang gõ ở ô thứ 7 của hộp **tạo rollout (13 ô)** thì con trỏ bị kéo về ô đầu mỗi lần danh sách tự làm mới (15 giây) — ảnh hưởng MỌI người, không chỉ người dùng bàn phím | Giữ `onClose` trong ref, effect chạy một lần; hộp thoại nguy hiểm focus vào "Huỷ"; đọc được mô tả hộp thoại | 3   | S    | a11y-1, a11y-9, a11y-10; `Dialog.tsx` phụ thuộc `[onClose]` |
| UX-38 | Menu điện thoại và panel bên (≤ 860px) không giữ focus, Esc không đóng, đóng xong focus rơi mất                                                                          | Giữ focus bên trong, Esc để đóng, trả focus về chỗ cũ, có nút đóng                                          | 3   | M    | a11y-2, a11y-3; WCAG 2.4.3, 2.4.11                          |
| UX-39 | Lỗi của form không gắn với ô, trình đọc màn hình không đọc; không focus ô sai                                                                                            | Một thành phần `Field` dùng chung (đã có mẫu tốt ở trang đăng nhập)                                         | 3   | M    | a11y-8; WCAG 3.3.1                                          |
| UX-40 | Phím tắt một phím (`c`, `j`, `k`, `1`–`9` đổi environment kể cả production) không tắt được; tab không đúng chuẩn; thanh Lưu che ô; thứ bậc tiêu đề                       | Bật/tắt phím tắt trong menu tài khoản; một thành phần Tabs chuẩn; chừa chỗ dưới thanh Lưu; sửa tiêu đề      | 2   | M    | a11y-5, 11, 12, 15; WCAG 2.1.4                              |
| UX-41 | Cổng kiểm tự động chỉ bật **một** luật axe (tương phản)                                                                                                                  | Bật đủ bộ luật WCAG 2.2 AA trong cổng Playwright                                                            | 2   | S    | `screens.pw.ts` dòng 211                                    |

## 3. Giữ nguyên — không để thoái cấp

Trạng thái bằng biểu tượng + chữ ở mọi nơi; mỗi nguồn dữ liệu tải và báo lỗi riêng; "Việc cần xử lý" ở trang chủ dẫn
thẳng tới chỗ sửa; hoàn tác thay vì hỏi xác nhận cho việc đảo ngược được; production có khoá, gõ tên để áp, xác nhận
đúng số tiền; kiểm cấu hình domain tức thì kèm nút "bật công cụ gợi ý"; hộp tạo flag định dạng key khi gõ và hiện câu
gọi SDK; bộ lọc và trang nằm trên URL; tiền chưa rõ giá ghi "Chưa rõ giá" chứ không ghi 0; đổi vai phải gõ email và máy
chủ không cho gỡ admin cuối cùng; Ctrl K, `C`, `j`/`k` ở Portal; hai ngôn ngữ và giao diện tối đồng đều.

## 4. Không đề xuất, và vì sao

| Gợi ý                                                                | Vì sao không                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Đổi font, thêm hạt nhiễu/kính mờ, bỏ bộ icon Lucide (skill redesign) | Xung đột `DESIGN.md` (Lucide là bộ icon bắt buộc, có design-lint canh; Geist đã là font của hệ thống)      |
| Tour hướng dẫn bắt buộc khi mới vào                                  | NN/g: tutorial không cải thiện hiệu quả; trợ giúp đúng chỗ (UX-11..UX-19) tốt hơn                          |
| Chọn nhiều và thao tác hàng loạt ở Bảng điều khiển                   | Quy mô hiện tại (vài chục job, vài tài nguyên mồ côi) chưa cần; để khi có người dùng thật                  |
| Card sort và tree test để kiểm cách nhóm menu                        | Cần ≥ 15 người thật; làm khi bản free có người dùng (gắn với mục nợ `portal-dx`)                           |
| Quên mật khẩu (D-F20, mức 3)                                         | Cần phần máy chủ; đã nằm trong plan "sẵn sàng cho bản free" (việc 4 của danh sách trước) — không lặp ở đây |
| Góc "Hạ tầng & node"                                                 | Đã bàn: cần quyền đọc toàn cluster và tải cho máy free                                                     |

## 5. Tự kiểm tra trước khi đề xuất

- **Đã tự kiểm lại trên mã và ảnh** 11 khẳng định nặng nhất của các agent: trang Dọn dẹp flag vỡ dòng; flag nháp hiện
  "Bật"; ACTIVE ghi "Ổn định"; danh sách flag trên điện thoại; `Dialog` phụ thuộc `[onClose]`; không có
  `document.title`; axe chỉ bật một luật; CSS căn giữa danh sách job; nút "Mọi job lỗi" mở tab FAILED; `DESIGN.md` cấm
  icon bình thí nghiệm; lý do rollout viết sẵn tiếng Việt ở Service 3. Cả 11 đúng. Các phát hiện còn lại có dòng mã
  làm chứng do agent đánh giá kiểm; sẽ kiểm lại từng cái khi viết spec.
- **Đã bỏ hoặc sửa**: gợi ý thẩm mỹ của skill redesign (mục 4); gợi ý "thêm bước xem lại cuối wizard" của nguồn nghiên
  cứu — bước xem trước ĐÃ có (chỉ cần gọn lại, UX-15); gợi ý "giấu trang Bằng chứng sau cờ build" — giữ trang vì luận
  văn cần, chỉ dời nhóm và đổi icon (UX-26); "cột Dev/Staging/Prod trong danh sách flag" — chưa kiểm được trên mã nên
  không đưa vào.
- **Chi phí**: mọi đề xuất là Portal hoặc sửa nhỏ ở máy chủ; không thêm hạ tầng, không thêm dịch vụ tính tiền. UX-18
  là tệp tĩnh trên máy đang có.

## 6. Sau khi duyệt

1. Viết spec `plan58-spec.md` và kế hoạch theo đợt; mỗi đợt một commit có cổng (test, typecheck, lint, Playwright
   năm lượt — kể cả bộ luật axe đầy đủ từ UX-41).
2. Đợt có thiết kế mới (2, 4, và panel của đợt 5) **dựng bản mẫu chạy ở máy cho bạn xem trước**, duyệt rồi mới sửa mã.
   Đợt 1 và 6 là sửa lỗi, làm thẳng.
3. Thứ tự tôi đề xuất: **1 → 6 → 2 → 4 → 3 → 5**. Đợt 1 và 6 nhanh, sửa lỗi thật; đợt 2 là thứ bản free cần nhất.

## Phụ lục — nguồn chính (đã mở và đối chiếu ngày 30/09/2026)

- NN/g: 10 heuristic https://www.nngroup.com/articles/ten-usability-heuristics/ · thang mức nghiêm trọng
  https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/ · onboarding tutorial
  https://www.nngroup.com/articles/onboarding-tutorials/ · trạng thái trống
  https://www.nngroup.com/articles/empty-state-interface-design/ · wizard https://www.nngroup.com/articles/wizards/ ·
  thuật ngữ https://www.nngroup.com/articles/technical-jargon/ · tooltip
  https://www.nngroup.com/articles/tooltip-guidelines/ · menu https://www.nngroup.com/articles/menu-design/ · hộp xác
  nhận https://www.nngroup.com/articles/confirmation-dialog/ · bảng dữ liệu https://www.nngroup.com/articles/data-tables/
  · thông báo lỗi https://www.nngroup.com/articles/error-message-guidelines/
- W3C WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ · kích thước kích hoạt
  https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html · focus không bị che
  https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html · trợ giúp nhất quán
  https://www.w3.org/WAI/WCAG22/Understanding/consistent-help.html
- GOV.UK Design System: task list https://design-system.service.gov.uk/components/task-list/ · thông báo lỗi
  https://design-system.service.gov.uk/components/error-message/ · viết cho giao diện
  https://www.gov.uk/service-manual/design/writing-for-user-interfaces
- IBM Carbon: trạng thái trống https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states · chỉ báo
  trạng thái https://www.carbondesignsystem.com/building-blocks/core/patterns/status-indicators
- GitHub Primer: https://primer.style/product/ui-patterns/empty-states/ · Atlassian thông báo lỗi
  https://atlassian.design/foundations/content/designing-messages/error-messages · Laws of UX
  https://lawsofux.com/hicks-law/
- Sản phẩm cùng loại: LaunchDarkly environments https://launchdarkly.com/docs/home/account/environment · change history
  https://launchdarkly.com/docs/home/releases/change-history · Unleash demo
  https://docs.getunleash.io/guides/demo-walkthrough · Vercel rollback https://vercel.com/docs/instant-rollback · Argo
  CD https://argo-cd.readthedocs.io/en/stable/core_concepts/ · Grafana dashboard
  https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/

## 7. Bản mẫu chạy được (01/10/2026) — nhánh `ux58-prototype`, `main` không đổi

Người dùng: "dựng những đề xuất của bạn lên thành một web hoàn chỉnh trên local cho tôi xem đi, bơm dữ liệu nhiều
nhiều, phong phú, đầy đủ". Bản mẫu là CHÍNH Portal với các thay đổi, chạy trên bản xem thử (backend giả lập trong
trình duyệt), nên bấm được mọi màn, đủ hai ngôn ngữ và hai giao diện.

**Đã dựng:** UX-1 → UX-17, UX-19 → UX-22, UX-24 → UX-41. **Chưa dựng:** UX-18 (trang xem thử công khai, chờ quyết
định), UX-23 (lý do quyết định rollout do Service 3 trả mã + số — cần sửa máy chủ; bản mẫu vẫn hiện câu tiếng Việt
của máy chủ ở phần lý do).

**Cổng đã chạy:** typecheck (Portal + bản xem thử), eslint, prettier, 326 test Portal, contract của bản xem thử 17/17,
Playwright năm lượt (sáng, di động, tối, tối di động, tiếng Anh) cộng lượt "người mới" ở mỗi cỡ, với ĐỦ bộ luật axe
WCAG 2.2 AA (UX-41; trước chỉ có luật tương phản — bật đủ làm lộ và đã sửa: tương phản, mục bấm dưới 24px, link chỉ
khác màu, vùng cuộn không nhận focus). Lượt Playwright đầy đủ gần nhất đạt 10/10 ở `3f362c6`; các sửa sau khi soát ảnh (`858229a`) đã qua
lint, 326 test và contract, nhưng lượt Playwright chạy lại bị hệ thống dừng vì máy thiếu bộ nhớ — cần chạy lại
`pnpm --filter @udp/portal demo:screens` khi máy rảnh.

**Xem:** góc dưới phải có nút "Bản xem thử · <vai>" — đổi vai Quản trị viên / Developer / Người mới (chưa có project
nào) và kịch bản nền tảng Ổn định / Có rủi ro (Bảng điều khiển).

**Dữ liệu mẫu:** 161 người dùng (7 quản trị), 37 project ở mọi trạng thái, checkout-service 54 flag (nháp, lưu trữ,
kill switch, flag cũ), 12 segment, 13 rollout (đang chạy, tạm dừng, vượt ngưỡng 1/3, tự lùi, lùi tay; số đo khớp đúng
cách bộ điều phối quyết định), 2 184 dòng nhật ký audit với người làm thật, job ở mọi trạng thái, 14 tài nguyên mồ côi
trên ba cloud, credential chưa từng kiểm, deploy chờ duyệt, các project ở từng mức "Bắt đầu".

### Việc hoàn thiện sau khi duyệt (không để nợ)

| #   | Việc                                                                                                                 | Vì sao                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| H1  | Service 1: bộ lọc `platformRole`, `order` cho `/admin/users`; `search`, `order` cho `/admin/projects`                | Schema của máy chủ thật đang chặt: dùng bộ lọc mới sẽ nhận 400 |
| H2  | Service 2: nhật ký `flag.env.update` / `flag.rule.update` ghi kèm `flagKey`                                          | Để nhật ký gọi tên flag như bản mẫu; máy chủ thật chưa ghi     |
| H3  | UX-23: Service 3 trả mã lý do + số, Portal viết câu theo ngôn ngữ                                                    | Bản tiếng Anh còn câu tiếng Việt ở lý do rollout               |
| H4  | Tách khuôn bảng lệnh Ctrl K dùng chung cho hai portal                                                                | Bảng lệnh của Bảng điều khiển đang chép khuôn listbox          |
| H5  | Gom `ux-*.css` vào đúng chỗ trong `portal.css`; kiểu `.alert.neutral/.ok` dùng chung                                 | Tệp theo khu chỉ để làm song song                              |
| H6  | `qk.adminUsers`/`qk.adminProjects` nhận bộ lọc có kiểu thay vì chuỗi ghép                                            | Khoá cache rõ nghĩa                                            |
| H7  | Kiểm tuỳ chọn `headers` của `@openfeature/ofrep-web-provider` trong hướng dẫn nhanh cho trình duyệt với mã nguồn gói | Gói chưa cài trong repo nên chưa đối chiếu được                |
| H8  | Panel project của Bảng điều khiển: "job gần nhất" hiện chỉ xét trang đầu (50) của danh sách lỗi                      | Đủ khi ít job; cần route theo project nếu nhiều                |
| H9  | Tài liệu: `UDP_design.md` §10 (các màn), quyết định D-P51, bàn giao                                                  | Như mọi plan                                                   |
