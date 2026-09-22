# Sổ nợ kiểm chứng — phép đo cần hạ tầng chưa có trên máy đo

Mỗi mục là một phép đo đã có harness và đã được thiết kế, nhưng CHƯA chạy được (hoặc
chưa chạy được ở hình học chính thức) vì thiếu hạ tầng: cluster, Prometheus, máy
rảnh, hình học CI. Một phép đo chỉ được tính là XONG khi chạy thật và kết quả nằm
trong `raw/`. Báo cáo tiến độ tách bạch hai con số: đã đo thật (bảng ở `README.md`)
và đang chờ ở đây.

Máy đo hiện tại (22/09/2026): Windows 11, i7-12650H, 7,7 GiB RAM (thường chỉ trống
0,4–1,5 GiB, có lúc phân trang nặng), Docker tắt, không có k6/Prometheus/cluster;
database Supabase `ap-southeast-1`.

Mỗi mục có: vì sao nợ, tiền đề, lệnh, dấu hiệu đạt / không đạt, tài nguyên tối thiểu.

---

## E3-quiet — độ trễ đánh giá trên máy rảnh

- **Vì sao nợ:** lần đo E3 trong `raw/` chạy lúc máy dev thiếu RAM (`freeMemoryGiB`
  trong file) — micro-benchmark nhiễu. Kết luận "< 1 ms" đứng được (mọi p99 SDK
  < 1 ms), nhưng số µs chính thức phải từ máy yên.
- **Tiền đề:** ≥ 4 GiB RAM trống, không phân trang (`\Memory\Pages/sec` < 100), đóng
  trình duyệt/IDE nặng; hoặc runner CI.
- **Lệnh:** `pnpm --filter @udp/experiments e3 --rounds 5`
- **Đạt:** mọi ô p99 SDK < 1 000 µs; p50 của từng vòng lệch nhau < 20%.
  **Không đạt:** bất kỳ ô nào p99 SDK ≥ 1 000 µs trên máy yên ⇒ "< 1 ms" bị bác bỏ.
- **Tài nguyên:** 1 tiến trình Node + 1 Service 2 (~300 MiB).

## E4-ci — lan truyền cấu hình ở hình học CI

- **Vì sao nợ:** trên máy dev, RTT tới database Singapore (40–60 ms mỗi truy vấn)
  chiếm phần lớn độ trễ và lấn át khác biệt NOTIFY/không NOTIFY mà E4 muốn chứng minh.
  Số dev-geometry nằm ở `raw/E4-*.json`.
