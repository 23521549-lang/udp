# Plan #53 — SPEC v1: Hai không gian Portal, trang chủ, sơ đồ kiến trúc, giám sát, bảng điều khiển nền tảng

Nguồn: người dùng 29/09/2026:

- Nhận xét sau khi xem bản xem thử: "không phân biệt được đâu là sản phẩm cho người dùng, đâu là cho nhà phát
  hành", "chỗ để chọn cloud đâu", "thiếu dashboard", "thiếu các màn monitoring", "thiếu những kiến trúc hình
  ảnh trực quan".
- Duyệt đề xuất sáu màn hình.
- Duyệt tám đề xuất của đợt review bằng Taste Skill, Web Interface Guidelines, Awesome Design, image-to-code
  và Playwright CLI ("duyệt nha").
- "bơm dữ liệu nhiều, đầy đủ và đa dạng".

Thiết kế liên quan:

- §10.6: ProjectHeader có Cloud badge; DomainHealthGrid "domain_status per domain".
- §10.11 (Admin UI), §10.13, §5.3 (C2: đồ thị capability sinh thứ tự deploy).
- §5.4 (MetricsProvider), §7.4 (PromQL RED), §15.1 (máy công khai), D-P41.
- `docs/design/DESIGN.md` là chuẩn: "Nếu cần lệch khỏi chuẩn thì sửa file này trước".

## 1. Phạm vi

| Thiết kế hứa / người dùng cần                                | Hôm nay                                                                                                                   | Plan này                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phân biệt sản phẩm cho developer với trang của nhà phát hành | Chung một khung; lối vào `/admin` là mục "Quản trị" giữa menu project; `/admin` không có menu điện thoại, không đăng xuất | Hai khung: **Portal** (sáng, như cũ) và **Bảng điều khiển nền tảng** (thanh bên tối riêng, nhãn "Nhà phát hành"); lối vào ở menu tài khoản, chỉ PLATFORM_ADMIN thấy (QĐ-1) |
| Trang chủ developer                                          | `/app` nhảy thẳng vào danh sách project                                                                                   | `/app/home`: project cùng sức khoẻ, rollout đang chạy, việc cần xử lý, deploy 14 ngày (QĐ-5)                                                                               |
| Thấy hệ thống mình đã dựng (C2 là đóng góp của luận văn)     | Thứ tự deploy in dạng chữ ở màn xem trước                                                                                 | `/app/projects/:id/architecture`: cloud ⊃ mạng ⊃ cluster ⊃ environment ⊃ workload, công cụ và cạnh phụ thuộc tính bởi CHÍNH resolver (QĐ-3, QĐ-7)                          |
| Quan sát thứ mình đang chạy                                  | Số rời rạc: canary, DORA, lượt đánh giá mỗi flag                                                                          | `/app/projects/:id/monitoring`: request/lỗi/độ trễ theo workload và thời gian, lượt đánh giá flag, sức khoẻ domain, xu hướng chi phí, đường sang Grafana (QĐ-4)            |
| §10.6 DomainHealthGrid, Cloud badge                          | Chưa làm; cloud nằm ở tab thứ năm của Cài đặt                                                                             | Tổng quan: lưới sức khoẻ domain, thẻ Cloud có "Đổi cloud", sơ đồ thu nhỏ (QĐ-7)                                                                                            |
| Chủ nền tảng biết nền tảng có khoẻ, có còn 0 đồng            | `/admin` vào thẳng bảng người dùng; "Hệ thống" chỉ có 4 dòng up/down                                                      | `/admin/overview`: máy chạy UDP (CPU, RAM so với hạn mức A1), database so với ổ, sao lưu gần nhất, hạn chứng chỉ, bản phát hành, số liệu nền tảng (QĐ-6)                   |
| Lỗi review 29/09                                             | 12 lỗi hành vi, ~40 lỗi a11y/chữ đã kiểm chứng                                                                            | Sửa hết, và biến phần kiểm được bằng máy thành luật lint (QĐ-9)                                                                                                            |
| Chuẩn thiết kế                                               | Vàng vừa là "đang chạy" vừa là "cảnh báo"; `--v4` trùng sắc cảnh báo; đầu trang có gradient và ô icon lặp lại             | Token trạng thái ba sắc, bảng màu dữ liệu tách khỏi trạng thái, token khung bảng điều khiển, đầu trang gọn: sửa DESIGN.md + bản mẫu trước (QĐ-2)                           |
| Bản xem thử đủ và thật                                       | 10 người dùng, 8 project                                                                                                  | Dữ liệu nhiều, mọi màn, mọi trạng thái; cổng chụp màn tự động ở CI (QĐ-10, QĐ-11)                                                                                          |

