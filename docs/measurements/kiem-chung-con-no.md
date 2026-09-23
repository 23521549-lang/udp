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

## E3-stats — độ trễ đánh giá khi `reportStats` BẬT (ngưỡng hồi quy R21)

- **Vì sao nợ:** đây là phép đo SO SÁNH hai nhánh của cùng một lưới ô, nên nó thừa
  hưởng đúng vấn đề của E3-quiet: khác biệt cần đo (một `Map.get` + một `Map.set`
  mỗi lượt, không cấp phát chuỗi khoá) ở mức chục nano-giây, còn nhiễu của máy đo
  thiếu RAM đã làm p50 giữa các vòng lệch tới 20%. Đo trên máy nhiễu thì cả hai
  chiều kết luận đều không đứng được. Đường nóng đã được canh bằng CẤU TRÚC thay
  vì bằng số: bộ đếm là `Map<flagKey, Map<variant, number>>` (không nối chuỗi
  `flagKey + "|" + variant` mỗi lượt), và việc đếm nằm SAU khi `ResolutionDetails`
  đã dựng xong, trong `try/catch` riêng (`packages/openfeature-provider/src/stats.ts`,
  `provider.ts` `resolve`).
- **Tiền đề:** như E3-quiet (≥ 4 GiB RAM trống, không phân trang, không IDE nặng),
  và hai nhánh phải chạy TRONG CÙNG một phiên, xen kẽ, không khởi động lại máy
  giữa hai lần — nếu không thì phần chênh đo được là chênh giữa hai trạng thái máy.
- **Lệnh:** hai lần chạy cùng tham số, chỉ khác một cờ:
  `pnpm --filter @udp/experiments e3 -- --report-stats=off --rounds 5 --skip-remote`
  rồi `pnpm --filter @udp/experiments e3 -- --report-stats=on --rounds 5 --skip-remote`
  (mặc định của cờ là `off`, đúng điều kiện đo của Plan 22; `method.reportStats`
  trong file `raw/E3-*.json` ghi nhánh nào).
- **Đạt:** với MỌI ô của lưới, p99 SDK khi bật ≤ p99 SDK khi tắt × 1,10 (R21), và
  p50 SDK khi bật ≤ p50 khi tắt × 1,10. **Không đạt:** ô nào vượt 10% ⇒ dừng, không
  bật `reportStats` mặc định cho tới khi đường nóng được sửa (hướng kế tiếp đã có:
  mảng đếm theo CHỈ SỐ variant dựng sẵn trong `prepared`, bỏ hẳn tra cứu theo
  chuỗi variant).
- **Tài nguyên:** 1 tiến trình Node (`--skip-remote` nên không cần Service 2 và
  không truy vấn database), ~2 phút mỗi nhánh với `--rounds 5`.

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

## E4-segment — lan truyền cấu hình khi delta mang payload segment

- **Vì sao nợ:** E4 trong `raw/` đo delta của một lần BẬT/TẮT flag — payload vài
  trăm byte — nên câu "delta rẻ hơn snapshot" được chứng minh ở đầu NHẸ NHẤT của
  trục. [v4.9] thêm một loại delta có hình dạng ngược lại: `segment.updated` mang
  payload ĐẦY ĐỦ của segment tới MỌI environment của project (§16), tới 4 MiB một
  dòng, và có ngưỡng `CHANGE_FEED.maxDeltaBytes` (8 MiB) để rơi về snapshot với lý
  do `too-large`. Ba con số của E4 — độ trễ, byte trên dây, truy vấn mỗi lần — vì
  thế chưa nói gì về đúng trường hợp mà ngưỡng đó được đặt ra để xử lý. Đo trên máy
  dev thì vô nghĩa với cùng lý do E4-ci, và ở đây còn nặng hơn: phần bị RTT và băng
  thông tải lên lấn át KHÔNG phải một hằng số cộng vào mọi ô — nó tỉ lệ với kích
  thước payload, tức là tỉ lệ với chính biến độc lập của phép đo.
