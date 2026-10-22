# Plan #57 — Kiến trúc trực quan: Tổng quan hệ thống (project) và Kiến trúc nền tảng UDP

Người dùng (30/09/2026): "tôi vẫn thấy thiếu về các biểu đồ và kiến trúc … kiến trúc về tổng quan hệ thống thì sao …
tham khảo các nền tảng tương tự khác đi và thẩm mỹ trên mạng", rồi "làm xong thì dựng lên cho tôi xem, tôi duyệt thì
mới sửa code". Bản mẫu bốn góc nhìn (dữ liệu thật của bản xem thử) — người dùng **duyệt góc 1 và góc 4**: "tui chọn 1
và 4 nha". Góc 2 (theo domain) và 3 (hạ tầng & node) KHÔNG làm ở plan này.

Tham khảo (nghiên cứu 30/09): C4 model và Structurizr (sơ đồ container + deployment có tiêu đề, chú giải, cạnh ghi
giao thức, lớp sức khoẻ đỏ/vàng/xanh); Datadog Service Map và Kiali (sức khoẻ ở viền nút kèm biểu tượng, không chỉ màu;
cạnh có nhãn); Humanitec và Backstage (bấm nút ⇒ panel chi tiết); Grafana Tempo (bảng số liệu cạnh đồ thị); W3C WAI
(ảnh phức tạp cần bản văn bản thay thế).

## 1. Hiện trạng

| Việc                         | Có                                                                          | Thiếu                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Trang Kiến trúc của project  | Khung lồng nhau cloud → mạng → cluster → cột "bậc" công cụ, cạnh capability | Không trả lời "hệ thống phục vụ ai, yêu cầu chảy qua đâu, dữ liệu nằm đâu"; cột bậc bị cắt ở màn 1440; cạnh mảnh khó theo |
| Bảng điều khiển nền tảng     | Tổng quan: tín hiệu máy, service, sao lưu, chứng chỉ dạng hàng thẻ          | Không có sơ đồ UDP: khối nào, chạy trên đâu, nói chuyện với ai bằng giao thức gì                                          |
| Số liệu trên trang Kiến trúc | Ba con số (công cụ, environment, workload)                                  | Không có deploy theo ngày, không có RED của production                                                                    |

## 2. Quyết định

### QĐ-1: Trang Kiến trúc có hai góc nhìn; "Tổng quan hệ thống" là mặc định

Bộ chọn góc nhìn trên đầu trang: **Tổng quan hệ thống** (mới, mặc định) và **Hạ tầng & công cụ** (sơ đồ hiện có, giữ
nguyên — không thoái cấp). Góc nhìn nằm trên URL (`?view=infra`; mặc định không ghi ra), cùng quy ước với `?tool=`.

### QĐ-2: Tổng quan hệ thống — bố cục C4 container cố định, như bản mẫu đã duyệt

| Vùng                     | Nội dung                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Dải trên "Giao hàng"     | git push → CI/CD → Container Registry → Artifact Registry → GitOps → Progressive Delivery                  |
| Cột trái                 | Người dùng cuối (HTTPS)                                                                                    |
| Cột "Lưu lượng"          | Ingress, Service Mesh                                                                                      |
| Giữa                     | Một khung cho MỖI environment (theo `rank`), tô màu env, trong đó từng workload với trạng thái deploy cuối |
| Cột "Dữ liệu"            | Database Operators, Secrets Management                                                                     |
| Dải dưới "Quan sát"      | Monitoring, Logging, Tracing                                                                               |
| Cột phải dưới "Quản trị" | Policy, Security Scanning, Cost Management, Infrastructure as Code                                         |

Domain chưa bật thì không có thẻ, và cạnh nối thẳng tới thành phần kế tiếp đang có (không Service Mesh ⇒ Ingress →
environment). Mười sáu domain đều có chỗ — bật domain nào là thấy nó ở đúng vai trò.

### QĐ-3: Cạnh là VAI TRÒ, chữ do Portal đặt

Cạnh nối các vai trò (yêu cầu vào, định tuyến, SQL, bí mật, đẩy image, sync, canary, telemetry…), suy từ domain đang
bật — không phải lưu lượng đo được, và chú giải nói đúng điều đó. Nét liền: yêu cầu và dữ liệu; nét đứt: giao hàng,
điều khiển, telemetry. Nhãn nằm trên lớp riêng PHÍA TRÊN thẻ (bản mẫu: nhãn dưới thẻ bị che). Cạnh capability của
resolver vẫn ở góc "Hạ tầng & công cụ".

### QĐ-4: Sức khoẻ trên thẻ — một bảng, không chỉ màu

Thẻ công cụ dùng `toolHealth` (cùng bảng với lưới sức khoẻ và sơ đồ cũ): biểu tượng + chữ trạng thái, viền đỏ/cam cho
lỗi/cần xem. Workload hiện sự kiện deploy cuối (đã deploy, chờ duyệt, rollback, lỗi). Bấm thẻ công cụ ⇒ panel chi tiết
hiện có (`ToolPanel`); workload ⇒ trang Deploy của env đó.

### QĐ-5: Bốn con số đầu góc nhìn, có biểu đồ nhỏ