Ngoài phạm vi:

- Nhúng Grafana vào Portal: chỉ có đường dẫn hoặc lệnh port-forward.
- Cảnh báo (alerting).
- Lịch sử 7 ngày của CPU máy ảo: nằm ở Oracle Console (sổ nợ `vm-oracle-real`, bước 8).
- Tách Portal thành hai bản build.

## 2. Quyết định

### QĐ-1: Hai không gian trong MỘT ứng dụng, hai khung

Hai khung dùng chung cookie phiên, lớp `http.ts`, token và bộ component. Tách hai bản build nghĩa là nhân đôi
auth và CSRF mà không được gì thêm.

**Khung chung.** Một component `Shell` giữ phần chung:

- thanh bên;
- nút menu điện thoại (`aria-expanded`, Esc, nền mờ, trả focus);
- link "Bỏ qua tới nội dung";
- khu tài khoản: tên, đổi giao diện, đăng xuất.

Nhờ vậy lỗi `/admin` không có menu điện thoại và không đăng xuất bị xoá bằng cấu trúc.

**Portal** (`/app`) giữ khung sáng.

**Bảng điều khiển nền tảng** (`/admin`):

- Thanh bên tối bằng token `--console-*`, cùng giá trị ở cả hai chế độ màu.
- Nhãn chữ "Nhà phát hành" cạnh logo. Mọi trang có crumb "Bảng điều khiển".
- Mục "Về Portal" để quay lại.

**Lối vào.** Mục "Quản trị" trong menu project bị bỏ. Bấm vào tên ở đáy thanh bên mở menu tài khoản. Menu có
mục "Bảng điều khiển nền tảng" chỉ khi `platformRole === "PLATFORM_ADMIN"`. Guard của route `/admin` giữ nguyên.

**Route.** `/admin` về `/admin/overview`. `/app` về `/app/home`.

**Thanh bên project** thêm "Kiến trúc" và "Giám sát".

### QĐ-2: Chuẩn thiết kế sửa ở NGUỒN trước — DESIGN.md và bản mẫu, rồi `prototype.css` chép lại nguyên văn

Luật chép nguyên văn (test `design-lint`) và luật "portal.css không màu thô" giữ nguyên. Token mới vì thế vào
`<style>` của `portal-prototype.html`, rồi chép sang `prototype.css`. Thay đổi:

- **(a) Trạng thái ba sắc.** Thêm `--green-ink`, `--amber-ink`, `--red-ink`: chữ trạng thái trên nền `*-soft`,
  đạt 4.5:1. Có đủ ba sắc cho mỗi trạng thái (chính, nền nhạt, chữ đậm), đủ cả sáng lẫn tối.
- **(b) Bảng màu dữ liệu tách khỏi trạng thái.**
  - `--v4` đổi từ sắc 70 (sát sắc 72 của `--amber`: một chuỗi dữ liệu thường bị đọc thành "cảnh báo") sang
    sắc 310.
  - Một biểu đồ tối đa bốn chuỗi. Nhiều workload thì mỗi workload một biểu đồ nhỏ.
  - `--accent` chỉ cho mục đang chọn, nút chính, focus và rollout đang chạy, không bao giờ cho "khoẻ".
- **(c) Khung bảng điều khiển.** Thêm `--console-bg`, `--console-raised`, `--console-line`, `--console-ink`,
  `--console-ink-2` và `--console-active`: tối, sắc 262 nhẹ, khác nền tối của Portal.
