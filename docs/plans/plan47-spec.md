# Plan #47 — SPEC v1: provider OpenFeature Python

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 8; §6.8 "Bản Python", §6.6 (đoạn mã Python,
`contextvars`), §11.1, §16 hàng "Provider Python chưa có".

## 1. Phạm vi

§6.8 hứa: "Cùng bốn thành phần, khác đúng một thứ: cơ chế mang ngữ cảnh theo request là
`contextvars`… Máy trạng thái, tuỳ chọn cấu hình, giá trị mặc định và ngữ nghĩa fail-static giống
hệt", và "dùng lại vector test hash/delta dạng JSON của bản Node". Plan này làm:

| Thành phần                   | Bản Node                             | Bản Python (`sdks/python`, gói `udp-openfeature`)        |
| ---------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Lõi đánh giá, áp delta       | `@udp/flag-evaluator`                | `udp_openfeature.evaluator` — viết lại, kiểm bằng vector |
| Parser SSE, transport, cache | `sse.ts`, `transport.ts`, `store.ts` | `sse.py`, `transport.py` (thư viện chuẩn), `store.py`    |
| Vòng đồng bộ                 | `sync.ts` (event loop)               | `sync.py` (luồng nền daemon, một khoá)                   |
| Provider, telemetry          | `provider.ts`, `stats.ts`            | `provider.py` (`AbstractProvider`), `stats.py`           |
| Nhãn `ff`                    | `labels.ts` (`AsyncLocalStorage`)    | `labels.py` (`ContextVar`)                               |
| Middleware                   | `metrics.ts` (Express, prom-client)  | `metrics.py` — ASGI và WSGI (`prometheus-client`, extra) |

Không làm: phát hành PyPI (như npm — cần kênh phát hành, ghi ở §16).

## 2. Quyết định

### QĐ-1: Lõi viết lại, tương đương KIỂM chứ không hứa

Không có cách chạy lõi Node trong tiến trình Python mà không kéo Node vào ứng dụng của khách, nên lõi
được viết lại. I26 giữa hai ngôn ngữ vì vậy phải đúng bằng PHÉP SO:

- `packages/flag-evaluator/conformance/vectors.json` do chính lõi Node sinh (`scripts/conformance.ts`);
  `tests/conformance.test.ts` dựng lại và so với tệp — sửa lõi mà quên sinh lại là đỏ. Bản Python chạy
  qua đúng tệp đó: bucket, JSON chuẩn tắc, `config_hash`, đánh giá, áp delta, regex, mặc định provider.
- Phép so chéo ngôn ngữ với Service 2 THẬT (test Node điều khiển provider Python ở tiến trình con).

Những chỗ JavaScript và Python khác nhau được viết tường minh, không tin hành vi mặc định:
`Number::toString`, thứ tự và độ dài chuỗi theo đơn vị UTF-16, `typeof`, `JSON.parse` (không `NaN`,
số nguyên ngoài ±2⁵³ thành double), murmur3 trên UTF-8 của chuỗi NFC (surrogate lẻ ⇒ U+FFFD).

### QĐ-2: Regex — một parser theo ngữ pháp ECMAScript, và ngữ pháp khả chuyển (D-P35)

`re` của Python khác ECMAScript ở `\d \w \s . $ \B`, nhóm có tên, `\u{…}`, cặp thay thế, `\cX`,
`[^]`… Một bộ dịch "tìm-thay" sẽ lọt ca. Làm một parser đệ quy theo ngữ pháp ECMAScript cờ `u` vừa KIỂM
(bác đúng thứ `new RegExp(…, "u")` bác) vừa DỊCH sang `re` cùng nghĩa.

`\p{…}` không dịch được một cách trung thực: tập ký tự theo thuộc tính Unicode đổi theo phiên bản Unicode
của runtime (ICU của V8 và bảng của Python không cùng nhịp). Cờ nội tuyến `(?i:…)` và luật trùng tên nhóm
đổi theo phiên bản V8. Cho phép chúng là để I26 vỡ bằng dữ liệu HỢP LỆ. Nên `regexSyntaxIssue` (đường ghi
S1/S2 và schema đọc của mọi SDK) từ chối thêm ba thứ đó; pattern ngoài ngữ pháp khả chuyển là rule hỏng
ở CẢ HAI phía.

