# E5 — Đăng ký giả thuyết trước (pre-registration)

**Trạng thái:** đóng băng từ commit đầu tiên chứa file này. Harness
`pnpm --filter @udp/experiments e5` TỪ CHỐI chạy nếu file chưa từng được commit
hoặc có sửa đổi chưa commit, và ghi hash commit của file vào mỗi kết quả. Sửa đổi
sau đó chỉ qua mục **Sửa đổi (amendment)** ở cuối — mỗi sửa đổi một commit riêng,
có ngày và lý do, KHÔNG đổi tham số của những lần đã chạy.

Thiết kế: `docs/UDP_design.md` §14 E5 (năm điểm), §13.4 (lưới lỗi), §7.4 (truy vấn),
§16 (giới hạn MTTD). Phép đo này là chứng cứ chính của đóng góp **C1**.

## 1. Câu hỏi và giả thuyết

**Câu hỏi.** Khi code của nhánh mới bị lỗi, auto-rollback mức FLAG (C1) có rút ngắn
thời gian người dùng còn bị ảnh hưởng và số request bị phục vụ nhánh lỗi, so với
auto-rollback mức SERVICE (udp-driven và tool-driven)?

MTTD phân rã thành các thành phần QUAN SÁT được (§5):
`MTTD = scrape_lag + detect + streak_confirm`.

**H1 (phát hiện tương đương).** Ba nhánh dùng cùng tín hiệu (cùng metric, cùng
scrape, cùng cửa sổ) nên phần PHÁT HIỆN chung `scrape_lag + detect` tương đương:
chênh median giữa hai nhánh bất kỳ ≤ 30 s (một `analysis_interval`).

**H1' (xác nhận chuỗi — dự đoán cấu trúc, không phải thắng thua).** Hai bộ đếm
chuỗi khác nhau về ngữ nghĩa: Service 3 chỉ đếm lần vượt thứ hai khi cách lần được
đếm trước ≥ `metric_window_seconds` (60 s — `streakOf` trong `decision.ts`, hai cửa
sổ không chồng lấn), còn Flagger `threshold: 2` đếm hai lần check liên tiếp cách
`interval` (30 s). Dự đoán: `streak_confirm` ≈ 60 s ở hai nhánh do UDP điều khiển
(flag-level, service-level udp-driven) và ≈ 30 s ở tool-driven; MTTD của tool-driven
vì vậy ngắn hơn ~30 s. Chênh lệch này được BÁO CÁO như một đánh đổi của ngữ nghĩa
cửa sổ không chồng lấn (ít báo động giả hơn), KHÔNG tính vào so sánh C1.

**H2 (khắc phục nhanh hơn).** MTTR của flag-level ngắn hơn service-level ít nhất
một bậc độ lớn: flag-level là MỘT lần đổi trọng số qua SSE (< 1 s median dự kiến),
service-level là đổi trọng số traffic + chờ pod ổn định (hàng chục giây).

**H3 (blast radius).** Blast radius đếm trong [T0, T3] nên tỉ lệ với
`MTTD + MTTR`: dự đoán tỉ số blast radius flag-level / service-level bằng tỉ số
`(MTTD + MTTR)` tương ứng, với RPS cố định. Vì MTTD chiếm phần lớn, lợi ích của C1 ở
blast radius NHỎ HƠN ở MTTR — kết quả được báo cáo đúng tỉ lệ đó.

**Bác bỏ khi nào.**

- H1 bị bác bỏ nếu chênh median `scrape_lag + detect` giữa hai nhánh > 30 s — tham
  số hoặc tín hiệu bị lệch: điều tra, báo cáo, chạy lại sau một amendment; KHÔNG
  trình bày như thắng lợi của C1.
- H1' bị bác bỏ nếu `streak_confirm` lệch khỏi dự đoán quá 15 s ở median.
- H2 bị bác bỏ nếu median MTTR flag-level ≥ 1/10 median MTTR service-level.
- H3 bị bác bỏ nếu tỉ số blast radius lệch khỏi tỉ số `(MTTD + MTTR)` quá 25%.

## 2. Tham số cố định (mọi nhánh, mọi lần)