1. Công cụ theo sức khoẻ (ổn / cần xem / lỗi).
2. Workload trên bao nhiêu environment.
3. **Deploy 14 ngày** — cột nhỏ thành công/thất bại theo ngày. Dữ liệu mới: `architecture.deploys` (Service 1), kết
   cục deploy theo ngày UTC trên MỌI env của project, CÙNG hàm thuần `dailyOutcomes` của Plan #56.
4. **RED của production** — p99 (chuỗi `latencyP99Ms` của wire) và tỉ lệ lỗi 6 giờ qua từ
   `GET /projects/:id/metrics/red` hiện có; không có nguồn
   metrics ⇒ thẻ nói vậy và dẫn tới trang Domain (cùng trạng thái với trang Giám sát).

### QĐ-6: Bản văn bản thay thế

Nút **Xem dạng bảng** thay sơ đồ bằng hai bảng: thành phần (vai trò, công cụ, trạng thái) và kết nối (từ, tới, nhãn).
Thẻ là `button` (bàn phím mở panel); lớp cạnh `aria-hidden` vì bảng mang cùng thông tin.

### QĐ-7: Kiến trúc nền tảng UDP — `/admin/architecture`

Mục mới trên thanh bên của Bảng điều khiển. Bố cục C4 container + deployment như bản mẫu:

- **Khung máy:** Oracle Cloud Always Free, tên VM, 2 OCPU / 12 GB, k3s, "0 đồng"; bên trong Portal, core-backend,
  flag-service, pd-controller (hàng giữa), PostgreSQL và sao lưu hằng đêm (hàng dưới); ba thanh ngân sách: CPU, RAM của
  máy, ổ PostgreSQL.
- **Bên ngoài:** Developer, Nhà phát hành, SDK trong ứng dụng, pipeline CI (trái); cloud của khách, cluster của khách,
  Prometheus của khách, Object Storage (phải).
- **Cạnh ghi giao thức:** HTTPS, REST + SSE, SSE · OFREP, webhook, SQL · pg-boss, LISTEN/NOTIFY, SQL · lease, API cloud,
  token 1 giờ, metrics.query, pg_dump.
- **Sức khoẻ sống** từ route hiện có: `/admin/system/health` (ba service, database), `/admin/platform` (máy, PVC, sao
  lưu, chứng chỉ, bản phát hành), `/admin/overview` (bốn con số: người dùng, project, deploy 7 ngày, cluster của khách
  theo cloud). Tín hiệu `unavailable` ⇒ "Không rõ" kèm lý do (cùng `platformReason` của trang Tổng quan).
- Cùng nút **Xem dạng bảng** như QĐ-6.

Không route mới ở Service 1 cho góc này.

### QĐ-8: Không thư viện mới — bố cục cố định + lớp cạnh đo sau layout

Hai sơ đồ đã duyệt có bố cục CỐ ĐỊNH, dưới 30 nút: CSS grid xếp thẻ, một lớp cạnh chung (`LinkLayer`) đo vị trí SAU
layout bằng `ResizeObserver` (như `EdgeLayer`, không đo trong render) và vẽ đường cong có nhãn, nét liền/đứt, ngang/dọc.
React Flow + ELK (đề xuất của nghiên cứu) dành cho đồ thị bố cục TỰ DO — góc "Theo domain" chưa được duyệt, nên chưa
thêm ~490 KB phụ thuộc. `prefers-reduced-motion` được tôn trọng.

### QĐ-9: Chi phí 0

Một trường mới trong response sẵn có; mọi thứ khác là Portal. Không hạ tầng mới.

## 3. Ngoài phạm vi

- Góc "Theo domain" (làn Build → Govern) và "Hạ tầng & node" (node, pod, CPU/RAM) — người dùng chưa duyệt.
- Lưu lượng đo được trên cạnh (request/s giữa các thành phần) — cần service mesh telemetry thật.

## 4. Tiêu chí chấp nhận

- **AC-1** Trang Kiến trúc: hai góc nhìn, mặc định Tổng quan hệ thống, `?view=infra` mở sơ đồ cũ nguyên vẹn.
- **AC-2** Tổng quan hệ thống: đủ vùng của QĐ-2, domain chưa bật không thẻ và cạnh nối qua, cạnh có nhãn, chú giải,
  sức khoẻ không chỉ màu; bấm thẻ mở panel.
- **AC-3** `architecture.deploys`: 14 ngày UTC, cùng `dailyOutcomes`; golden; test tích hợp.
- **AC-4** RED production trên thẻ, trạng thái "chưa có nguồn metrics".
- **AC-5** `/admin/architecture`: đủ thành phần và cạnh của QĐ-7, sức khoẻ và ngân sách từ ba route hiện có, "Không
  rõ" khi tín hiệu vắng; chỉ PLATFORM_ADMIN.
- **AC-6** "Xem dạng bảng" ở cả hai sơ đồ; hai ngôn ngữ; design-lint (SVG đã khai, không chữ viết thẳng) xanh.
- **AC-7** Bản xem thử có dữ liệu cho cả hai; `contract.check`; cổng `portal-demo` năm lượt có màn mới (và màn sơ đồ
  cũ qua `?view=infra`).
- **AC-8** Tài liệu: §10.6/§10.11, D-P50, DESIGN.md, bàn giao.
