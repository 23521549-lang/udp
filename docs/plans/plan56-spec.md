# Plan #56 — Trang "Bằng chứng thực nghiệm" trong Bảng điều khiển nền tảng

Người dùng (30/09/2026): "ở chỗ portal nhà phát hành, bạn thêm cho mình các tính năng để theo dõi các dữ liệu làm
thành biểu đồ để phục vụ cho bằng chứng của nckh nha, các cái benmark, các cái metric mà mình nói mình sẽ đo trong
file thiết kế .md á".

"Portal nhà phát hành" là Bảng điều khiển nền tảng (`/admin`, chỉ PLATFORM_ADMIN). "Benchmark, metric trong file
thiết kế" là 16 phép đo của `UDP_design.md` §14 (E1…E16) cộng hai phép đo phụ đã có tệp thô (I34, danh sách flag).

## 1. Hiện trạng

| Việc                  | Có                                                                                                                                                | Thiếu                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Kết quả đo            | `docs/measurements/raw/*.json` — một vỏ chung (`experiment`, `at`, `environment` truy nguồn, `data`) cho E1, E3, E4, E8, E14, I34, danh sách flag | Không màn hình nào đọc chúng; số chỉ nằm trong README và §14 dạng chữ                                 |
| E7 (phân phối hash)   | Đã đo, χ² ở §14                                                                                                                                   | Script chỉ in ra console — không có tệp thô, không truy được nguồn                                    |
| E10 (DORA)            | Tính sống từ `deployment_events` cho MỘT project × MỘT env (`/projects/:id/metrics/dora`)                                                         | Không có góc nhìn cả nền tảng — thứ §14 gọi là "DORA của luồng phát triển trên chính nền tảng"        |
| Phép đo chưa làm (nợ) | 44 mục trong `kiem-chung-con-no.md`                                                                                                               | Không màn hình nào nói phép đo nào còn thiếu, vì sao, cần gì                                          |
| Biểu đồ               | `LineChart` (trục thời gian), `BarChart` (thanh xếp chồng), `Meter`                                                                               | Không có biểu đồ theo NHÓM (ô lưới 1/10/100 flag…), không có thang log — số µs và số ms cùng một hình |

## 2. Quyết định

### QĐ-1: Một trang `/admin/evidence` — "Bằng chứng"

Mục mới trên thanh bên của Bảng điều khiển (icon `flask-conical`). Đầu trang: bốn con số (phép đo đã có số / tổng,
số đóng góp C1–C3 có ít nhất hai phép đo đã có số, số mục nợ, lần đo mới nhất). Thân trang: một thẻ cho MỖI phép đo
của §14 (và I34, danh sách flag), nhóm theo đóng góp (C1, C2, C3, nền). Mỗi thẻ nói: phép đo chứng minh điều gì,
trạng thái, biểu đồ (nếu có số), và **nguồn** của con số.

Trạng thái (một bảng duy nhất):

| Trạng thái     | Nghĩa                                                | Ví dụ                    |
| -------------- | ---------------------------------------------------- | ------------------------ |
| Đã đo          | Có tệp thô; con số dưới đây đọc từ tệp đó            | E1, E3, E8               |
| Đo một phần    | Có tệp thô, nhưng sổ nợ còn mục của chính phép đo đó | E3 (E3-quiet), E4, E14   |
| Số sống        | Tính lúc mở trang từ dữ liệu vận hành                | E10                      |
| Chưa đo        | Không có tệp thô; nêu mã sổ nợ và điều kiện để đo    | E2, E5, E6, E9, E15, E16 |
| Cần người thật | Nhóm tuỳ điều kiện của §14.2                         | E11, E12, E13            |

### QĐ-2: Số tĩnh đọc TRỰC TIẾP từ tệp thô, lúc build

Portal nạp `docs/measurements/raw/*.json` bằng `import.meta.glob` (Vite) vào một chunk riêng, chỉ tải khi mở trang
Bằng chứng. Mỗi tệp parse bằng schema zod của phép đo (`@udp/shared-types/measurements`); tệp mới nhất theo tên
(`<EXP>-<YYYYMMDD-HHmm>.json`) là số chính thức — đúng quy ước của README, và các lần đo bị loại (E3-1543, I34-1555)
đều cũ hơn lần chính thức. Không có tệp nào bị viết tay lại: trang hiện đúng thứ harness đã ghi.

Vì sao không qua Service 1: số đo là tài liệu của repo, gắn với commit đã sinh ra nó. Đọc lúc build nghĩa là bản
Portal của commit X hiện đúng bằng chứng của commit X, không cần máy chủ giữ tệp, không thêm route, chi phí 0.

Một tệp không parse được (harness đổi hình) hiện thành thẻ lỗi nói tên tệp và trường sai — không làm trắng trang.
Một phép đo có tệp thô nhưng chưa có biểu đồ riêng (E5, E9 khi CI commit kết quả) vẫn hiện: nguồn, tải JSON.

### QĐ-3: E7 ghi tệp thô như mọi phép đo khác

Script E7 chuyển sang `@udp/experiments` (`pnpm --filter @udp/experiments e7`), ghi qua `writeResult` (vỏ chung,
truy nguồn) — `data`: mỗi kịch bản `{ name, n, df, critical, chi2, pass, variants[{ key, expectedShare,
observedShare }] }`. Chạy lại một lần để có `raw/E7-*.json`. Tệp cũ trong `@udp/flag-evaluator` bị xoá (không hai
bản).

### QĐ-4: E10 sống — `GET /admin/evidence/dora?days=`