| Tham số                      | Giá trị                                                    | Ghi chú                                                                         |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Prometheus `scrape_interval` | 15 s                                                       | `docker/prometheus.yml`                                                         |
| `metric_window_seconds`      | 60                                                         | ≥ 4 × scrape (validator §2.2)                                                   |
| `analysis_interval_seconds`  | 30                                                         | Flagger `interval: 30s` ở tool-driven                                           |
| `maxConsecutiveBreaches`     | 2                                                          | Flagger `threshold: 2` — ngữ nghĩa khác, xem H1'                                |
| `errorRate`                  | 0,05                                                       | ngưỡng TUYỆT ĐỐI                                                                |
| `latencyP99Ms`               | 500                                                        | 800 ms phải vượt được với bucket [0,5; 1]                                       |
| `minErrors`                  | 5                                                          |                                                                                 |
| `relativeErrorRate`          | 1,5                                                        |                                                                                 |
| `warmUpRequests`             | 100                                                        |                                                                                 |
| Rule được ramp               | `SEED_IDS.ruleCheckoutV2`, baseline on 0% / off 100%       | baseline 0% là ĐIỀU KIỆN của T3 (nhóm dò chỉ rời `on` khi `on` về 0%)           |
| Canary                       | bậc đầu 20% (`stepPercent` 20), `stepIntervalSeconds` 3600 | không promote trong phiên                                                       |
| Tải                          | 50 rps VÒNG MỞ, CHIA ĐỀU 3010/3011 ở MỌI ô                 | `load --base http://127.0.0.1:3010,http://127.0.0.1:3011 --rps 50 --users 1000` |
| Tỉ trọng tải                 | 70% `POST /api/checkout`                                   | mẫu canary/window ≈ 50 × 0,7 × 0,2 × 60 = 420 request > `warmUpRequests`        |
| Bơm lỗi                      | sau `last_step_at + window + scrape_lag + 30 s`            | harness tự chờ                                                                  |
| Nhóm dò                      | 200 user id (`PROBE_USERS`)                                | ≈ 40 ở nhánh `on` tại 20%                                                       |
| Cửa sổ sau quyết định        | 60 s (`--post-seconds`), lỗi VẪN bơm                       | đối chứng âm (§6)                                                               |
| Số lần                       | ≥ 10 mỗi ô (nhánh × lỗi)                                   | median + IQR, KHÔNG trung bình                                                  |

Dựng rollout: `pnpm --filter @udp/experiments e5-setup` — tạo session qua API thật
của Service 1 với đúng các tham số trên.

## 3. Ba nhánh

1. **flag-level (C1)** — rollout FLAG_LEVEL + CANARY trên flag `checkout-v2`; Service 3
   đổi `serve.weights` qua Service 2, SDK nhận qua SSE. T_decision = `last_decision.at`
   của tick ROLLBACK (đồng hồ S3). T3 = `cohort-cleared` của sample-app. Blast radius =
   `servedOn` chốt tại T3.
2. **service-level udp-driven** — hai Deployment (`service_version` cũ/mới), Service 3
   điều khiển trọng số traffic qua Flagger webhook gate (§7.4), cùng tham số §2 (bậc
   20%). T_decision = `last_decision.at` của tick ROLLBACK. T3 = thời điểm request
   CUỐI có `service_version=<mới>` được phục vụ (log truy cập của sample-app theo
   version). Blast radius = số request checkout do pod version mới phục vụ trong
   [T0, T3]. **Chặn bởi code hôm nay:** Service 3 chưa có executor SERVICE_LEVEL
   (Service 1 trả 422) — chạy khi có; định nghĩa trên đã đóng băng.
3. **service-level tool-driven** — Flagger tự phân tích: `interval: 30s`,
   `threshold: 2`, `stepWeight: 20`, `maxWeight: 20`, metric template = truy vấn §7.4
   (errorRate, latencyP99) với cùng ngưỡng. T_decision = thời điểm Flagger ghi
   `status.phase = Failed` (Event "Rolling back", đồng hồ API server — đo lệch như §5).
   T3 và blast radius như nhánh 2.

## 4. Lưới lỗi (§13.4)