- **Tiền đề:** như E4-ci (runner cùng vùng với database, một job `workflow_dispatch`
  khi CI xong ở #26). Harness cần thêm một trục: lần ghi là `PUT /internal/segments/:id`
  thay vì `PATCH /internal/flag-envs/:id`, trên project 1/5/10 environment × segment
  1 KiB / 1 MiB / ở ĐÚNG trần 4 MiB (`octet_length(conditions::text)`, dựng theo
  đúng cách của `segment-cap-perf` bên dưới).
- **Lệnh:** `pnpm --filter @udp/experiments e4 --runs 50 --baseline 120` sau khi thêm
  cờ `--write=segment --segment-bytes=1024,1048576,4194304 --envs=1,5,10`. Cờ đó CHƯA
  CÓ: `packages/experiments/scripts/e4.ts` hôm nay chỉ có đường ghi flag, và thêm nó
  là phần việc đầu tiên của lần đo này.
- **Đạt:** mọi ô có `timeouts` = 0; ô 1 KiB đi bằng DELTA ở chế độ `delta`; ô 4 MiB ×
  10 environment rơi về snapshot với lý do `too-large` ĐÚNG khi tổng `payload` của lô
  vượt 8 MiB, và lần rơi đó KHÔNG gọi `breaker.recordFallback` (V22,
  `version.watcher.ts`); byte trên dây của nhánh delta ở ô 1 KiB nhỏ hơn nhánh
  snapshot cùng ô. **Không đạt:** ô nào có `timeouts` > 0; hoặc `too-large` mở mạch
  breaker ⇒ dừng và sửa code, vì khi đó ba lần sửa segment lớn liên tiếp tắt tầng 2
  của environment đó 5 phút cho MỌI thay đổi khác (hồi quy D2); hoặc ô 4 MiB làm
  transaction ghi vượt `TRANSACTION_BUDGET.timeout` — đó là `segment-cap-perf`, không
  phải phép đo này, nên hai mục phải được đọc cùng nhau.
- **Tài nguyên:** 1 Service 2 mỗi lúc (~300 MiB) và tới ~45 MiB dữ liệu tạm cho mỗi ô
  lớn (4 MiB × 10 environment nằm trong `config_change_log`, giữ 7 ngày) — phải xoá
  theo ID ngay sau khi đo, như `segment-cap-perf` đã làm, chứ không chờ job dọn; ~30
  phút.

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

## stale-perf — p95 của `/flags/stale` và `/flags?include=stats` ở 864 000 hàng

- **Vì sao nợ:** phần SQL đã đo thật (số dưới đây), nhưng con số CHÍNH THỨC của
  AC-1.13 là p95 **end-to-end HTTP** trên hình học triển khai (service cùng vùng với
  database). Máy đo ở Việt Nam, database Supabase `ap-southeast-1`: mỗi lời gọi tốn
  ~52 ms RTT, và `/flags/stale` chạy 5 truy vấn tuần tự nên riêng RTT đã ~260 ms.
  Không có k6/autocannon trên máy đo để lấy phân vị thật.
- **Đã đo (23/09/2026, 864 000 hàng = 200 flag × 3 env × 2 variant × 30 ngày × 24 giờ,
  `VACUUM (ANALYZE)` xong, mỗi câu 6 lần):**

  | Truy vấn                                                                                  | `Execution Time` (DB) | Tổng thời gian từ máy đo (trung vị) |
  | ----------------------------------------------------------------------------------------- | --------------------- | ----------------------------------- |
  | `staleAggregatesOf` (3 cửa sổ, `GROUP BY flag/env/variant`)                               | 260 ms                | 320 ms                              |
  | `summarySeriesOf` (100 flag, 14 ngày, 1 env)                                              | 163 ms                | 213 ms                              |
  | `firstReportAtOf` (`ORDER BY bucket_hour LIMIT 1`)                                        | 0,06 ms               | 53 ms                               |
  | `staleCandidatesOf` / `liveRolloutsOf` / `environmentTelemetryOf` / `recentEvaluationsOf` | ≤ 0,9 ms              | 53–57 ms                            |

  Cộng lại: `/internal/stale-flags` ≈ **262 ms DB, ~538 ms từ máy đo**;
  `/internal/flag-stats/summary` ≈ **163 ms DB, ~213 ms từ máy đo**.

- **`staleAggregatesOf` đã được sửa, không còn là phần đắt (23/09/2026):** lần đo đầu
  cho câu này 479 ms, và chẩn đoán "không index nào rút ngắn được" là ĐÚNG nhưng
  chưa đủ — chi phí không nằm ở lần quét mà ở KHOÁ GỘP. `GROUP BY 1, 2, 3` trỏ vào
  cột kết quả, tức vào `flag_id::text`/`environment_id::text`, nên mỗi hàng phải
  dựng hai chuỗi 37 byte chỉ để băm. Gộp theo cột `uuid` gốc rồi ép `::text` ở
  1 200 hàng kết quả cho cùng các nhóm ấy (`uuid → text` là đơn ánh) — cùng phân
  hoạch, cùng giá trị, `ORDER BY` giữ nguyên trên cột kết quả nên thứ tự hàng cũng
  y nguyên (đã đối chiếu 1 200 hàng: khớp cả giá trị lẫn thứ tự). Đo xen kẽ V-trước
  / V-sau trong CÙNG một phiên, 12 lần mỗi bên + 3 lần `EXPLAIN (ANALYZE, BUFFERS)`:

  | Câu                        | `Execution Time` (DB, trung vị) | Từ máy đo (trung vị) |
  | -------------------------- | ------------------------------- | -------------------- |
  | `GROUP BY 1, 2, 3` (trước) | 382 ms                          | 446 ms               |
  | `GROUP BY` cột gốc (sau)   | 260 ms                          | 320 ms               |

  Kế hoạch vẫn là `Parallel Seq Scan` + `HashAggregate`, nhưng `width` của hàng vào
  bộ gộp giảm 83 ⇒ 51 byte và lần quét giảm 174 ⇒ 89 ms.

- **Index phủ: ĐÃ THỬ, ĐÃ ĐO, BỊ BÁC — đừng thêm.** Dựng thật
  `(flag_id, environment_id, variant_key, bucket_hour, eval_count)` (64 MB, heap 84 MB)
  và `VACUUM` cho visibility map: Postgres chuyển sang `Index Only Scan` sạch
  (`Heap Fetches: 54`) nhưng chạy MỘT LUỒNG mất **370 ms**, tệ hơn `Parallel Seq Scan`
  260 ms — `max_parallel_workers_per_gather` = 1 vẫn cho lần quét heap thêm một
  worker. Và planner TƯỞNG index rẻ hơn (cost 29 186 < 32 355), nên hễ index tồn tại
  là nó tự chọn kế hoạch chậm hơn. Đường GHI đo cùng phiên (lô 500 hàng, đúng câu
  `upsertStatsSql`): 23 ms DB / 101 ms từ máy đo (nhánh INSERT), 89 ms (nhánh UPDATE)
  — KHÔNG đổi, vì phương án được chọn không thêm index nào, chỉ sửa một dòng
  `GROUP BY`. Không migration, không chi phí ghi, không nợ.

- **Kết luận tạm:** `/flags?include=stats` đạt ngưỡng ở cả hai hình học. `/flags/stale`
  giờ tốn 262 ms DB, tức còn **238 ms dự phòng** trong ngân sách 500 ms cho HTTP và
  mạng trên hình học triển khai (service cùng vùng với database) — đạt với dự phòng
  47%. Phần còn thiếu khi đo TỪ VIỆT NAM (~538 ms) là 5 × ~55 ms RTT tới Singapore,
  thuộc tính của máy đo chứ không của mã. Hướng "đọc Cleanup Center từ hàng rollup
  theo ngày" KHÔNG còn cần thiết và đã rút khỏi bàn.
- **Tiền đề:** runner cùng vùng với database (project `udp-ci`, như E4-ci) và một
  công cụ lấy phân vị HTTP.
- **Lệnh:** dựng dữ liệu bằng 30 câu (mỗi câu một ngày) trên một project dùng-một-lần:
  `INSERT INTO flag_evaluation_stats (id, flag_id, environment_id, variant_key,
eval_count, bucket_hour) SELECT gen_random_uuid(), f.id, e.id, v.k, 1 + (h % 7),
date_trunc('hour', now()) - make_interval(days => $d) + make_interval(hours => h)
FROM feature_flags f JOIN environments e ON e.project_id = f.project_id
CROSS JOIN (VALUES ('on'), ('off')) v(k) CROSS JOIN generate_series(0, 23) h
WHERE f.project_id = $p;` rồi `VACUUM (ANALYZE) flag_evaluation_stats;` — tổng ~75 giây.
  Sau đó đo 200 lần `GET /api/v1/projects/:id/flags/stale` và
  `GET /api/v1/projects/:id/flags?include=stats&envId=…` với VIEWER.
- **Đạt:** p95 ≤ 500 ms cho CẢ HAI route. **Không đạt:** `/flags/stale` > 500 ms trên
  hình học triển khai ⇒ điều tra phần HTTP và 5 lần round trip tuần tự TRƯỚC (DB chỉ
  còn 262 ms trong ngân sách 500 ms); chỉ mở lại quyết định "đọc Cleanup Center từ
  hàng rollup theo ngày" nếu chính SQL vượt ngân sách.
- **Tài nguyên:** ~110 MB dữ liệu tạm trong database (đã xoá sau khi đo: 0 hàng còn
  lại), 1 tiến trình Node cho mỗi service.

## segment-cap-perf — đường ghi segment khi project ở TRẦN 4 MiB với 10 environment

- **Vì sao vẫn nợ:** hai phần sửa của [v4.10] (bên dưới) đã đưa ngưỡng của PUT segment
  về ĐẠT, nhưng ngưỡng "tạo flag < 2 s" VẪN KHÔNG ĐẠT trên máy đo ở Việt Nam: 3 608 ms
  trung vị, trong đó khoảng 1,7 s chỉ là 34 lượt đi về × ~50 ms RTT tới Supabase
  `ap-southeast-1`. Phần còn lại của khoảng cách là BĂNG THÔNG và ĐỘ TRỄ của hình học
  đo, không phải của đường ghi — nên con số CHÍNH THỨC phải đo trên hình học triển khai
  (service cùng vùng với database), đúng lý do của E4-ci và stale-perf.
- **Hình học "ở đúng trần":** trần đo bằng `octet_length(conditions::text)` của jsonb
  (`segment.repository.ts` `payloadBytesOf`, F6/F7). Con số đó dài hơn canonical JSON
  đúng bằng tổng số dấu `,` và `:` (Postgres in thêm một khoảng trắng sau mỗi dấu), nên
  "project ở đúng trần" là 4 194 304 B theo thước ấy: một segment 5 434 userId ký tự BMP
  3 byte (5 432 id dài 256 + 2 id dài 128) = canonical 4 188 868 B, `jsonb::text`
  4 194 304 B. **[v4.10] Đã sửa một lệch thước mà lần đo này phát hiện:** chú thích của
  `SEGMENT.maxProjectBytes` và của `segmentPayloadBytesOf` nói trần đo trên canonical
  JSON trong khi cưỡng chế lại đo trên jsonb, nên một segment có canonical ĐÚNG bằng
  trần vẫn nhận 422 `QUOTA_EXCEEDED` (đã gặp thật ở lần dựng dữ liệu đầu tiên: "sẽ là
  4 199 747 byte"). Sửa ở phía RẺ — phần chữ: thước chính thức là `jsonb::text`, và
  `segmentPayloadBytesOf` được khai đúng vai của nó là CHẶN DƯỚI để từ chối sớm ngoài
  transaction. Không hạ `SEGMENT.maxProjectBytes`, không đổi một dòng cưỡng chế nào.
- **Đã sửa gì (23/09/2026, [v4.10]) — hai phần đúng như "Hướng sửa" của lần đo đầu:**
  1. `snapshot-row.ts` nhận `SnapshotOptions.segments`: khi bên gọi đã có danh sách
     segment của project thì câu lệnh bỏ hẳn subquery segment. Ba hàm dựng `stateOf`
     (`stateFor`, `segmentStateFor`, `unchangedStateOf`) đọc danh sách ở environment
     ĐẦU TIÊN rồi dùng lại cho mọi environment sau. Hash không đổi từng bit: câu lệnh
     lọc `WHERE s.project_id = e.project_id`, giống nhau ở mọi environment của project,
     và bước 1 của ADR-05 đã khoá mọi environment nên không lần ghi segment nào chen
     vào giữa được.
  2. `outbox.ts` bước 4: khi `payload` giống nhau ở mọi environment (đúng với
     `segment.updated`, và với `flag.created`), ghi bằng MỘT câu
     `INSERT ... SELECT ... FROM unnest(env_ids, versions)` — đẩy payload lên dây một
     lần thay vì N. Payload khác nhau thì vẫn một câu cho mỗi environment. Payload
     trùng nội dung giữ cùng MỘT chuỗi trong bộ nhớ, để bước 3 không giữ 40 MiB chuỗi
     sống trong lúc đang khoá cả project.
- **Đã đo (23/09/2026; project 10 environment, 1 segment ở đúng trần; TRƯỚC: 5 mẫu mỗi
  số, SAU: 10 mẫu mỗi số từ hai lần chạy độc lập trên đúng mã đã chốt; cùng script,
  cùng máy, cùng cách đo — transaction bằng `max(now() - xact_start)` trên
  `pg_stat_activity` lấy mẫu mỗi 40 ms từ một kết nối riêng, event loop bằng
  `monitorEventLoopDelay({resolution: 5})` trong CHÍNH tiến trình chạy app Service 2):**

  | Phép đo                                              | TRƯỚC (trung vị [biên])   | SAU (trung vị [biên])      | Ngưỡng   | Kết quả                     |
  | ---------------------------------------------------- | ------------------------- | -------------------------- | -------- | --------------------------- |
  | (a) transaction của MỘT `PUT /internal/segments/:id` | 19 443 ms [17 841–19 961] | **6 435 ms** [5 905–9 334] | < 10 s   | **ĐẠT** (3,02 ×; 10/10 mẫu) |
  | (a') cả lần gọi PUT — chặn trên của transaction      | 20 802 ms [19 332–21 412] | 8 053 ms [7 313–11 670]    | không có | —                           |
  | (b) event loop S2 bị chặn trong một PUT (`max`)      | 62,0 ms [53,3–66,6]       | 184,3 ms [108,9–546,8]     | không có | TĂNG — xem ghi chú          |
  | (b') `mean` của cùng cửa sổ đó                       | 10,3 ms                   | 13,3 ms [11,4–15,8]        | không có | bằng nền của máy (13 ms)    |
  | (c) `snapshotOf` MỘT environment ở trần              | 1 044 ms [661–1 327]      | 891 ms [572–6 547]         | không có | KHÔNG ĐỔI (đúng dự đoán)    |
  | (d) transaction của MỘT `POST /internal/flags`       | 15 383 ms [13 435–17 591] | **3 608 ms** [2 794–4 325] | < 2 s    | **KHÔNG ĐẠT** (1,80 ×)      |
  | (d') cả lần gọi POST flag                            | 15 545 ms [13 654–17 735] | 3 799 ms [2 969–4 481]     | không có | —                           |

  `POST /internal/segments` (tạo segment ở trần): 18 202 ms transaction trước, 6 090 và
  5 531 ms sau (một mẫu mỗi lần chạy).

  Ba ghi chú đọc thẳng từ số, không làm tròn theo hướng có lợi:

  - (b) **tăng thật, và giải thích được**: tổng CPU mỗi lần ghi không đổi (vẫn 10 lần
    dựng + băm snapshot của 10 environment, mỗi cái mang cả 4 MiB segment), nhưng
    transaction ngắn đi 3 lần nên cùng lượng CPU ấy bị nén vào cửa sổ ngắn hơn: các
    khoảng NHÀN vì đang chờ I/O — thứ trước đây chen giữa 10 lần INSERT 4 MiB — đã mất.
    `mean` vẫn bằng nền của máy lúc không làm gì (13 ms), nên đây là đỉnh GC, không phải
    một vòng lặp chặn mới. Không có ngưỡng cho (b); ghi ra vì nó là một đánh đổi thật.
  - (c) **không đổi là ĐÚNG**: `snapshotOf` một environment không nằm trong đường fan-out
    nên không có gì để dùng lại — nó vẫn là một câu lệnh mang cả 4 MiB về. Mẫu 6 547 ms
    là một lần máy đo bị treo (event loop max 1 096 ms trong cùng cửa sổ), giữ trong biên
    thay vì lọc đi.
  - (d) **vẫn không đạt, không có cách nào đọc khác đi**: 3 608 ms so với ngưỡng 2 s.

- **Chi phí còn lại đi đâu (mô hình, cùng số đo thành phần của lần đo đầu):** một lần ghi
  fan-out N = 10 environment tốn `3N + 4` lượt đi về (10 × `UPDATE` version, 10 ×
  `stateOf`, 10 × `UPDATE` hash, 1 × INSERT outbox gộp, `NOTIFY`, COMMIT) ≈ 34 lượt ×
  ~50 ms RTT ≈ **1,7 s** — phần này là ĐỘ TRỄ MẠNG, không rút được bằng code trên hình
  học đo. Cộng 1 lần đọc segment ở trần (~900 ms, còn 9 environment chỉ ~62 ms mỗi cái),
  ~0,5 s CPU băm, và với PUT thì thêm 2 lần `targetOf` kéo 4 MiB `conditions` về JS,
  `UPDATE segments` 4 MiB, 1 dòng outbox 4 MiB (~336 ms, trước là 10 dòng). Tổng khớp
  với 6,4 s (PUT) và 3,6 s (tạo flag) đo được.
- **Tiền đề để đo lại:** runner cùng vùng với database (project `udp-ci`, us-east-1 — như
  E4-ci). Ở đó 34 lượt × ~1 ms ≈ 34 ms thay cho 1,7 s, và `json_agg` segment tính trên
  server đo được 95,8 ms khi không phải qua WAN (so với 948,8 ms có truyền về) — nên cả
  hai ngưỡng dự kiến đạt rộng. Đây là phép đo còn nợ của mục này.
- **Nếu hình học triển khai vẫn không đủ, bước tiếp theo (CHƯA làm, chưa cần cho ngưỡng
  nào hôm nay):** gộp bước 1 thành hai câu — một `SELECT ... FOR UPDATE` có `ORDER BY id`
  (giữ nguyên thứ tự khoá tất định), rồi một `UPDATE ... FROM unnest ... RETURNING` — và
  bước 3 thành một câu `UPDATE ... FROM unnest(ids, hashes)` ⇒ `3N + 4` lượt còn
  khoảng `N + 6`. KHÔNG dùng lại chuỗi canonical của phần segment giữa các environment
  để bớt CPU băm: `config_hash` là băm của snapshot TỪNG environment (R02, I15a) và mọi
  cách chia sẻ đầu vào hàm băm phải chứng minh lại "cùng từng bit" của I15c. Và KHÔNG hạ
  `SEGMENT.maxProjectBytes` — lý lẽ cũ giữ nguyên: muốn đưa (a) xuống dưới 10 s bằng trần
  thì phải hạ tới ~2 MiB, mà dưới 2 600 024 B thì segment ASCII lớn nhất theo trần từng
  segment không còn lưu được vào một project trống.
- **Lệnh:** script đo nằm NGOÀI repo (scratchpad — nó không phải mã sản phẩm), và lần đo
  SAU dùng ĐÚNG script của lần đo TRƯỚC, không sửa một dòng. Dựng lại: một project 10
  environment và một segment có `octet_length(conditions::text)` đúng
  `SEGMENT.maxProjectBytes` (5 432 userId dài 256 ký tự BMP 3 byte + 2 userId dài 128);
  gọi `PUT /internal/segments/:id?projectId=...` trên app Service 2 TRONG TIẾN TRÌNH (để
  `monitorEventLoopDelay` đo đúng event loop của S2), 5 lần, mỗi lần đổi nội dung một ký
  tự để đi qua cả nhánh kiểm rollout; lấy thời gian transaction bằng
  `SELECT max(extract(epoch from (now() - xact_start))) FROM pg_stat_activity` trên MỘT
  kết nối riêng (`pg`, xoá `sslmode` khỏi URL, `ssl: {rejectUnauthorized: false}`), lấy
  mẫu mỗi 40 ms; rồi `snapshotOf` 5 lần và `POST /internal/flags` 5 lần.
- **Đạt:** transaction của PUT segment < 10 s VÀ tạo flag < 2 s, trên hình học triển khai.
  **Trạng thái hôm nay:** PUT ĐẠT ngay trên hình học đo (6 435 ms, mẫu xấu nhất 9 334 ms —
  dự phòng tới `TRANSACTION_BUDGET.timeout` = 20 000 ms nay là hơn 10 giây, thay vì 39 ms
  như lần đo đầu); tạo flag KHÔNG ĐẠT (1,80 ×) và đó là lý do mục này còn nợ. **Mục này
  GIỮ LẠI, không xoá:** một nửa ngưỡng chưa đạt, và cả hai con số chính thức vẫn chờ hình
  học cùng vùng.
- **Tài nguyên:** 1 tiến trình Node (app S2 in-process), chạy được với ~0,9 GiB RAM trống
  và không phân trang; ~3 phút cho một lần chạy đầy đủ. Đã dọn sạch sau mỗi lần chạy (3
  lần đo, mỗi lần xoá theo ID): 0 project `p76*`, 0 flag `p76-*`, 0 segment còn lại của
  phép đo, 0 dòng `config_change_log` của outbox `segment.updated`, 0 dòng `audit_logs`
  `segment.*`, `danglingSegmentRules` = 0; số đếm toàn bảng TRƯỚC = SAU (projects 8,
  environments 17, segments 1, config_change_log 4, audit_logs 4, feature_flags 6).