- **(d) Đầu phân hệ gọn.**
  - Bỏ nền gradient: §2 của DESIGN cấm gradient trang trí.
  - Bỏ ô icon 40px: §9 cấm "ô icon màu cạnh tiêu đề mục". Thanh bên đã mang icon của phân hệ.
  - Giữ tiêu đề 22px, một câu mô tả và ba chỉ số nhanh bên phải.
  - Component `PageHead` thay markup `.mhead` viết tay ở ~20 trang.
- **(e) Trạng thái không bằng chấm màu** (giữ §5): mỗi ô của lưới sức khoẻ và mỗi nút của sơ đồ dùng icon
  Lucide kèm chữ. Bảng tone duy nhất nằm ở `StatusLabel`.
- **(f) Biểu đồ** (bổ sung §6):
  - Có trục: 3–4 vạch chia, nhãn số theo đơn vị.
  - Thang co theo dữ liệu. Ngưỡng nằm ngoài khung thì ghi ở chú giải ("ngưỡng 5%, cao hơn khung"), không ép
    dữ liệu dẹt xuống đáy như biểu đồ rollout hôm nay.
  - Rê chuột hoặc dùng phím mũi tên hiện đường dọc và tooltip.
  - Mỗi biểu đồ có bảng số liệu thay thế.

### QĐ-3: `GET /projects/:id/architecture` (VIEWER) — sơ đồ ghép từ dữ liệu đã có, cạnh từ CHÍNH resolver

Nguồn, không cần bảng mới:

| Phần        | Nguồn                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud       | Credential đang dùng: provider, vùng, mode, cách xác thực, lần kiểm                                                                                         |
| Cluster     | `clusterAccess`: id, endpoint                                                                                                                               |
| Tài nguyên  | `provisioned_resources` chưa `DELETED`, nhóm theo `step`; tên là đoạn cuối của `idempotencyKey`                                                             |
| Environment | `environments`: id, tên, namespace, production                                                                                                              |
| Workload    | Tên workload khác nhau trong `deployment_events` của từng environment, kèm bản gần nhất (tag, commit, sự kiện, lúc). Không có bảng workload nào khác (§2.2) |
| Công cụ     | Domain đang bật: tool, phiên bản adapter, scope, trạng thái, drift gần nhất, capability cung cấp; bậc = chỉ số trong `order`                                |
| Cạnh        | Hàm thuần `capabilityEdges(adapters, result)` đặt cạnh `validateAndOrder`, ra `{from, to, capabilityId}`                                                    |

Về cạnh: tool tiêu thụ → tool cung cấp ĐÃ ĐƯỢC CHỌN cho capability đó. Tính trên kết quả `chosen` của CHÍNH
`validateAndOrder`, gồm cả `anyOf` và preference. Một đồ thị vừa chặn cấu hình sai vừa được vẽ ra.

Lưới sức khoẻ ở Tổng quan dùng cùng API này: một nguồn, không hai.

### QĐ-4: Giám sát — `GET /projects/:id/metrics/red?envId&range=1h|6h|24h|7d` (VIEWER), chuỗi thời gian qua `MetricsProvider`

**Workload** lấy như QĐ-3.

**Nguồn** là binding `metrics.query`: binding của environment thắng binding của cluster (`metricsSourceFor`).
Đi qua `metricsFor` (proxy API server cho Prometheus trong cụm), cùng đường của gate canary (§7.4).

**Hàm mới trong `MetricsProvider`:** `series(kind, target, {rangeSec, stepSec})`, với `kind` là
`requestRate`, `errorRatio` hoặc `latencyP99`.

- Prometheus dùng `query_range` với CHÍNH khuôn PromQL của §7.4. VictoriaMetrics và Grafana Cloud nói PromQL
  nên đi cùng đường.
- Datadog, New Relic và Dynatrace dùng API chuỗi thời gian của từng nhà.
- Lớp nền SaaS giữ I7: điểm không có dữ liệu là `null`, không bao giờ là 0.
- Bước: 1h → 60s, 6h → 5m, 24h → 15m, 7d → 1h (≤ 169 điểm).