| Ô            | Lỗi                                          | Lệnh chaos                                                      | Dự đoán                                                                                                                  |
| ------------ | -------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 5xx          | lỗi 30% ở code MỚI                           | `error-rate?p=0.3&scope=flag-on` ở CẢ hai instance              | ROLLBACK sau 2 lần vượt                                                                                                  |
| latency      | trễ tăng dần tới 800 ms trong 60 s, code MỚI | `latency?ms=800&rampSeconds=60&scope=flag-on` ở cả hai instance | ROLLBACK theo p99; MTTD dài hơn ô 5xx khoảng một nửa thời gian tăng dần                                                  |
| partial      | lỗi 30% ở code MỚI, CHỈ instance 3011        | `error-rate?p=0.3&scope=flag-on` ở 3011                         | tỉ lệ lỗi canary ≈ 15% (tải chia đều) vẫn > 5% ⇒ ROLLBACK; MTTD tương đương ô 5xx (tín hiệu loãng nhưng vẫn vượt ngưỡng) |
| đối chứng âm | lỗi 30% ở code DÙNG CHUNG                    | `error-rate?p=0.3&scope=shared` ở cả hai instance               | xem §6                                                                                                                   |

## 5. Mốc thời gian và phân rã MTTD

Các thành phần chạy trên máy đo (sample-app, Service 1/2/3, harness) dùng đồng hồ
máy. Prometheus chạy trong VM của Docker Desktop — đồng hồ RIÊNG: mỗi lần chạy
harness đo độ lệch (median 5 lần hỏi `time()`, ở đầu và cuối lần chạy), hiệu chỉnh
T_scrape, và đánh dấu lần chạy KHÔNG hợp lệ nếu độ lệch trôi > 250 ms giữa đầu và
cuối. Triển khai phân tán: đo lệch NTP giữa các máy và ghi vào kết quả.

- T0 — `fault-on` trong timeline sample-app.
- T_scrape — `lastScrape` đầu tiên > T0 của ĐÚNG instance bị bơm (đã hiệu chỉnh).
- T_breach1 — `last_decision.at` của tick đầu tiên có `breach = true` (poll 1 s).
- T_decision — theo nhánh (§3).
- T3 — theo nhánh (§3).

Báo cáo: scrape_lag = T_scrape − T0; detect = T_breach1 − T_scrape (lấp cửa sổ +
chờ tick — không tách được bằng quan sát ngoài); streak_confirm = T_decision −
T_breach1; MTTD = T_decision − T0; MTTR = T3 − T_decision; blast radius (§3) kèm ước
lượng đối chiếu `(MTTD + MTTR) × 50 × 0,7 × 0,2`.

## 6. Đối chứng âm — dự đoán đúng theo code

Ngưỡng `errorRate` là TUYỆT ĐỐI (`decision.ts`) nên lỗi ở code dùng chung VẪN làm
nhánh canary vượt ngưỡng ⇒ flag-level VẪN ROLLBACK. Dự đoán: tỉ lệ lỗi người dùng
(checkout, `failedAll / servedAll` của sample-app) trong 60 s TRƯỚC T_decision và 60
s SAU T_decision (lỗi vẫn bơm) chênh ≤ 2 điểm %. Nghĩa là "rollback vô ích" —
flag-level không giúp được lỗi không nằm trong nhánh flag. Kết quả là GIỚI HẠN của
C1 và được báo cáo như vậy.

## 7. Phân tích

Mỗi ô: median và IQR của MTTD, từng thành phần, MTTR, blast radius. So sánh giữa
nhánh bằng median (≥ 10 lần/ô); không kiểm định tham số (phân phối lệch phải, bị
chặn dưới). Mọi lần chạy — kể cả lần hỏng hạ tầng hay lần chạy không hợp lệ vì đồng
hồ — được giữ trong `docs/measurements/raw/E5-*.json`; lần bị loại phải ghi lý do
trong `docs/measurements/README.md`.

## Sửa đổi (amendment)

Khuôn cho mỗi sửa đổi (một commit riêng, thêm vào cuối, không sửa mục cũ):

> **A<n> — <ngày>.** Lý do: … · Thay đổi: … · Commit: … · Những lần chạy bị ảnh hưởng:
> (các file `raw/E5-*.json` đã chạy trước sửa đổi giữ nguyên, báo cáo tách riêng).

_(chưa có)_