### QĐ-3: Luồng nền daemon thay event loop

OpenFeature Python đồng bộ (`initialize` chặn, `set_provider` chạy nó trên luồng riêng). Vòng đồng bộ chạy
trên luồng daemon (vai `unref`: ứng dụng thoát được dù quên `api.shutdown()`), `Cancel` thay `AbortSignal`
(đóng socket đang chặn), MỘT khoá cho mọi thay đổi trạng thái của ba luồng (stream, polling, kiểm STALE),
không bao giờ giữ khoá qua I/O. Watchdog nhịp tim là một luồng mỗi kết nối, `arm` chỉ dời mốc. Transport
dùng thư viện chuẩn (`http.client`), mỗi request một kết nối — request hiếm, pool không đáng một phụ thuộc.

### QĐ-4: Tuỳ chọn và mặc định giống hệt — kiểm, không chép tay

Tuỳ chọn cùng tên (`snake_case`), cùng mặc định, cùng phép kiểm lúc dựng (`ValueError` thay `RangeError`).
Bảng mặc định (`SSE`, `PROVIDER`, `SDK_STATS.report`, `STATS_VARIANT`) nằm trong phần `defaults` của tệp
vector; test Python so từng bảng. `fetch` của bản Node ⇒ `connection_factory`; `logger` mặc định là logger
`udp_openfeature` với `NullHandler`.

### QĐ-5: NUMBER và OpenFeature Python

OpenFeature Python tách `integer`/`float` và SDK kiểm kiểu kết quả. `float` nhận mọi số hữu hạn (đổi sang
`float`); `integer` chỉ nhận số nguyên (`2.5` ⇒ `TYPE_MISMATCH`, không làm tròn im lặng).

### QĐ-6: Nhãn `ff` không cần cấu hình

Đoạn mã §6.6 cũ đưa `picks=_picks` cho cả provider lẫn middleware — developer khai hai lần, khai lệch là
nhãn biến mất im lặng. Bản hiện thực dùng MỘT `ContextVar` của module (như `requestStore` toàn tiến trình
của bản Node); provider tự gắn hook; middleware ASGI và WSGI cùng hợp đồng nhãn với bản Node (test đọc
`metrics.ts` để so tên, nhãn, bucket).

## 3. Tiêu chí chấp nhận

- **AC-1** Bản Python qua mọi vector của lõi Node (bucket, JSON chuẩn tắc, hash, đánh giá, delta, regex,
  mặc định).
- **AC-2** Các ca của bản Node được port: parser SSE, vòng đồng bộ (I15a, I18, polling, STALE, 401, watchdog,
  các hồi quy QA), provider qua SDK thật, telemetry V7, transport trên mạng thật, middleware.
- **AC-3** Provider Python với Service 2 thật: I15c không RESYNC, I26 so với OFREP.
- **AC-4** Cổng Python: ruff, `ruff format --check`, mypy `--strict`, pytest — chạy trong CI.
- **AC-5** Không thoái cấp: test của `@udp/shared-types`, `@udp/flag-evaluator`, design-lint, typecheck,
  lint, prettier xanh.

## 4. Phát hiện khi làm

- Bộ vector regex bắt được một khác biệt thật: `\B` của `re` (trước Python 3.14) không khớp chuỗi rỗng,
  ECMAScript thì có. Bản dịch là `(?:\B|^\Z)`.
- Đợt dò 20 000 pattern ngẫu nhiên (1 166 hợp lệ × 8 chuỗi): 0 khác biệt sau khi sửa.
- `api.add_handler` của OpenFeature Python chạy handler NGAY cho provider đang ở trạng thái đó (kể cả
  provider no-op) — test đếm READY phải lọc theo `provider_name`.
- Công cụ ghi tệp của phiên làm việc đổi chuỗi `\u` + 4 chữ số hex thành ký tự thật; đã tìm và sửa một
  U+2028 vô hình còn trong `conformance.ts` từ trước. Mã mới viết code point bằng số (`chr`,
  `String.fromCharCode`) ở những chỗ đó.