**Khi không đọc được:**

- Không có nguồn: 409, slug `metricsNotEnabled` (cùng khuôn với `costNotEnabled`).
- Cluster không tới được: 503.

**`console`** chỉ cách mở công cụ giám sát:

- Grafana trong cụm: lệnh port-forward. Nó không có địa chỉ công khai, và UDP không mở một địa chỉ như thế.
- Công cụ SaaS: URL suy ra được từ cấu hình (Datadog theo `site`, Dynatrace theo URL môi trường).
- Còn lại: `null`.

**Chi phí.** `GET /cost` thêm `daily[]` (OpenCost/Kubecost `accumulate=false&step=1d`). Tổng là tổng các
ngày, nên một nguồn cho cả hai.

**Lượt đánh giá flag** lấy từ `GET /flags?include=stats` đã có. **DORA** lấy từ `GET /metrics/dora` đã có.

### QĐ-5: `GET /api/v1/home` — một lời gọi cho trang chủ developer

Router mới `home`, `requireAuth`. Không nằm dưới `/projects`, nên luật I10 không áp. Mọi dữ liệu lọc theo
membership của người gọi, trong truy vấn. PLATFORM_ADMIN không có đặc quyền ở đây (như guard của project).

Nội dung:

- **Project:** tên, trạng thái, vai, cloud, số environment, hạn.
- **Rollout** `IN_PROGRESS`/`PAUSED`, tối đa 20: flag hoặc workload, environment, %, trạng thái.
- **Việc cần xử lý:**
  - deploy chờ duyệt (`DEPLOY_PENDING` chưa có sự kiện sau);
  - domain `ERROR`/`BLOCKED`, domain `DRIFTED`;
  - job gần nhất lỗi;
  - project hết hạn trong 48 giờ;
  - rollout tạm dừng.
- **Deploy 14 ngày** theo ngày: thành công và thất bại.

### QĐ-6: Bảng điều khiển nền tảng — `GET /admin/overview` (database) và `GET /admin/platform` (cụm đang chạy UDP)

**`/admin/overview`:**

- người dùng: tổng, quản trị, mới trong 7 ngày;
- project theo trạng thái và theo cloud;
- job theo trạng thái lỗi;
- tài nguyên mồ côi và USD/giờ;
- mười công cụ được bật nhiều nhất;
- deploy 7 ngày;
- dung lượng database (`pg_database_size`).

**`/admin/platform`** đọc Kubernetes API bằng ServiceAccount CHỈ-ĐỌC của Service 1:

| Tín hiệu      | Nguồn                                                               |
| ------------- | ------------------------------------------------------------------- |
| Node          | CPU và RAM đang dùng (metrics-server) so với dung lượng             |
| PostgreSQL    | Dung lượng PVC                                                      |
| Sao lưu       | CronJob `udp-backup`: lịch, lần thành công và lần thất bại gần nhất |
| Chứng chỉ     | Certificate `udp-tls`: hạn, sẵn sàng, issuer                        |
| Bản phát hành | `UDP_RELEASE` (tag commit của bản vm, `local` cho kind)             |

- Mỗi tín hiệu độc lập. Đọc không được thì `null` kèm lý do (`NOT_IN_CLUSTER`, `NOT_CONFIGURED`, `FORBIDDEN`,
  `UNAVAILABLE`). Không bao giờ đoán.
- "Nguy cơ bị thu hồi khi rảnh" so mức CPU và RAM LÚC NÀY với ngưỡng 20% của Oracle, và ghi rõ là lúc này.
- **RBAC thêm ở base:**
  - ServiceAccount `core-backend`.
  - Role trong `udp`: get/list `cronjobs` và `jobs`, get `persistentvolumeclaims` và `certificates`.
  - ClusterRole: get/list `nodes` và `nodes.metrics.k8s.io`.
  - Không secret, không exec.