- **Tiền đề:** runner cùng vùng với database (project `udp-ci`, us-east-1) — một job
  `workflow_dispatch` (CI hoàn tất là #26) với secret đã có.
- **Lệnh:** `pnpm --filter @udp/experiments e4 --runs 100 --baseline 120`
- **Đạt:** 12 ô đủ 100 lần, `timeouts` = 0; báo cáo p50/p99 từng ô, truy vấn và byte
  mỗi lần. **Không đạt:** ô nào có `timeouts` > 0 ⇒ điều tra trước khi dùng số.
- **Tài nguyên:** 1 Service 2 mỗi lúc (~300 MiB), ~50 phút.

## E5 — MTTD/MTTR của auto-rollback (ba nhánh)

- **Vì sao nợ:** cần Prometheus + S1 + S2 + S3 + hai instance sample-app + tải 50 rps,
  ≥ 10 lần mỗi ô (4 ô × 3 nhánh); nhánh service-level còn chặn bởi CODE (Service 3
  chưa có executor SERVICE_LEVEL).
- **Tiền đề:** `docs/measurements/E5-preregistration.md` đã commit và không sửa (harness
  tự kiểm); `pnpm dev:infra` (Prometheus); `pnpm db:seed` rồi
  `pnpm --filter @udp/flag-service rehash`; ≥ 2,5 GiB RAM trống.
- **Runbook nhánh flag-level:**
  1. `pnpm dev:infra`; `pnpm dev:core`, `pnpm dev:flags`, `pnpm dev:pd`.
  2. Hai sample-app (cùng `apps/sample-app/.env`, trong đó `CHAOS_ENABLED=true`;
     biến môi trường của tiến trình thắng `.env`): bash
     `PORT=3010 pnpm --filter @udp/sample-app start` và `PORT=3011 …`; PowerShell
     `$env:PORT=3010; pnpm --filter @udp/sample-app start` (mỗi instance một cửa sổ).
  3. Tải chia đều hai instance, chạy trước ≥ 5 phút cho probe pha 1:
     `pnpm --filter @udp/sample-app load --base http://127.0.0.1:3010,http://127.0.0.1:3011 --rps 50 --duration 14400 --users 1000`
  4. Tạo rollout đúng tham số đăng ký trước (in ra id session):
     `pnpm --filter @udp/experiments e5-setup --password <mật khẩu dev seed in ra>`
  5. Một lần đo:
     `pnpm --filter @udp/experiments e5 --session <id> --fault "error-rate?p=0.3&scope=flag-on" --cell 5xx`
     (ô partial: `--app http://127.0.0.1:3011`; ô latency:
     `--fault "latency?ms=800&rampSeconds=60&scope=flag-on"`; đối chứng âm:
     `--fault "error-rate?p=0.3&scope=shared" --cell negative-control`).
  6. Rollback đưa rule về baseline 0% — lặp lại từ bước 4 cho lần sau.
- **Đạt:** ≥ 10 kết quả mỗi ô trong `raw/E5-*.json`, cùng `preregistrationCommit`,
  `clock.stable = true`. **Không đạt / loại:** `clock.stable = false`, `marks.t3` thiếu,
  session không ROLLBACK trong 20 phút — giữ file, ghi lý do loại ở `README.md`.
- **Tài nguyên:** ~2,5 GiB RAM (Prometheus, 3 service, 2 app, tải).

## E6 — gai lỗi thoáng qua không gây rollback

- **Vì sao nợ:** cùng hạ tầng E5.
- **Tiền đề:** như E5; rollout tạo với `maxConsecutiveBreaches` 1 và 2 (sửa
  `e5-setup` qua một amendment của file đăng ký trước, hoặc một file đăng ký riêng).
- **Lệnh:** bơm `POST /chaos/error-rate?p=1` rồi `POST /chaos/reset` sau 10 s, theo dõi
  `rollout_sessions.status` 5 phút.
- **Đạt:** `maxConsecutiveBreaches = 2` ⇒ KHÔNG rollback. **Không đạt:** rollback ở 2.
- **Tài nguyên:** như E5.

## E14-prometheus — dung lượng TSDB và scrape duration

- **Vì sao nợ:** cần Prometheus chạy ≥ 1 giờ mỗi ô (10 ô). Số series, byte exposition
  và thời gian dựng `/metrics` phía app đã đo (`raw/E14-*.json`).
- **Tiền đề:** `pnpm dev:infra`; một app E14 cố định (T, V) chạy tải ổn định.
- **Đo:** `prometheus_tsdb_head_series`, `prometheus_tsdb_storage_blocks_bytes`,
  `scrape_duration_seconds{job="sample-app"}` sau 1 giờ mỗi ô.
- **Đạt:** head series khớp công thức R·S·M·(B+3)·(1+T·V) (đã khớp phía app).
  **Không đạt:** lệch > 1% ⇒ điều tra nhãn Prometheus gắn thêm.
- **Tài nguyên:** Prometheus ~500 MiB–2 GiB tuỳ T.

## I34-cluster — mất mạng trong cluster thật

- **Vì sao nợ:** lần đo `raw/I34-*.json` dùng proxy TCP cục bộ (hố đen giữ kết nối
  nửa mở) và dừng tiến trình Service 2 — đủ cho fail-static và hội tụ; mất mạng thật
  (NetworkPolicy chặn egress của pod) cần cluster.
- **Tiền đề:** cluster có Service 2 và một pod chạy harness.
- **Lệnh:** harness `i34 --outage 300`, host trỏ qua Service trong cluster, ngắt bằng
  NetworkPolicy.
- **Đạt:** `pass = true` ở cả hai pha. **Không đạt:** bất kỳ lần đánh giá sai/lỗi
  trong lúc ngắt, hoặc không hội tụ trong ngưỡng.
- **Tài nguyên:** cluster nhỏ (1 node).
