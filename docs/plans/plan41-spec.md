# Plan #41 — Portal thấy thay đổi của người khác (SSE) và danh sách lớn (phân trang) — SPEC

Trạng thái: **v1, 26/09/2026**. Nguồn: §10.14 (Flag List / Flag Detail invalidate bằng "SSE
`flag_changed`"; "SSE chỉ gọi `invalidateQueries`"), §9 (`GET /flags?envId=&limit=&offset=&search=
&status=`, `GET /projects`), D-P19 (SSE đọc database mỗi giây). Sổ nợ: `portal-sse`,
`portal-pagination`. Tiền đề: Plan #28 (SSE job), Plan #40.

## 1. Mục tiêu

1. Hai người cùng sửa flag: người thứ hai thấy thay đổi của người thứ nhất trong khoảng một giây,
   không phải sau `staleTime`.
2. Project vài trăm flag: trang Flag tải MỘT trang, không tải hết; bảng lệnh, tổng quan và hộp
   thoại tạo rollout không tải trọn danh sách.
3. Có số đo p95 thời gian tải danh sách ở 200 flag × 3 environment.

## 2. Quyết định

- **QĐ-1 — `GET /projects/:id/stream`** (VIEWER, cookie phiên như mọi route Portal): SSE sự kiện
  `flag_changed` `{ environmentId, configVersion }` khi `config_version` của một environment của
  project tiến (mọi lần ghi cấu hình — flag, rule, segment, tracked — đều tăng nó, ADR-05);
  `heartbeat` sau 15 giây im lặng. Lần mở đầu gửi ảnh chụp hiện tại (không phải sự kiện).
- **QĐ-2 — Nguồn là database, đọc theo lô**: một "hub" mỗi tiến trình S1 hỏi
  `environments(id, config_version)` của MỌI project đang có luồng mở trong MỘT câu mỗi giây
  (`pollMs` 1000 như D-P19), rồi chia cho từng luồng. Không LISTEN: S1 không có kết nối session
  riêng bằng `udp_s1` (thêm là thêm một biến môi trường bắt buộc); độ trễ ≤ một vòng là đủ cho
  Portal. Không luồng nào mở ⇒ không truy vấn nào.
- **QĐ-3 — Portal**: mở luồng ở khung project; `flag_changed` ⇒ `invalidateQueries` các key flag,
  rule, ma trận env, segment, stale của project — KHÔNG BAO GIỜ `setQueryData` (§10.14, AC của
  `portal-sse`). Lỗi luồng (phiên hết hạn, mạng) ⇒ đóng và mở lại sau backoff; phiên được làm mới
  bởi các lời gọi thường của trang.
- **QĐ-4 — `GET /flags` trả `total`** (cùng bộ lọc) và nhận `isEnabled=true|false` (cần `envId`);
  `GET /projects` nhận `limit` (≤ 100, mặc định 50), `offset`, trả `total`.
- **QĐ-5 — Portal theo trang**: trang Flag 50 flag/trang, tìm kiếm và lọc trạng thái ở máy chủ,
  điều hướng trang; bảng lệnh tìm flag ở máy chủ (`search`, 20 kết quả); tổng quan đọc hai con số
  bằng `limit=1` (`total`, `total` khi `isEnabled=true`); hộp thoại tạo rollout chọn flag bằng tìm
  kiếm máy chủ. Danh sách project theo trang như trang Flag.
- **QĐ-6 — Phép đo**: harness đo `GET /flags?envId&include=stats&limit=50` trên project 200 flag × 3
  environment (S1 trong tiến trình + S2 thật, database dev), 50 lần sau 5 lần làm nóng; kết quả thô
  vào `docs/measurements/raw/`, p95 ghi ở `README.md`. Ngưỡng của sổ nợ: p95 ≤ 500 ms.

## 3. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Ghi cấu hình ở env A ⇒ luồng của project nhận `flag_changed` cho A trong ≤ 2 vòng; env B không nhận gì; project khác không |
| AC-2 | Hub: N luồng của K project ⇒ MỘT câu truy vấn mỗi vòng; đóng luồng cuối ⇒ ngừng hỏi                                        |
| AC-3 | Portal: sự kiện ⇒ chỉ `invalidateQueries` (không `setQueryData`), đúng key của project; lỗi ⇒ mở lại sau backoff           |
| AC-4 | `total` đúng với mọi tổ hợp lọc; `isEnabled` không kèm `envId` ⇒ 400; `GET /projects` theo trang                           |
| AC-5 | Portal: trang Flag, bảng lệnh, tổng quan, tạo rollout không gọi `GET /flags` với `limit > 50`                              |
| AC-6 | Có số đo p95 ở 200 × 3; vượt ngưỡng thì ghi đúng như vậy và nói vì sao                                                     |
| AC-7 | Không thoái cấp: S1, Portal, design-lint, golden                                                                           |

## 4. Nợ kiểm chứng

Không có phần cần hạ tầng mới: SSE và phân trang chạy trên database dev. Độ trễ `flag_changed` qua
proxy/ingress thật (buffering SSE): gộp `portal-e2e`.