- **Danh sách quản trị** (người dùng, project, job) thêm `offset` và `total`. Giới hạn ≤ 100 của mỗi trang giữ
  nguyên, nên không còn cắt im lặng ở 100.

### QĐ-7: Màn hình

**Trang chủ** (`/app/home`):

- thẻ project;
- rollout đang chạy;
- việc cần xử lý, mỗi dòng dẫn thẳng tới chỗ sửa;
- biểu đồ cột deploy 14 ngày.

**Tổng quan project:**

- `PageHead`;
- hàng chỉ số;
- thẻ **Cloud**: provider, vùng, cách xác thực, lần kiểm; "Đổi cloud" tới Cài đặt → Cloud, chỉ OWNER;
- **DomainHealthGrid**: mỗi ô là một domain, gồm tên, tool, trạng thái (icon + chữ) và drift; bấm vào tới
  `/domains/:type`;
- **sơ đồ thu nhỏ**: cloud → cluster → environment, có số workload và số công cụ; bấm vào tới Kiến trúc;
- environment, deploy gần nhất, rollout gần đây.

**Kiến trúc:**

- Khung lồng nhau: cloud ⊃ mạng ⊃ cluster ⊃ (công cụ cấp cluster xếp theo bậc) và (từng environment ⊃
  workload và công cụ cấp namespace).
- Cạnh là một lớp SVG phủ, vẽ sau layout (`ResizeObserver`, không đọc layout trong render).
- Rê chuột hoặc focus vào một công cụ làm nổi các cạnh của nó. Bấm vào mở panel: trạng thái, drift, cung cấp,
  cần gì từ ai, link domain.
- Cấu trúc là danh sách lồng nhau có tiêu đề (trình đọc màn hình đọc được). Panel kể quan hệ bằng chữ.
- Dưới 860px ẩn cạnh, quan hệ vẫn ở panel.
- Không thư viện đồ thị: cấu trúc là một cây, cạnh chỉ nối giữa các công cụ.

**Giám sát** (theo environment, `?range=`):

- RED: mỗi workload ba biểu đồ nhỏ;
- lượt đánh giá flag: tổng theo ngày, top flag;
- sức khoẻ domain;
- DORA tóm tắt;
- xu hướng chi phí (MAINTAINER);
- nút "Mở công cụ giám sát".

**Rollout:** biểu đồ dùng `LineChart` chung.

**`/admin/overview`:**

- hàng tín hiệu nền tảng: máy, database, sao lưu, chứng chỉ, bản phát hành, ba service;
- số liệu nền tảng;
- job lỗi;
- tài nguyên mồ côi;
- công cụ dùng nhiều.

### QĐ-8: Component và định dạng dùng chung

**Component:**

- `PageHead`;
- `LineChart` và `BarChart`: SVG, khai ở allowlist `<svg>` của design-lint;
- `Sparkline`: chuyển ra từ FlagsPage;
- `Meter`: thanh mức dùng bằng div;
- `StatusLabel`: một bảng tone → icon, màu, chữ;
- trang `NotFound`.

**Bảng:** `.dtable` cho bảng dữ liệu (căn trái, số căn phải và `tabular-nums`). `.matrix` chỉ còn cho ma trận
thật (hộp promote).

**Định dạng** trong `format.ts`, không còn `toFixed` hay `String(n)` cho số hiển thị:

- `formatUsd`: `Intl`, USD;
- `formatDuration`;
- `compactNumber`: `Intl` `notation: "compact"`;
- phần trăm qua `formatPercent`.

### QĐ-9: Nền — sửa mọi lỗi review đã kiểm chứng, và biến cái kiểm được thành luật

**Không mất dữ liệu:**

- Nháp rule không mất khi bấm Esc, đổi tab environment, `j`/`k` hay `1`–`9`. Những lối này hỏi trước khi bỏ.
- Rời trang khi còn thay đổi: `useBlocker` của router cộng `beforeunload`.
- "Bỏ" có Hoàn tác (DESIGN §7).
- Wizard tạo project giữ bước và id project trong URL.

**Không tác động ngay:**