Service 1, PLATFORM_ADMIN: với mỗi project còn sống có environment production, năm chỉ số DORA của env production đó
(CÙNG hàm thuần `computeDora` của `/metrics/dora` — không định nghĩa thứ hai), cộng số deploy thành công/thất bại
theo ngày trên mọi env production. `days` ∈ {7, 30, 90}, mặc định 30. Không dữ liệu ⇒ danh sách rỗng, không lỗi.

### QĐ-5: Biểu đồ nhóm — component `CategoryChart`

SVG, theo DESIGN.md §6 "Trục biểu đồ": nhóm trên trục hoành (ô lưới "1 flag · 10 rule"), tối đa bốn chuỗi, trục tung
3–4 vạch có nhãn, **thang tuyến tính hoặc log** (µs và ms trong cùng một câu chuyện), đường ngưỡng tuỳ chọn (500 ms
của danh sách flag, giá trị tới hạn của χ²), chú giải, và **bảng số liệu thay thế** (mở được, trình đọc màn hình
đọc được). Màu chuỗi dùng bốn token dữ liệu sẵn có (`accent`, `baseline`, `v3`, `v4`).

Biểu đồ theo phép đo:

| Phép đo        | Biểu đồ                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1             | Thanh xếp chồng mỗi đợt thêm tool: tệp trong thư mục adapter so với tệp ngoài; bốn con số: 0 phá interface, 0 nới contract, 72/72 tool sau tag, tệp ngoài adapter mỗi tool |
| E3             | Nhóm theo ô lưới (flag × rule), log µs: p50 và p99 của SDK và của lõi; OFREP (remote) ghi ở chú thích                                                                      |
| E4             | (a) p50 độ trễ lan truyền theo 1/10/100 flag, bốn chế độ; (b) byte mỗi thay đổi snapshot so với delta (log)                                                                |
| E7             | χ² so với giá trị tới hạn theo kịch bản (ngưỡng); tỉ lệ quan sát so với mong muốn                                                                                          |
| E8             | Thanh xếp chồng: bị giết bởi differential / chỉ bởi bộ test / sống sót; oracle sinh 7/7 mã (Meter)                                                                         |
| E10            | Deploy mỗi ngày (thành công/thất bại) trên mọi env production; bảng DORA theo project                                                                                      |
| E14            | Nhóm theo (T, V), log: số series dự đoán, đo đủ tổ hợp, đo thực tế                                                                                                         |
| I34            | Theo pha: thời gian hội tụ so với giới hạn; lượt đánh giá sai/lỗi trong lúc ngắt                                                                                           |
| Danh sách flag | p50/p95/p99 của trang, đếm, cả danh sách, ngưỡng 500 ms — hiện đúng ô KHÔNG ĐẠT                                                                                            |

### QĐ-6: Nguồn và tải về — thứ biến biểu đồ thành bằng chứng

Mỗi thẻ có số tĩnh ghi: tệp, thời điểm đo, commit (ngắn), **cây có thay đổi chưa commit** (mọi tệp hiện có
`sourceDirty: true` — hiện kèm sha256 của diff, không giấu), hình học mạng, máy đo (CPU, RAM trống). Hai nút: **Tải
tệp thô** (đúng tệp JSON trong repo) và **Tải CSV** (bảng số liệu của biểu đồ — để vẽ lại trong luận văn).

### QĐ-7: Sổ thí nghiệm là mã, và không được trôi

`features/admin/evidence/experiments.ts` khai MỖI phép đo: mã, đóng góp, tệp thô tương ứng, mã sổ nợ liên quan.
Chữ (tên, "chứng minh điều gì", "cần gì để đo") ở `*.messages` hai ngôn ngữ. Một phép kiểm của Portal đối chiếu:
tập mã của sổ = tập mã E\* trong bảng §14 của `UDP_design.md`; mọi tiền tố tệp thô đều có trong sổ; mọi mã sổ nợ sổ
khai đều là một mục có thật của `kiem-chung-con-no.md`; mọi tệp thô parse được.

### QĐ-8: Chi phí 0

Không hạ tầng mới: tệp thô nằm trong bundle của Portal (chunk riêng, ~90 KB); một route đọc trong Service 1.

## 3. Ngoài phạm vi

- Chạy lại các phép đo còn nợ (E2, E5, E6, E9, E15, E16…) — cần hạ tầng (sổ nợ).
- Xuất ảnh biểu đồ (SVG/PNG): CSV là thứ luận văn cần để vẽ lại theo mẫu của khoa.

## 4. Tiêu chí chấp nhận

- **AC-1** `/admin/evidence` hiện mọi phép đo của §14 (+ I34, danh sách flag) với đúng trạng thái; người không phải
  PLATFORM_ADMIN không vào được (guard sẵn có của `/admin`, route S1 403).
- **AC-2** Mọi con số tĩnh đọc từ tệp thô qua schema; tệp mới nhất là số chính thức; tệp hỏng hiện thẻ lỗi.
- **AC-3** E7 có tệp thô do harness ghi; §14 trỏ tới lệnh mới.
- **AC-4** `GET /admin/evidence/dora` dùng `computeDora`; golden; test tích hợp (403 cho người thường, số khớp).
- **AC-5** `CategoryChart`: thang log và tuyến tính, ngưỡng, ≤ 4 chuỗi, bảng thay thế; test đơn vị.
- **AC-6** Nguồn + tải tệp thô + tải CSV trên mọi thẻ có số tĩnh.
- **AC-7** Phép kiểm "không trôi" (QĐ-7) xanh; hai ngôn ngữ; design-lint xanh.
- **AC-8** Bản xem thử có trang Bằng chứng (cùng tệp thô) và DORA giả; `contract.check`; cổng `portal-demo` năm lượt.
- **AC-9** Tài liệu: §10.11, §14 (trang và lệnh E7), D-P49, DESIGN.md (CategoryChart), bàn giao.