- Xoá thành viên và đổi vai có Hoàn tác.
- Bỏ đánh dấu Production phải xác nhận.
- Lưu domain khi project đang ACTIVE hiện hộp xác nhận, kê domain sẽ bật, tắt hay đổi tool.

**Bàn phím và trình đọc màn hình:**

- link bỏ qua; tiêu đề không nhảy bậc;
- hàng của Project, Rollout, Segment và Flag là link hay nút thật, không bị role ghi đè; hàng Flag là `Link`,
  vẫn giữ `j`/`k`;
- tab của panel flag có `tabpanel` và phím mũi tên;
- bộ đếm ngược ra khỏi vùng `aria-live`;
- lỗi field nối `aria-describedby` và `aria-invalid`; submit thì focus lỗi đầu tiên;
- thanh tiến độ có `role="progressbar"`;
- ô boolean có nhãn;
- JobLog báo trạng thái;
- bộ chọn environment trả focus;
- bảng lệnh bẫy Tab.

**Khung:**

- hộp thoại giới hạn chiều cao, cuộn bên trong, `overscroll-behavior: contain`;
- toast dài được xuống dòng; toast lỗi 8 giây và dừng khi rê chuột;
- vùng an toàn;
- focus hiện rõ ở ô mô tả rule, ô tag và ô tìm;
- hover cho những nút còn thiếu;
- `touch-action: manipulation`;
- `theme-color`; chủ đề áp trước khi vẽ bằng một tệp script nhỏ (không inline, giữ CSP).

**Quản trị:**

- danh sách có phân trang theo `total`;
- tìm có debounce và giữ dữ liệu cũ; bộ lọc lên URL;
- job lỗi: nhãn tiếng Việt, bước và thông điệp đọc được, JSON thô trong "Chi tiết";
- tiền qua `formatUsd`.

**Chữ:**

- `…` thay cho `...`; placeholder kết thúc bằng `…`;
- `Ctrl K` có khoảng trắng không ngắt, và hiện `⌘ K` trên Mac;
- `translate="no"` cho key và định danh;
- tắt spellcheck ở ô định danh; ô tìm dùng `type="search"`;
- nút gửi không bị khoá trước khi gửi;
- bỏ "(§7.2)" khỏi chữ giao diện;
- danh sách flag có hàng tiêu đề cột;
- nhãn tiếng Việt cho MỌI khoá cấu hình của 72 tool; khoá gốc vẫn hiện bằng mono.

**404:** trang "Không tìm thấy" có đường về. Lỗi 404 của một tài nguyên dẫn về danh sách, không đưa "Thử lại".

**Thành luật lint mới** (`tests/design-lint.test.ts`):

- không có `...` trong chữ giao diện;
- không có `role="listitem"`, `role="option"` hay `role="row"` trên `Link` hoặc `button`;
- mọi khoá cấu hình trong mẫu golden catalog có nhãn tiếng Việt.

### QĐ-10: Bản xem thử có dữ liệu nhiều và đa dạng

Seed tất định (mulberry32, hạt cố định) cho:

- **~130 người dùng**, đủ để phân trang quản trị.
- **~24 project** trên AWS, GCP và Azure, đủ các trạng thái.
- **Mỗi project ACTIVE:**
  - 3–4 environment;
  - 8–16 domain, đủ trạng thái và drift;
  - nhiều workload, flag, rollout và deploy.
- **Chuỗi RED:** theo nhịp ngày, có sự cố lỗi và độ trễ.
- **Tín hiệu nền tảng** của một máy A1.
- **Nhiều job lỗi và tài nguyên mồ côi** trên ba cloud.

Cạnh của sơ đồ tính từ `provides`/`requires` trong mẫu golden catalog: dữ liệu thật của 72 tool, không danh
sách tay. `contract.check.ts` gọi mọi hàm API mới.

### QĐ-11: Cổng chụp màn ở CI

Job `portal-demo`:

1. Build bản xem thử.
2. Chạy Playwright (Chromium) qua ~18 màn ở 1440×900 và 390×844.
3. Kiểm từng màn:
   - không lỗi console;
   - không tràn ngang;
   - có `main` và đúng một `h1`;
   - không "Not Found";
   - không có `...`.
4. Ảnh chụp là artifact.

Không so pixel: font khác máy làm đỏ giả. Ở máy dev chạy bằng Edge sẵn có (`channel: "msedge"`).

### QĐ-12: Chi phí 0 do cấu trúc

| Thứ dùng                                         | Vì sao 0 đồng                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| API mới của Service 1                            | Chạy trong tiến trình đã có, đọc database và cụm đang chạy              |
| RBAC chỉ-đọc, metrics-server                     | Có sẵn trong k3s; kind không có metrics-server thì trả `null` kèm lý do |
| Chuỗi thời gian từ Prometheus hay SaaS của khách | Cụm và tài khoản của khách (BYOC)                                       |
| Job CI `portal-demo`, Playwright                 | Repo public: runner chuẩn miễn phí; Chromium tải trong runner           |

## 3. Rủi ro đã biết

- Số đo RED thật cần một cụm có Prometheus và workload xuất metric (middleware của §7.4). Máy dev không có
  cụm, nên kiểm bằng provider giả và mẫu golden. Chạy thật vào sổ nợ `monitoring-real-cluster`.
- Tín hiệu nền tảng thật cần k3s có metrics-server, CronJob và cert-manager. Job `vm` của CI có đủ, E2E kiểm
  qua HTTPS; máy Oracle thật đã nằm ở `vm-oracle-real`.
- API chuỗi thời gian của ba nhà SaaS chỉ kiểm được bằng response mẫu theo tài liệu của họ. Gọi thật cần khoá
  trả phí: sổ nợ `monitoring-saas-real`.

## 4. Tiêu chí chấp nhận

- **AC-1** `architecture`:
  - Cạnh bằng đúng quan hệ `chosen` của `validateAndOrder`, kể cả `anyOf` và preference (test thuần).
  - Route: 401, 404 với người ngoài; VIEWER đọc được; tài nguyên `DELETED` không hiện; workload lấy bản gần
    nhất.
- **AC-2** `metrics/red`:
  - `series` của Prometheus gọi `query_range` đúng khuôn §7.4 và đúng bước.
  - Ba nhà SaaS parse response mẫu, và điểm rỗng là `null`.
  - Route trả 409 `metricsNotEnabled` khi không có nguồn; `console` đúng theo tool.
  - `cost.daily` cộng lại bằng `totalUsd`.
- **AC-3** `home`: chỉ thấy project của mình, kể cả khi là PLATFORM_ADMIN. Mỗi loại "việc cần xử lý" có test.
- **AC-4** `admin/overview`, `admin/platform`:
  - 401, 403 với USER.
  - Ngoài cụm thì mọi tín hiệu là `null` kèm `NOT_IN_CLUSTER`.
  - Probe giả cho giá trị đúng hình.
  - Kustomize có ServiceAccount và RBAC chỉ-đọc (không `secrets`, không verb ghi).
  - Admin list có `offset` và `total`.
- **AC-5** Mẫu golden cho mọi route mới. `wire-golden` và `contract.check` xanh.
- **AC-6** Portal:
  - Mỗi màn mới có test (msw + mẫu golden).
  - Mọi lỗi của QĐ-9 có test hay luật lint.
  - `design-lint` có ba luật mới.
  - `prototype.css` khớp bản mẫu mới.
- **AC-7** Bản xem thử có đủ màn và dữ liệu của QĐ-10. Job `portal-demo` xanh ở máy dev (Edge).
- **AC-8** Không thoái cấp: mọi test cũ của Portal, Service 1, `metrics-provider` và `@udp/deploy` xanh. Mọi cổng
  xanh: typecheck, lint, format trên tệp đổi, design-lint.
- **AC-9** Thiết kế cập nhật:
  - §9 (endpoint), §10.6, §10.11, §10.13, §10.14;
  - D-P42 trở đi;
  - DESIGN.md;
  - sổ nợ (`monitoring-real-cluster`, `monitoring-saas-real`);
  - bàn giao.
