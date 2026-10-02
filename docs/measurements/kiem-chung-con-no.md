# Sổ nợ kiểm chứng — phép đo cần hạ tầng chưa có trên máy đo

Mỗi mục là một phép đo đã có harness và đã được thiết kế, nhưng CHƯA chạy được (hoặc
chưa chạy được ở hình học chính thức) vì thiếu hạ tầng: cluster, Prometheus, máy
rảnh, hình học CI. Một phép đo chỉ được tính là XONG khi chạy thật và kết quả nằm
trong `raw/`. Báo cáo tiến độ tách bạch hai con số: đã đo thật (bảng ở `README.md`)
và đang chờ ở đây.

Máy đo hiện tại (22/09/2026): Windows 11, i7-12650H, 7,7 GiB RAM (thường chỉ trống
0,4–1,5 GiB, có lúc phân trang nặng), Docker tắt, không có k6/Prometheus/cluster;
database Supabase `ap-southeast-1`.

Mỗi mục có **sáu** trường: vì sao nợ, tiền đề, lệnh, dấu hiệu đạt / không đạt, tài
nguyên tối thiểu, và **ảnh hưởng tới kết luận nào**. Trường thứ sáu là trường quan
trọng nhất của một sổ nợ: nó nói món nợ này làm câu nào trong luận văn yếu đi, nên
đọc sổ là biết ngay điều gì đang được tuyên bố mà chưa được đo.

**Số mục hiện tại: 49.** Con số này được một phép kiểm của `design-lint` đối chiếu
với số mục đếm được trong chính tệp, và đối chiếu với hai nơi khác trích mã nợ:
`docs/UDP_design.md` (§16, dạng `Sổ nợ: \`mã\``) và chú thích trong mã nguồn (cùng
dạng). Một mã nợ được nhắc ở hai nơi kia mà không có mục ở đây là một lời hứa không
có địa chỉ.

---

## E2 — provisioning time theo từng cloud

- **Vì sao nợ:** [Plan #50] E2 đo thời gian dựng network / cluster / domain trên BA cloud thật (§14.1), mà
  yêu cầu cứng của dự án là chi phí hạ tầng đúng 0 (D-P37): EKS, GKE và AKS đều tính tiền theo giờ, và
  không bản giả lập nào (LocalStack, kind) có thời gian dựng của control plane thật. Harness chưa viết: số
  đo phụ thuộc hoàn toàn vào nhà cung cấp, nên viết nó trước khi có tài khoản là viết mò.
- **Tiền đề:** ba tài khoản cloud có ngân sách (hoặc credit), quyền dựng VPC + cluster; chấp nhận chi phí
  — tức một quyết định của người dùng thay đổi yêu cầu chi phí 0.
- **Runbook:** (1) viết `packages/experiments/scripts/e2.ts` gọi Luồng 2 qua API thật của Service 1 cho một
  project mới trên mỗi cloud, ghi mốc bắt đầu/kết thúc của từng `ProvisionStep` (network / cluster /
  domain) từ event store; (2) 3 lần mỗi cloud, cùng cấu hình; (3) teardown sau mỗi lần và xác nhận
  `provisioned_resources` rỗng (I31) trước lần sau.
- **Đạt:** 9 lần hoàn tất; báo trung vị và khoảng biến thiên từng pha, tách riêng chi phí `lookup()`
  (§4.5). **Không đạt:** lần nào không hội tụ ⇒ báo cáo như kết quả, không chạy lại cho tới khi xanh.
- **Tài nguyên:** ba cluster nhỏ nhất của từng cloud, mỗi lần ~20–40 phút; tiền thật.
- **Ảnh hưởng tới kết luận:** số nền "dựng hạ tầng mất bao lâu" và phần so sánh ba Cloud Adapter. Không
  đóng góp nào (C1–C3) dựa vào E2 (§14.1 "Bản đồ phép đo theo đóng góp"), nên luận văn trình bày Luồng 2
  bằng test tích hợp và lưới crash (I31-localstack), không bằng số thời gian.

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
- **Ảnh hưởng tới kết luận:** số µs chính thức của **E3**. Kết luận "đánh giá cục bộ dưới 1 ms" vẫn đứng (mọi p99 SDK đo được đều < 1 ms), nhưng con số nêu trong luận văn phải từ máy yên, nếu không nó là một con số về máy đo chứ không về hệ thống.

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
- **Ảnh hưởng tới kết luận:** ngưỡng hồi quy **R21** và quyết định có bật `reportStats` mặc định. Chưa đo thì mặc định phải là TẮT.

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
- **Ảnh hưởng tới kết luận:** số chính thức của **E4** và câu "delta rẻ hơn snapshot". Số dev-geometry đủ để so hai nhánh với nhau nhưng không đủ để nêu như độ trễ của hệ thống.

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
- **Ảnh hưởng tới kết luận:** phạm vi của kết luận **E4**: hiện nó chỉ được chứng minh ở đầu nhẹ nhất của trục payload, tức chưa nói gì về đúng trường hợp mà ngưỡng `maxDeltaBytes` được đặt ra để xử lý.

## E5 — MTTD/MTTR của auto-rollback (ba nhánh)

- **Vì sao nợ:** cần Prometheus + S1 + S2 + S3 + hai instance sample-app + tải 50 rps,
  ≥ 10 lần mỗi ô (4 ô × 3 nhánh). [Plan #51] Executor SERVICE_LEVEL đã có (Argo Rollouts và
  Flagger, udp-driven và tool-driven); hai nhánh service-level còn cần một cluster có công cụ đó
  (mục `service-level-cluster`). Câu "chặn bởi code" trong `E5-preregistration.md` là trạng
  thái LÚC ĐĂNG KÝ — tệp đó không sửa (sửa là một amendment).
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
- **Ảnh hưởng tới kết luận:** đóng góp **C1** ở phần số liệu: MTTD/MTTR và blast radius so với Flagger/Argo Rollouts. Cơ chế đã chạy và có test tích hợp, nhưng **so sánh** ba nhánh là phần chưa có số.

## service-level-cluster — rollout SERVICE_LEVEL trên cluster có Argo Rollouts / Flagger thật

- **Vì sao nợ:** [Plan #51] Service 1 ghi `Rollout`/`Canary` và Service 3 promote/abort qua
  `rollouts/status` (hay trả lời gate của Flagger) đều đã có test — trên cụm GIẢ (`FakeCluster`:
  merge patch, 409 theo `resourceVersion`, subresource status). Chưa có lần chạy nào với controller
  thật: hình CR đúng tài liệu của Argo Rollouts/Flagger nhưng chưa được chính chúng chấp nhận; RBAC
  `rollouts/status: patch` của `udp-traffic` chưa được API server thật xác nhận là ĐỦ cho promote.
  Cụm kind của CI không giúp được: route token của S1 cần một cluster do Cloud Adapter dựng.
- **Tiền đề:** một cluster mà `ClusterAccess` chế độ `direct` vào được (cùng tiền đề với
  `I32-cluster`), đã bootstrap ba SA (§12.2); Istio + Argo Rollouts (hoặc một mesh + Flagger)
  bật qua domain; Prometheus scrape workload mang `service_version`; `PD_CONTROLLER_WEBHOOK_URL`
  trỏ Service 3 mà cluster gọi tới được (Flagger).
- **Runbook:** (1) deploy workload qua Luồng 3 (Argo: workload là `Rollout` có
  `trafficRouting.istio`; Flagger: `Deployment` + `Canary` đã `Initialized`); (2) tạo rollout
  SERVICE_LEVEL ở Portal cho mỗi ô làm được của ma trận §7.2 (6 ô Argo, 4 ô Flagger); (3) theo dõi
  tới DONE; lặp lại với tải lỗi (`CHAOS_ENABLED`) để thấy ROLLBACK; (4) bật audit log của API server
  và lọc theo `udp-traffic`.
- **Đạt:** mọi ô làm được tới DONE không can thiệp tay; một lần promote udp-driven = đúng MỘT bậc
  của Rollout; ROLLBACK đưa traffic về phiên bản cũ; audit log chỉ có `patch rollouts/status` và
  `virtualservices` từ `udp-traffic` (I25). **Không đạt:** API server trả 403 cho patch status
  (RBAC thiếu), Rollout kẹt `pause: {}` sau promote, Flagger không gọi gate.
- **Tài nguyên:** một cluster ≥ 3 node nhỏ + Istio (~2 GiB) + Argo Rollouts/Flagger; tiền thật nếu
  là cloud (trái D-P37) — hoặc một cluster tự dựng có API endpoint cho S1.
- **Ảnh hưởng tới kết luận:** hai nhánh service-level của **E5** (so C1 với Flagger/Argo) và câu
  "UDP điều khiển được Argo Rollouts/Flagger mà không tranh control loop" (ADR-01, I4, I5) — hôm
  nay là bảo đảm của mã và test trên cụm giả, chưa phải của một lần chạy.

## E6 — gai lỗi thoáng qua không gây rollback

- **Vì sao nợ:** cùng hạ tầng E5.
- **Tiền đề:** như E5; rollout tạo với `maxConsecutiveBreaches` 1 và 2 (sửa
  `e5-setup` qua một amendment của file đăng ký trước, hoặc một file đăng ký riêng).
- **Lệnh:** bơm `POST /chaos/error-rate?p=1` rồi `POST /chaos/reset` sau 10 s, theo dõi
  `rollout_sessions.status` 5 phút.
- **Đạt:** `maxConsecutiveBreaches = 2` ⇒ KHÔNG rollback. **Không đạt:** rollback ở 2.
- **Tài nguyên:** như E5.
- **Ảnh hưởng tới kết luận:** câu "auto-rollback không nhạy quá mức" — tức đối chứng ÂM của C1. Thiếu nó thì E5 chỉ chứng minh hệ thống biết rollback, không chứng minh nó biết KHÔNG rollback.

## E9 — tài nguyên tiêu thụ của UDP

- **Vì sao nợ:** [Plan #50] harness đã có (`pnpm --filter @udp/experiments e9`: Summary API của kubelet,
  pha rỗi và pha 1 000 SDK nối SSE bằng SERVER key seed) và chạy mỗi đêm ở job `kind` của CI, nhưng một
  phép đo chỉ XONG khi kết quả nằm trong `raw/` — artifact của runner chưa được commit lần nào (máy dev
  không có Docker để chạy tại chỗ). Nhánh **100 rollout đồng thời** chưa có harness: trần
  `MAX_TRACKED_FLAGS_PER_ENV = 3` (§6.6) buộc ≥ 34 environment, mỗi cái một workload có lưu lượng để qua
  probe pha 1 — hơn 34 pod ứng dụng mẫu cộng tải, quá sức runner miễn phí 7 GiB. Hai điểm ADR-05 hẹn "đo
  ở E9" (nhược điểm 7: CPU của `config_hash` ở env hàng nghìn flag; nhược điểm 10: khoá toàn cục của
  `NOTIFY` dưới tải ghi) cũng chưa có pha: cần một env lớn và một luồng ghi đều mà seed không có.
- **Tiền đề:** một lượt `schedule` hoặc `workflow_dispatch` của CI xanh ở bước E9; với nhánh rollout và hai
  pha ADR-05, một máy ≥ 16 GiB có Docker (runner lớn hơn là trả tiền — trái D-P37).
- **Lệnh:** CI chạy `pnpm --filter @udp/experiments e9` sau `pnpm deploy:up`; tải artifact `E9-<run_id>`
  (`gh run download <run_id> -n E9-<run_id> -D docs/measurements/raw`) rồi commit nó.
- **Đạt:** `streams.snapshots` = 1 000 và `aliveAtEnd` = 1 000; mọi container của ba service có
  `cpuMillicoresMean` khác `null` ở cả hai pha (không restart giữa pha). **Không đạt:** harness thoát mã
  1 khi không mở đủ 1 000 stream — không ghi số; `aliveAtEnd` < 1 000 ⇒ điều tra trước khi dùng số.
- **Tài nguyên:** cụm kind của `deploy:up` (~2,5 GiB) + 1 tiến trình Node giữ 1 000 socket; ~8 phút.
- **Ảnh hưởng tới kết luận:** câu "UDP vận hành được trên một máy nhỏ" (§14.1 "tính khả thi vận hành") và
  hai giảm thiểu của ADR-05 (nhược điểm 7 và 10) đang được nêu mà chưa có số. Thiếu số, luận văn chỉ nêu
  được `requests`/`limits` đã khai trong manifest — một con số về cấu hình, không về hệ thống.

## E14-prometheus — dung lượng TSDB và scrape duration

- **Vì sao nợ:** cần Prometheus chạy ≥ 1 giờ mỗi ô (10 ô). Số series, byte exposition
  và thời gian dựng `/metrics` phía app đã đo (`raw/E14-*.json`).
- **Tiền đề:** `pnpm dev:infra`; một app E14 cố định (T, V) chạy tải ổn định.
- **Đo:** `prometheus_tsdb_head_series`, `prometheus_tsdb_storage_blocks_bytes`,
  `scrape_duration_seconds{job="sample-app"}` sau 1 giờ mỗi ô.
- **Đạt:** head series khớp công thức R·S·M·(B+3)·(1+T·V) (đã khớp phía app).
  **Không đạt:** lệch > 1% ⇒ điều tra nhãn Prometheus gắn thêm.
- **Tài nguyên:** Prometheus ~500 MiB–2 GiB tuỳ T.
- **Ảnh hưởng tới kết luận:** phần chi phí quan sát của **E14**: cardinality cộng thêm đã tính được bằng công thức và đo được phía ứng dụng, nhưng dung lượng TSDB và scrape duration là số phía Prometheus.

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
- **Ảnh hưởng tới kết luận:** bất biến **I34** ở hình học thật. Bản đã đo dùng hố đen mạng và một lần Service 2 chết trên cùng một máy; mất mạng trong cluster thật có thêm DNS và kube-proxy.

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
- **Ảnh hưởng tới kết luận:** ngưỡng p95 của hai endpoint danh sách ở quy mô 864 000 hàng, tức câu "Portal vẫn dùng được khi project lớn".

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
- **Ảnh hưởng tới kết luận:** trần 4 MiB của segment: nó được cưỡng chế bằng CHECK và bằng phép kiểm, nhưng ĐƯỜNG GHI ở đúng trần đó chưa được đo cùng ngân sách transaction.

---

# Plan #24 — Adapter framework

Mười tám mục dưới đây đến từ một chỗ duy nhất: **hợp đồng adapter được thiết kế để
chạy trên cloud thật và cluster thật, còn máy đo không có cả hai.** Điều đó loại bỏ
**phép đo** và **lần chạy lại trên hạ tầng thật**, không loại bỏ một luật, một ô hay
một phương thức nào — mọi hành vi đều đã chạy trên cloud mô phỏng (§13.2) và trên
`ClusterAccess` giả, với lưới K1..K10 ở hai tầng và bộ hợp đồng 42 phép cho bốn
adapter.

## I31-localstack — lưới K1..K10 trên LocalStack

- **Vì sao nợ:** lưới giết tiến trình cần một cloud có hành vi lỗi ĐIỀU KHIỂN ĐƯỢC
  (nhất quán cuối của tagging, `DependencyViolation` khi xoá VPC, phân trang dở,
  `indeterminate` khi tra cứu). Cloud mô phỏng của §13.2 cho đúng những hành vi đó
  và chạy trên máy 7,7 GiB RAM không Docker; LocalStack cần Docker engine.
- **Tiền đề:** Docker engine chạy + ≥ 2,5 GiB RAM trống. LocalStack bản miễn phí
  KHÔNG có EKS, nên ô cluster của lưới vẫn phải mô phỏng hoặc chuyển sang
  `I31-aws`.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- grid-tier2` với
  `UDP_CLOUD_DRIVER=localstack` (biến đó CHƯA CÓ: nó là phần việc đầu tiên của lần
  chạy này, và nó chỉ đổi adapter được nạp chứ không đổi harness).
- **Đạt:** cả 10 điểm crash cho cùng kết cục như trên cloud mô phỏng, và mỗi ô có ít
  nhất một lượt `PrismaLedger` thật. **Không đạt:** ô nào lệch ⇒ chỗ lệch là một hành
  vi cloud mà mô phỏng đoán sai, và nó phải được sửa vào mô phỏng chứ không vào
  adapter.
- **Tài nguyên:** Docker + LocalStack (~1,2 GiB) + 1 tiến trình Node.
- **Ảnh hưởng tới kết luận:** độ trung thực của **I31** và của **E15**. Lưới trên
  cloud mô phỏng chứng minh máy trạng thái khôi phục đúng theo ĐẶC TẢ hành vi cloud;
  nó không chứng minh đặc tả đó khớp một hiện thực cloud độc lập.

## I31-aws — lưới K1..K10 trên AWS thật

- **Vì sao nợ:** cần tài khoản AWS có ngân sách; một lượt lưới tạo và xoá VPC, NAT
  gateway, EKS cluster và nodegroup. [v4.11] Adapter AWS THẬT đã có
  (`@udp/cloud-adapters/aws`: qua 38/38 phép hợp đồng trên SimCloud, cổng SDK kiểm ở
  tầng command) — phần còn nợ chỉ là chạy nó trên tài khoản thật.
- **Tiền đề:** tài khoản AWS + hạn mức chi + credential có đủ 14 quyền mà
  `preflightPermissions` liệt kê.
- **Lệnh:** như `I31-localstack` với `UDP_CLOUD_DRIVER=aws`.
- **Đạt:** 10 điểm crash cho cùng kết cục; sau mỗi ô, `orphan-scan` trả về rỗng.
  **Không đạt:** còn tài nguyên mồ côi sau teardown ⇒ đó là tiền thật của khách, và
  nó là lỗi nặng nhất mà hợp đồng adapter có thể có.
- **Tài nguyên:** ~2 USD/lượt (NAT gateway theo giờ là phần đắt nhất) + 1 tiến trình
  Node.
- **Ảnh hưởng tới kết luận:** **C3** ở dạng mạnh nhất của nó, và cả hình dạng tag
  `kubernetes.io/cluster/*` mà `k8s-managed-discovery` đang nợ.

## I31-gcp — lưới K1..K10 và một vòng đời GKE trên GCP thật

- **Vì sao nợ:** cần một project GCP có billing. [v4.11, Plan #26 P3] Adapter GCP THẬT
  đã có (`@udp/cloud-adapters/gcp`: qua 38/38 phép hợp đồng trên SimCloud với tính chất
  gắn label ĐÚNG của GCP — chỉ cluster có label; cổng REST kiểm bằng Google giả ở tầng
  request; đổi token `GCP_WIF`/`GCP_KEY` kiểm chữ ký JWT thật). Thứ HTTP giả không kiểm
  được: hình dạng operation thật của Compute, thời gian tạo GKE, và việc Workload
  Identity Federation của khách chấp nhận token OIDC do UDP ký (sau P5).
- **Tiền đề:** project GCP + billing + service account có đủ quyền mà
  `GCP_REQUIRED_PERMISSIONS` liệt kê; Compute, Container, IAM, IAM Credentials, STS và
  Cloud Resource Manager API đã bật.
- **Lệnh:** như `I31-localstack` với `UDP_CLOUD_DRIVER=gcp`.
- **Đạt:** 10 điểm crash cho cùng kết cục; sau mỗi ô, `orphan-scan` trả về rỗng; label
  đọc lại từ GKE giải mã về đúng tag chuẩn. **Không đạt:** còn tài nguyên mồ côi, hoặc
  Google từ chối một label mà `gcpLabelCodec.problems` cho qua.
- **Tài nguyên:** ~1,5 USD/lượt (phí quản lý cluster GKE + Cloud NAT theo giờ) + 1 tiến
  trình Node.
- **Ảnh hưởng tới kết luận:** **C3** trên cloud thứ hai — bằng chứng rằng lõi điều phối
  không mang giả định riêng của AWS (tag lúc tạo, id do cloud cấp).

## I31-azure — lưới K1..K10 và một vòng đời AKS trên Azure thật

- **Vì sao nợ:** cần một subscription Azure có ngân sách. [v4.11, Plan #26 P4] Adapter
  Azure THẬT đã có (`@udp/cloud-adapters/azure`: qua 38/38 phép hợp đồng trên SimCloud;
  cổng ARM kiểm bằng ARM giả ở tầng request — không PUT đè, gỡ NAT khỏi subnet trước khi
  xoá, phân trang `nextLink` chỉ trên host ARM; đổi token `AZURE_FEDERATED` /
  `AZURE_SECRET` / IMDS). Thứ ARM giả không kiểm được: độ trễ lan truyền của managed
  identity sang Entra ID (role assignment có thể nhận `PrincipalNotFound` vài chục giây
  đầu — cổng phân loại là `dependency`), thời gian tạo AKS, và việc app registration của
  khách chấp nhận token OIDC do UDP ký (sau P5).
- **Tiền đề:** subscription + một resource group dành cho UDP; service principal có
  Contributor, Role Based Access Control Administrator (giới hạn ở Network Contributor)
  và Azure Kubernetes Service RBAC Cluster Admin trên resource group — đủ các quyền mà
  `AZURE_REQUIRED_PERMISSIONS` liệt kê; provider `Microsoft.ContainerService`,
  `Microsoft.Network`, `Microsoft.ManagedIdentity` đã đăng ký.
- **Lệnh:** như `I31-localstack` với `UDP_CLOUD_DRIVER=azure`.
- **Đạt:** 10 điểm crash cho cùng kết cục; sau mỗi ô, `orphan-scan` trả về rỗng — kể cả
  node resource group `MC_*` do AKS sinh. **Không đạt:** còn tài nguyên mồ côi, hoặc
  teardown dừng ở NAT gateway/Public IP vì "đang dùng".
- **Tài nguyên:** ~1,5 USD/lượt (AKS tier Standard + NAT gateway theo giờ) + 1 tiến
  trình Node.
- **Ảnh hưởng tới kết luận:** **C3** trên cloud thứ ba — nơi tạo là PUT tạo-hoặc-cập-nhật
  và mọi DELETE là bất đồng bộ, hai tính chất mà AWS và GCP không có ở cùng dạng.

## E15 — đối chứng Terraform và Pulumi trên cùng lưới

- **Vì sao nợ:** phép đo cần hai binary (`terraform`, `pulumi`) và một cloud chạy
  được lưới, tức nó bị chặn sau `I31-localstack` hoặc `I31-aws`.
- **Tiền đề:** như trên, cộng cùng một hạ tầng đích được mô tả bằng ba cách (UDP
  adapter, HCL, Pulumi TypeScript) — ba bản mô tả phải tương đương, và việc chứng
  minh chúng tương đương là một phần của phép đo.
- **Lệnh:** `pnpm --filter @udp/experiments e15` (script CHƯA CÓ).
- **Đạt:** với mỗi điểm crash, ghi lại: có khôi phục tự động được không, có cần can
  thiệp tay không, và có tạo trùng tài nguyên không. **Không đạt:** không có ngưỡng
  đạt/không đạt — E15 là một MA TRẬN, và một ô mà UDP xử lý kém hơn Terraform là một
  kết quả phải báo cáo, không phải một test đỏ.
- **Tài nguyên:** như `I31-*` + hai binary.
- **Ảnh hưởng tới kết luận:** **C3** chuyển từ một lập luận ("state file không biết
  đủ") thành một vị trí có số liệu. Thiếu E15 thì luận điểm vẫn đứng bằng lý lẽ và
  bằng lưới của chính UDP, nhưng không có đối chứng ngoài.

## I32-cluster — `ClusterAccess` trên cluster Kubernetes thật

- **Vì sao nợ:** `createDirectClusterAccess` đã tách `KubeTransport` và `TokenSource`
  nên đường xác thực, bộ nhớ đệm token và `objectPath` kiểm được bằng transport giả.
  Thứ KHÔNG kiểm được bằng giả: hình dạng lỗi thật của API server (410 Gone khi
  watch hết hạn, 429 kèm `Retry-After`), và `TokenRequest` thật.
- **Tiền đề:** `kind` hoặc `k3d` một node (~3 GiB RAM) + Docker.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- cluster-access.real`
  (tệp CHƯA CÓ; nó dùng lại đúng các phép kiểm của `cluster-access.test.ts`, chỉ đổi
  transport).
- **Đạt:** `probe` trả `reachable: true` kèm `serverVersion`; `read` trên đối tượng
  không tồn tại trả `null` chứ không ném; `write("delete")` hai lần liên tiếp đều
  thành công (idempotent). **Không đạt:** bất kỳ lời gọi nào ném với một hình lỗi mà
  hiện thực giả không dựng được ⇒ thêm hình đó vào fake trước khi sửa code.
- **Tài nguyên:** Docker + kind (~3 GiB) + 1 tiến trình Node.
- **Ảnh hưởng tới kết luận:** **ADR-06** và bất biến **I24** (bound token 1 giờ,
  không bao giờ xuống đĩa). Cùng mã nợ `clusteraccess-direct` được nhắc trong
  `cluster-access.ts`.
- **[v4.11, Plan #28] Mở rộng:** trên cùng cluster đó, chạy thêm ba thứ mà Plan #28 chỉ
  kiểm được bằng transport giả tầng HTTP: (1) `egressTransport` — undici `Agent` tin CA
  của chính cluster, qua egress guard; (2) `tokenRequestSource` — `TokenRequest` thật cho
  từng SA, và API server TỪ CHỐI khi SA `udp-traffic` sửa `deployments` (I25); (3)
  `bootstrapManifests` áp bằng server-side apply hai lần liên tiếp ⇒ lần hai không đổi gì,
  NetworkPolicy chặn pod env khác gọi vào. Đạt: cả ba; không đạt: bất kỳ Role nào bị API
  server từ chối lúc áp ⇒ bảng §12.2 thiếu quyền mà test thuần không thấy.
- **[v4.11, Plan #39] Mở rộng:** Service 1 đo Prometheus trong cluster thay Service 3 qua
  `proxyService` (`createMetricsFor` + `ClusterAccessCache`, D-P30). Trên cluster đó: cài
  `prometheus-grafana`, gọi `POST /internal/environments/:envId/metrics` ⇒ mẫu `hasData: true`
  đúng series của workload; thu hồi token (xoá SA rồi tạo lại) ⇒ lời đo kế tiếp 401, bản nhớ bị
  bỏ, lời sau nữa dựng lại truy cập và có dữ liệu. Không đạt: `services/proxy` bị RBAC từ chối
  cho `udp-traffic` ⇒ §12.2 thiếu quyền trên service của nguồn metrics.
- **[v4.11, Plan #40] Mở rộng:** thêm rồi bớt một environment trên project đang chạy (job
  `ENVIRONMENT_APPLY`). Đạt: namespace mới có NetworkPolicy, ResourceQuota, `udp-registry-pull`;
  instance database theo env mới chạy; bớt env thì instance Helm của nó biến mất khỏi `udp-system`
  (kho `<release>-instances`) và namespace bị xoá. Không đạt: xoá namespace bị từ chối với token
  quản trị của cloud ⇒ đổi đường xoá.

## E16 — ma trận drift, đối chứng Helm và Argo CD

- **Vì sao nợ:** ba trong bốn thứ E16 đo đã có số trên thế giới mô phỏng (có phát
  hiện được không, diff có chỉ đúng chỗ không, hành vi mặc định là báo cáo hay tự ghi
  đè — xem `day2-drift.test.ts`, lưới 5 sửa đổi + ô âm). Hai thứ còn thiếu cần cluster
  thật: **độ trễ phát hiện**, và lưới trên đối tượng THẬT do chart render ra
  (Deployment, image tag) thay vì trên đối tượng tương đương mà adapter tự ghi.
- **Tiền đề:** cluster (`I32-cluster`) + Argo CD (~1,5 GiB thêm) + Helm.
- **Lệnh:** `pnpm --filter @udp/experiments e16` (script CHƯA CÓ).
- **Đạt:** với mỗi loại sửa đổi, ba cơ chế được ghi: phát hiện/không, độ trễ, và hành
  vi mặc định. **Không đạt:** không có ngưỡng — E16 là phép đo, và điều nó phải cho
  thấy là **một lựa chọn có vị trí**: Argo CD tự sync, Helm chỉ biết khi có người chạy
  `diff`, UDP phát hiện mà không tự sửa.
- **Tài nguyên:** cluster + Argo CD + Prometheus không cần.
- **Ảnh hưởng tới kết luận:** nửa Domain Adapter của **C3** và chiều (a) của **I32**
  ở dạng mạnh nhất. Chiều (c) ("không bao giờ tự sửa") KHÔNG nợ: nó được cưỡng chế ba
  tầng và có phép kiểm ba chu kỳ trên database thật.

## I25-cluster — audit log của API server

- **Vì sao nợ:** I25 nói ba bên ghi vào cluster nhưng không bao giờ chồng quyền. Phần
  "không chồng quyền" kiểm được bằng hằng số `IDENTITY_SERVICE_ACCOUNTS` và bằng
  `ClusterAccess` giả (identity bị từ chối thì không có client). Phần "API server
  cưỡng chế" thì chỉ audit log của API server nói được.
- **Tiền đề:** cluster có audit policy bật, ghi ra file đọc được.
- **Lệnh:** chạy một lượt deploy đầy đủ rồi `grep` audit log theo `user.username`.
- **Đạt:** mọi dòng ghi của lượt deploy mang đúng SA `udp-tooling`; không dòng nào
  mang `udp-workload` hay `udp-traffic`. **Không đạt:** một dòng sai SA ⇒ có một
  đường trong mã nghiệp vụ lấy client bằng identity khác, và nó không lộ ra ở test
  đơn vị.
- **Tài nguyên:** cluster (~3 GiB).
- **Ảnh hưởng tới kết luận:** **I25**, và qua đó là mô hình multi-tenancy của §12.

## I24-cluster — `TokenRequest` thật

- **Vì sao nợ:** `TokenSource` là một cổng, và hiện thực giả trả một token tĩnh. Hạn
  một giờ, việc xin lại trước hạn, và "không bao giờ ghi xuống đĩa" kiểm được bằng
  cách đếm lời gọi và đọc bộ nhớ đệm trong closure; nhưng hạn THẬT do API server cấp.
- **Tiền đề:** cluster.
- **Lệnh:** như `I32-cluster`, thêm một phép kiểm đọc `exp` của token.
- **Đạt:** `exp - iat` = 3600 giây; token thứ hai được xin trước hạn; không có token
  nào xuất hiện trong `audit_logs`, trong log, hay trong `cloud_credentials`.
  **Không đạt:** một token nằm trong bất kỳ nơi nào ở trên ⇒ vi phạm I24 trực tiếp.
- **Tài nguyên:** cluster.
- **Ảnh hưởng tới kết luận:** **I24**.

## preflight-confidence — `preflightPermissions` đo đúng `exact` hay `heuristic`

- **Vì sao nợ:** hàm trả về một danh sách quyền còn thiếu kèm một mức TIN CẬY. Phân
  biệt `exact` (API cloud nói thẳng) với `heuristic` (suy từ một lời gọi thử) chỉ
  kiểm được khi có một credential **bị gỡ quyền có chủ đích**.
- **Tiền đề:** tài khoản cloud thật + một IAM user thiếu đúng một quyền đã biết.
- **Lệnh:** `POST /projects/:id/cloud/preflight` với credential đó.
- **Đạt:** quyền bị gỡ nằm trong danh sách trả về, và `confidence` đúng với cách đã
  suy ra nó. **Không đạt:** danh sách rỗng ⇒ preflight cho cảm giác an toàn sai, và
  đó là kiểu sai tệ nhất cho một hàm tên là "preflight".
- **Tài nguyên:** tài khoản cloud (không tốn tiền: chỉ gọi API mô tả quyền).
- **Ảnh hưởng tới kết luận:** câu "UDP nói trước cho bạn biết thiếu quyền gì" ở §4.4.

## getkubeauth-that — `getKubeAuthToken` với STS/OAuth/AAD thật

- **Vì sao nợ:** ba cloud cấp token cho kubeconfig theo ba cách khác nhau
  (`aws eks get-token`, OAuth của GCP, AAD của Azure). Hiện thực giả trả token tĩnh
  nên đường ký và đường đổi token chưa chạy thật.
- **Tiền đề:** tài khoản của ít nhất một cloud.
- **Lệnh:** một script gọi `getKubeAuthToken` rồi dùng token đó `GET /version`.
- **Đạt:** API server nhận token. **Không đạt:** 401 ⇒ đường ký sai, và nó chỉ lộ ra
  ở đây.
- **Tài nguyên:** tài khoản cloud + cluster của cloud đó.
- **Ảnh hưởng tới kết luận:** tính khả thi của ADR-06 chế độ `direct` trên cả ba
  cloud, tức phần "pluggable" của trục Cloud Adapter.

## k8s-managed-discovery — hình dạng tag `kubernetes.io/cluster/*` thật

- **Vì sao nợ:** teardown có thứ tự dựa trên việc PHÁT HIỆN được ELB/ENI/EBS do
  Kubernetes sinh ra, và cách phát hiện là quét tag `kubernetes.io/cluster/<name>`.
  Cloud mô phỏng gắn đúng tag đó vì nó được viết như vậy; AWS thật gắn tag theo phiên
  bản cloud-controller-manager, và có tài nguyên chỉ mang `kubernetes.io/cluster/x =
owned` còn có tài nguyên mang `shared`.
- **Tiền đề:** AWS thật + một cluster có Service LoadBalancer và một PVC.
- **Lệnh:** `listTaggedResources` rồi so với `aws elbv2 describe-tags`.
- **Đạt:** mọi ELB/ENI/EBS thuộc cluster đều được phát hiện, kể cả `shared`.
  **Không đạt:** sót một tài nguyên ⇒ `DeleteVpc` thất bại vĩnh viễn và khách tiếp
  tục bị tính tiền — đúng kịch bản §4.5 mô tả.
- **Tài nguyên:** như `I31-aws`.
- **Ảnh hưởng tới kết luận:** ví dụ cụ thể nhất của **C3** ("state file không biết
  đủ"), và nó là ví dụ mà phản biện sẽ hỏi trước tiên.

## estimatecost-vs-bill — `estimateCost` so với hoá đơn thật

- **Vì sao nợ:** hàm bắt buộc trả ba mục và tổng theo giờ; số của nó lấy từ bảng giá
  cứng trong adapter. Chỉ một tháng chạy thật nói được sai số.
- **Tiền đề:** một project chạy liên tục ≥ 30 ngày trên tài khoản thật.
- **Lệnh:** so `estimateCost` lúc provision với Cost Explorer sau 30 ngày.
- **Đạt:** sai số ≤ 20% cho tổng. **Không đạt:** > 20% ⇒ bảng giá hoặc mô hình sử
  dụng sai, và phải nói rõ con số thật trong luận văn thay vì bỏ mục này.
- **Tài nguyên:** tài khoản cloud + 30 ngày.
- **Ảnh hưởng tới kết luận:** phần "bảo vệ chi phí" của §4.4. Cơ chế (từ chối trước
  khi gọi cloud, TTL, orphan-scan) đã có test; ĐỘ CHÍNH XÁC của con số thì chưa.

## clusteraccess-direct — chế độ `direct` chạy thật (mã nợ nhắc trong mã nguồn)

- **Vì sao nợ:** trùng tiền đề với `I32-cluster` nhưng phạm vi hẹp hơn: mục này chỉ
  hỏi "đường vào cluster có chạy không", còn `I32-cluster` hỏi cả hình dạng lỗi.
  Giữ hai mã vì chú thích trong `cluster-access.ts` đã trỏ vào mã này.
- **Tiền đề:** như `I32-cluster` (kind/k3d một node + Docker).
- **Lệnh:** như `I32-cluster`.
- **Đạt:** `probe` trả `reachable: true`; một lượt deploy đầy đủ của một adapter thật
  chạy hết. **Không đạt:** bất kỳ lời gọi nào ném ⇒ đường vào cluster chưa chạy thật.
- **Tài nguyên:** như `I32-cluster`.
- **Ảnh hưởng tới kết luận:** như `I32-cluster`.

## quota-lb-webhook — trần load balancer cần admission webhook

- **Vì sao nợ:** `ResourceQuota` được cưỡng chế TRƯỚC mọi lời gọi cloud, nên một
  adapter không tạo được nhiều LB hơn trần. Nhưng một `Service` kiểu `LoadBalancer`
  do **workload của tenant** tạo ra làm cloud-controller-manager tạo một ELB mà không
  đi qua adapter nào — và trần của UDP không thấy nó.
- **Tiền đề:** cluster + quyền cài admission webhook.
- **Lệnh:** tạo `maxLoadBalancers + 1` Service LoadBalancer bằng `kubectl`.
- **Đạt:** webhook từ chối Service thứ `n+1` kèm thông điệp nêu trần. **Không đạt:**
  ELB thứ `n+1` được tạo ⇒ trần chi phí bị vượt qua bằng một đường mà UDP không canh,
  và đó là tiền của khách.
- **Tài nguyên:** cluster + webhook (~100 MiB).
- **Ảnh hưởng tới kết luận:** phạm vi chính xác của "bảo vệ chi phí" ở §4.4: hiện nó
  đúng cho tài nguyên **UDP tạo**, không cho tài nguyên **workload tạo**. Câu đó phải
  được nói đúng như vậy chừng nào mục này còn nợ.

## cred-federation — Federation (STS/OIDC) đã có mã, chưa chạy với cloud thật

- **Vì sao nợ:** [v4.11, Plan #26 P5–P6] Cả ba nhánh federation đã hiện thực và chạy
  qua `POST /projects/:id/cloud/validate`: `AWS_ROLE` (AssumeRole + ExternalId =
  HMAC theo project), `GCP_WIF` (token OIDC do Service 1 ký ⇒ STS ⇒
  `generateAccessToken`), `AZURE_FEDERATED` (client assertion là token OIDC của UDP).
  Service 1 phục vụ discovery + JWKS; token ký kiểm được bằng CHÍNH JWKS công bố
  (test thuần + tích hợp); resolver xoá payload giải mã ngay sau khi đổi token (AC-9).
  Thứ chưa kiểm được: một cloud THẬT tin issuer công khai của UDP — cần URL công khai
  mà máy dev không có.
- **Tiền đề:** Service 1 có URL https công khai (`UDP_OIDC_ISSUER`) + khoá ký; một
  tài khoản mỗi cloud đã cấu hình theo đúng khối lệnh mà `GET /cloud/setup` sinh ra;
  với AWS, Service 1 chạy dưới principal `UDP_AWS_PRINCIPAL_ARN`.
- **Lệnh:** `PUT /projects/:id/cloud` với `authKind` federation, rồi
  `POST /projects/:id/cloud/validate` và `/cloud/preflight`.
- **Đạt:** validate `valid: true` cho cả ba cloud, `expiresAt` của credential ≤ 1 giờ,
  và xoá federated credential / trust policy phía khách làm lần validate kế tiếp trả
  `valid: false` (thu hồi không cần xoay khoá). **Không đạt:** cloud từ chối token vì
  lệch `iss`/`aud`/`sub` ⇒ khối lệnh setup hoặc claim của token sai — sửa ở
  `cloud.setup.ts` / `oidc.issuer.ts`, không nới điều kiện phía khách.
- **Tài nguyên:** ba tài khoản cloud (không tạo tài nguyên tính tiền) + một endpoint
  công khai.
- **Ảnh hưởng tới kết luận:** mô hình đe doạ của §4.3. Chừng nào mục này còn nợ, câu
  "UDP không giữ bí mật dài hạn của khách" đúng về THIẾT KẾ và về mã đã kiểm bằng cổng
  giả, nhưng chưa có bằng chứng từ một cloud thật chấp nhận token của UDP.

> **Đã trả (25/09/2026, Plan #29):** `drift-scan-cron` — lịch `udp-drift-scan` của pg-boss
> (6 giờ) quét mọi project `ACTIVE`; ba lượt trên một domain đang trôi ghi `last_error` đúng
> MỘT lần, adapter theo namespace được hỏi ở mọi environment
> (`provision-job.integration.test.ts`, AC-7). Cùng đợt: lịch TTL (`project-ttl.integration.test.ts`)
> và orphan-scan (AC-6), job TEARDOWN + `DELETE /projects/:id` dọn hạ tầng.

> **Đã trả (26/09/2026, Plan #30):** `domain-day2-route` — `POST /projects/:id/domains/:type/drift`
> (quét ngay, đồng bộ, cùng `scanDomainDrift`) và `POST …/upgrade` (409 khi rollout đang chạy
> hay đã mới nhất, 428 khi production chưa gõ tên domain, 202 kèm job `DOMAIN_APPLY` thật),
> cùng `PUT /domains` cho project ĐANG chạy ⇒ job áp năm CASE của §8.2 (đổi tool blue/green:
> dựng mới → healthcheck → binding → `onDependencyChanged` mọi env → gỡ cũ). Bằng chứng:
> `provision-job.integration.test.ts` (DOMAIN_APPLY + HTTP Plan #30), `domain-apply-plan.test.ts`,
> `domain.test.tsx`. Hạ về bản cũ khi nâng cấp hỏng vẫn là nợ `upgrade-rollback-that`; chạy
> trên cluster thật là `I32-cluster`.

## upgrade-rollback-that — hạ về bản cũ cần instance adapter bản cũ

- **Vì sao nợ:** `upgradeDomain` gọi `rollback()` như một CỔNG, vì `target` là adapter
  bản MỚI và lớp nền Helm từ chối một `fromVersion` không phải version của chính nó —
  nó từ chối đúng. Người gọi thật phải giữ được instance adapter bản cũ, và registry
  hôm nay chỉ nạp MỘT version cho mỗi `(domainType, toolId)`.
- **Tiền đề:** registry nạp được nhiều version của cùng một adapter, hoặc image giữ
  lại bản cũ.
- **Lệnh:** một test tích hợp nâng cấp thất bại rồi khẳng định chart trên cluster giả
  trở về đúng nội dung của bản cũ.
- **Đạt:** nội dung sau rollback khớp bit-đối-bit nội dung trước nâng cấp. **Không
  đạt:** khác ⇒ trạng thái lửng lơ mà quy tắc thứ ba của §8.6 cấm, và `ROLLBACK_FAILED`
  hiện chỉ báo được rằng nó đã xảy ra, không sửa được nó.
- **Tài nguyên:** không.
- **Ảnh hưởng tới kết luận:** quy tắc thứ ba của §8.6. Hai kết cục (`ROLLED_BACK` và
  `ROLLBACK_FAILED`) đã tách bạch và có test; điều chưa có là một người gọi thật hạ
  được về bản cũ.

## helm-real — Helm thật thay cho hai đối tượng mô phỏng

- **Vì sao nợ:** lớp nền `HelmBasedAdapter` ghi hai đối tượng (`HelmRelease` và một
  ConfigMap giá trị) qua `ClusterAccess`, và trong thế giới mô phỏng đó là toàn bộ sự
  thật. Trên cluster thật, `helm upgrade --install` render chart thành hàng chục đối
  tượng, chờ CRD sẵn sàng, và có hình lỗi riêng (`another operation in progress`,
  release ở trạng thái `pending-upgrade`). Vòng đời của lớp nền chưa gặp những hình đó.
- **Tiền đề:** cluster (`I32-cluster`) + Helm, hoặc Flux với `HelmRelease` thật.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- helm.real` (tệp CHƯA CÓ; nó dùng
  lại đúng 42 phép của bộ hợp đồng, chỉ đổi `ClusterAccess` sang cluster thật).
- **Đạt:** cả 42 phép xanh với chart Prometheus thật, và `detectDrift` sau `deploy`
  trả `false` (không trôi giả vì chart tự thêm nhãn). **Không đạt:** trôi giả ngay sau
  deploy ⇒ `ignoredKeyPrefixes` khai thiếu, và đó đúng là thứ chỉ cluster thật dạy được.
- **Tài nguyên:** cluster + Helm (~3 GiB).
- **Ảnh hưởng tới kết luận:** độ trung thực của "bốn adapter qua đủ 42 phép". Bộ hợp
  đồng chứng minh lớp nền đúng theo ĐẶC TẢ của `ClusterAccess`; nó không chứng minh đặc
  tả đó khớp Helm thật.

## saas-metrics-real — nguồn metrics SaaS trên tài khoản thật

- **Vì sao nợ:** ba `MetricsProvider` SaaS (Datadog Metrics Query API v1, NRQL qua
  NerdGraph của New Relic, Metrics API v2 của Dynatrace — Plan #31) được kiểm trước một
  `fetch` giả trả đúng hình API trong tài liệu của từng nhà cung cấp. Cái giả không kiểm
  được **quy ước thu thập**: tên metric và tên nhãn mà agent của từng nhà cung cấp tạo ra
  khi scrape `/metrics` của Golden Path (`udp.<metricBase>` + `kube_namespace` ở Datadog,
  `<metricBase>_count` + `namespace` ở New Relic, `k8s.namespace.name` ở Dynatrace), và
  cách mỗi bên lưu nhãn rỗng `ff=""`.
- **Tiền đề:** tài khoản dùng thử của ba nhà cung cấp; một cluster (`I32-cluster`) chạy
  sample-app với agent tương ứng (adapter Monitoring của Plan #31); khoá đặt qua Portal
  (bí mật của tool, không qua `.env`).
- **Lệnh:** `pnpm --filter @udp/metrics-provider test -- saas.real` (tệp CHƯA CÓ; nó chạy
  đúng bốn truy vấn phân tích và `probe()` của mỗi provider trên dữ liệu thật, song song
  với PromQL trên cùng lưu lượng).
- **Đạt:** với cùng cửa sổ, `requestCount`/`errorCount` của mỗi nguồn SaaS lệch PromQL
  ≤ 5%, p99 lệch ≤ 10%; series tổng không đếm lặp (`ff` rỗng loại đúng); `probe()` pha 2
  thấy nhãn `ff` của flag. **Không đạt:** truy vấn trả rỗng trên dữ liệu có thật ⇒ quy
  ước thu thập sai, sửa ngôn ngữ truy vấn của provider đó.
- **Tài nguyên:** cluster (~3 GiB) + ba tài khoản SaaS dùng thử.
- **Ảnh hưởng tới kết luận:** câu "auto-rollback không chỉ chạy với Prometheus" của §5.4
  và đóng góp **C1** ở phía nguồn metrics: cơ chế chọn nguồn theo binding đã có test tích
  hợp, còn độ đúng của từng ngôn ngữ truy vấn trên dữ liệu thật là phần chưa đo.

## saas-logs-real — đích log SaaS trên tài khoản thật

- **Vì sao nợ:** năm provider `logs.sink@1` gửi ra ngoài cluster (Splunk HEC, Datadog intake qua
  adapter Datadog Logs và adapter Datadog của Monitoring, New Relic Log API, Dynatrace log
  ingest) cùng output tương ứng của Fluent Bit và Fluentd (Plan #32) chỉ được kiểm ở dạng cấu
  hình render ra — plugin nào, khoá qua `secretKeyRef` nào. Log có thật sự tới nơi, đúng index
  và đúng nhãn hay không thì chỉ tài khoản thật trả lời được.
- **Tiền đề:** cluster (`I32-cluster`) + Helm thật (`helm-real`); tài khoản dùng thử Splunk
  Cloud, Datadog, New Relic, Dynatrace; khoá đặt qua Portal (bí mật của tool).
- **Lệnh:** `pnpm --filter @udp/core-backend test -- logs.real` (tệp CHƯA CÓ; nó bật từng cặp
  forwarder × sink trên sample-app, phát một dòng log có chuỗi canh rồi truy vấn API tìm kiếm
  của nhà cung cấp).
- **Đạt:** chuỗi canh xuất hiện ở mỗi đích trong ≤ 2 phút, mang nhãn namespace và workload;
  khoá không xuất hiện trong ConfigMap hay log của pod forwarder. **Không đạt:** thiếu ở đích
  nào ⇒ sửa output của forwarder cho giao thức đó.
- **Tài nguyên:** cluster (~3 GiB) + bốn tài khoản SaaS dùng thử.
- **Ảnh hưởng tới kết luận:** câu "forwarder gửi được tới BẤT KỲ provider `logs.sink` nào" của
  Plan #32: hợp đồng dây và việc chọn plugin đã có test, còn đường đi thật tới từng nhà cung cấp
  là phần chưa đo.

## agent-mode — chế độ `agent` của ADR-06

- **Vì sao nợ:** `ClusterAccess` có `mode: "direct" | "agent"` và mọi luồng nghiệp vụ
  đi qua interface đó, nên đổi chế độ không chạm nghiệp vụ — đúng như ADR-06 thiết kế.
  Hiện thực `agent` (một `udp-agent` giữ stream gRPC ra ngoài cho tenant không cho phép
  API server có endpoint public) thì chưa có.
- **Tiền đề:** một cluster không mở API server ra ngoài + một service gRPC của control
  plane.
- **Lệnh:** chạy đúng bộ `cluster-access` với `mode: "agent"`.
- **Đạt:** mọi phép kiểm của chế độ `direct` cho cùng kết quả ở chế độ `agent` — đó là
  điều kiện để câu "đổi chế độ không chạm luồng nghiệp vụ" có nghĩa. **Không đạt:** một
  phép nào lệch ⇒ interface đang rò chi tiết của chế độ ra ngoài.
- **Tài nguyên:** cluster + agent (~3,5 GiB).
- **Ảnh hưởng tới kết luận:** nửa còn lại của **ADR-06**. Phần đã làm chứng minh
  interface đủ cho `direct`; nó chưa chứng minh interface đủ cho cả hai.

## cicd-webhook-real — webhook từ sáu CI thật và deploy trên cluster thật

- **Vì sao nợ:** sáu adapter CI/CD (Plan #36) qua bộ hợp đồng và bộ phép CI/CD dùng chung —
  chữ ký đúng/sai/lệch độ dài, thân mẫu, template — trên thân do CHÍNH test ký; luồng webhook
  (401 đồng nhất, 413, chống trùng, chờ duyệt) chạy trên database thật; luồng deploy chạy trên
  client Kubernetes giả trả trạng thái workload theo kịch bản. Chưa đo: template sinh ra chạy
  thật ở GitHub Actions, GitLab CI, CircleCI, Jenkins, Tekton, Drone và gọi về UDP qua Internet
  (biến môi trường của từng CI, `jq`/`openssl` có sẵn trên runner); merge patch và điều kiện
  `resourceVersion` trên API server thật; `ProgressDeadlineExceeded` do controller thật ghi;
  `phase` của Argo Rollouts; target Deployment do Flagger giữ `replicas: 0` (lời phán "xong"
  của S1 khi đó chỉ nghĩa là ảnh đã được nhận).
- **Tiền đề:** cluster (`I32-cluster`) có một Deployment mẫu (và một `Rollout` khi bật Argo
  Rollouts); UDP có địa chỉ công khai (tunnel); repo thử ở sáu nhà cung cấp, secret webhook
  dán vào biến `UDP_WEBHOOK_SECRET`.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- cicd.real` (tệp CHƯA CÓ; nó đẩy một
  commit vào repo thử ở từng CI rồi chờ `DEPLOY_SUCCESS` cùng `commitTimestamp`, sau đó đẩy
  một ảnh hỏng và chờ `DEPLOY_FAILURE` + `ROLLBACK`).
- **Đạt:** mỗi CI: một `DEPLOY_START` + một `DEPLOY_SUCCESS` cùng `deploymentId`, lead time
  tính được; ảnh hỏng ⇒ workload về ảnh cũ trong hạn + FAILURE + ROLLBACK; chạy lại pipeline
  cho `deploymentId` mới, gửi lại cùng thân ⇒ `duplicate`. Port, env, probe của container giữ
  nguyên sau patch. **Không đạt:** chữ ký của một CI không qua ⇒ sửa bước "báo UDP" của template
  đó; container mất trường ⇒ patch sai hình.
- **Tài nguyên:** cluster (~3 GiB) + tài khoản miễn phí ở năm CI dịch vụ, Jenkins/Tekton/Drone
  cài bằng chính adapter.
- **Ảnh hưởng tới kết luận:** AC-3 và AC-4 của Plan #36 ở hạ tầng thật, và **E10** (DORA tính từ
  dữ liệu vận hành của chính UDP): đến khi mục này đo xong, lead time và tần suất deploy chỉ được
  chứng minh trên sự kiện do test ghi.

## iac-security-real — IaC và máy quét trên cloud và CI thật

- **Vì sao nợ:** mười bốn adapter của Plan #37 qua bộ hợp đồng trên cluster mô phỏng, và bước
  pipeline của sáu tool chạy trong CI được kiểm ở dạng văn bản template (đúng pha, đúng thứ tự,
  bí mật chỉ bằng TÊN, backend khoá theo environment). Chưa đo: operator thật (Crossplane với
  provider family, ACK qua IRSA trên EKS, Config Connector qua Workload Identity trên GKE — cài
  bằng bundle, ASO cùng cert-manager trên AKS) tạo được tài nguyên cloud từ CR; `terraform
plan/apply`, `pulumi preview/up`, `ansible-playbook --check` chạy trong sáu CI với backend thật
  và khoá ghi đồng thời; Trivy/Snyk/Aqua/Falco sinh báo cáo thật; Grype chặn một image có lỗ hổng;
  ZAP quét một URL thật; và tên giá trị Helm của các chart thương mại (Aqua `kube-enforcer`).
- **Tiền đề:** `I32-cluster` + `helm-real` trên đủ ba cloud; tài khoản dùng thử Snyk và Aqua; repo
  thử có mã Terraform/Pulumi/Ansible tối thiểu; bucket state ở mỗi cloud.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- iac-security.real` (tệp CHƯA CÓ; nó bật từng
  tool trên cluster thật, áp một CR mẫu hay đẩy một commit, rồi đọc kết quả ở cloud/nhà cung cấp).
- **Đạt:** mỗi operator tạo và xoá được một tài nguyên mẫu; hai pipeline đồng thời trên cùng
  environment thì một bên chờ khoá state; state của `dev` và `prod` nằm ở hai khoá khác nhau; mỗi
  máy quét cho ít nhất một phát hiện trên mẫu có lỗi cài sẵn và pipeline hỏng đúng lúc. **Không
  đạt:** tên giá trị Helm sai ⇒ sửa `values` của adapter đó; bước không chạy được trên một CI ⇒ sửa
  cách CI đó dựng bước.
- **Tài nguyên:** ba cluster (~3 GiB mỗi cluster, lần lượt) + tài khoản CI và SaaS dùng thử.
- **Ảnh hưởng tới kết luận:** câu "mọi tool của §5.5 có adapter" của Plan #37 đứng ở mức hợp đồng
  và văn bản template; việc tool thật làm đúng việc của nó trên hạ tầng thật là phần chưa đo.

## db-cost-real — database theo environment và chi phí thật trên cluster

- **Vì sao nợ:** sáu adapter Database và hai adapter Cost (Plan #38) qua bộ hợp đồng với HAI
  environment trên cluster mô phỏng; CR của operator viết rõ trong mã và được kiểm ở dạng giá
  trị; route chi phí được kiểm với cổng proxy giả trả dữ liệu đúng hình `/allocation`. Chưa đo:
  operator thật dựng instance từ CR trong namespace env (tên service và Secret mà operator thật
  sinh — CloudNativePG `-rw`/`-app`, MongoDB `-svc`/`<resource>-<db>-<user>`, MySQL Router, OT
  Redis, K8ssandra `-superuser`, MinIO `config.env`), chart `raw` render `templates` với
  `secretValuesFrom`, dữ liệu `/allocation` thật của OpenCost/Kubecost khi cluster có tải và
  giá cloud công khai theo region.
- **Tiền đề:** `I32-cluster` + `helm-real`; Prometheus trong cluster (Monitoring); ba environment.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- db-cost.real` (tệp CHƯA CÓ; nó bật từng
  operator, chờ instance sẵn sàng ở mỗi namespace env, kết nối bằng Secret mà binding trỏ tới, rồi
  đọc `GET /cost` sau một giờ tải mẫu).
- **Đạt:** mỗi env một instance nối được bằng thông tin của binding; production có số bản sao đã
  khai; mật khẩu `dev` khác `prod`; chi phí theo env khác 0 và tổng xấp xỉ chi phí node trong cửa
  sổ. **Không đạt:** tên service/Secret lệch ⇒ sửa `instanceBindings` của adapter đó.
- **Tài nguyên:** cluster ~6 GiB (mọi operator lần lượt) + Prometheus.
- **Ảnh hưởng tới kết luận:** câu "mọi tool của §5.5 có adapter" đứng ở mức hợp đồng; database
  thật theo environment và số chi phí thật là phần chưa đo.

> **Đã trả (26/09/2026, Plan #36):** `cicd-adapter` — sáu adapter hiện thực
> `CicdDomainAdapter`; mọi `verifySignature` đi qua `constantTimeEquals` (kiểm độ dài rồi
> `timingSafeEqual`). Bằng chứng: bộ phép CI/CD dùng chung chạy trên cả sáu (chữ ký lệch độ dài
> ⇒ `false`, không ném) và phép kiểm AST của `design-lint` — không `===`/`!==` trên chữ ký, mọi
> hiện thực gọi `timingSafeEqual` qua đúng một hàm.

---

# Plan #25 — Portal

Mười tám mục (nay còn chín) dưới đây có **một** nguyên nhân chung: §10.14 của thiết kế vẽ 21 màn hình,
còn Service 1 hôm nay chỉ có endpoint cho một phần. Làm một màn hình không có endpoint
nghĩa là viết một cái giả rồi gọi nó là xong, nên phạm vi Plan #25 chia theo endpoint đã
chạy được, và mỗi màn hình bị hoãn nằm ở đây kèm điều kiện.

> **Đã trả (25/09/2026):** `portal-cmdk` — bảng lệnh Ctrl K, nút "Tìm nhanh" và phím 1..9
> đổi environment; bằng chứng là `apps/portal/tests/palette.test.tsx` (mọi lệnh tới được
> bằng bàn phím, phím số không bị bắt khi đang gõ). Mục đã rời sổ; ghi ở đây để số mục
> giảm có lý do đọc được.
>
> **Đã trả (25/09/2026):** `portal-config-promote` — sao chép rule giữa environment, diff
> hiện trước khi áp; rule khớp (cùng loại, cùng điều kiện) mang `id` của rule ĐÍCH nên
> `bucket_salt` ở đích giữ nguyên (server giữ salt theo `id`, `rule-replace.integration`);
> `id` nguồn không bao giờ được gửi. Bằng chứng: `apps/portal/tests/promote.test.tsx`, kể
> cả ô âm "env đích đổi từ lúc đọc" ⇒ 409; đột biến "gửi id nguồn" ⇒ 3 ô đỏ. Phần chưa
> kiểm ở mức này: một lượt đầu-cuối trên database thật (máy thiếu RAM hôm đo).
>
> **Đã trả (25/09/2026):** `portal-segment-quota` — tiền đề "GET /segments trả tổng byte"
> đã có sẵn (`quota.payloadBytes`). Portal dự báo sau-khi-lưu bằng hai con số: chặn dưới
> (JSON gọn, cùng tính chất với `segmentPayloadBytesOf`: jsonb::text chỉ dài hơn) và ước
> lượng trên (cộng số `,`/`:`); trừ bản cũ khi sửa. Cảnh báo, không chặn — `quota` có thể
> đã cũ. Bằng chứng: `apps/portal/tests/segment-quota.test.tsx` (sát trần + ~1 KiB ⇒ cảnh
> báo trước khi gửi; dưới trần mà server trả 422 ⇒ UI vẫn nói lỗi).
>
> **Đã trả (25/09/2026):** `portal-refresh-lock` — trình duyệt không có Web Locks dùng
> lease trong localStorage ("ghi, chờ lắng, đọc lại"; lease chỉ gồm id ngẫu nhiên và hạn,
> tự hết hạn khi tab chết). Bằng chứng: `apps/portal/tests/http.test.ts` dựng HAI bộ
> refresh độc lập trên cùng storage ⇒ đúng một `/auth/refresh`, cả hai `true`; đối chứng
> không khoá ⇒ hai lần; đột biến bỏ lease ⇒ đỏ. Còn hở, nói rõ trong mã: storage bị chặn
> hoàn toàn thì không có kênh chung giữa tab.
>
> **Đã trả (25/09/2026):** `portal-deployments` — `GET /deployments` (gom theo
> `deploymentId`) và `GET /metrics/dora` (năm chỉ số §2.2, mỗi chỉ số kèm cỡ mẫu; median
> 0 mẫu là `null`, không phải 0). Bằng chứng: `deployment.integration.test.ts` (1 ngày và
> 7 ngày cho số khác nhau), `dora.test.ts` (định nghĩa từng chỉ số), và test Portal khẳng
> định đổi khoảng thì hỏi lại với `days` mới. Giới hạn nói thẳng: webhook CI/CD (§8.3)
> chưa có nên hôm nay chỉ `ROLLBACK` của Service 3 vào Event Store.
>
> **Đã trả (25/09/2026):** `portal-admin` — sáu route `/admin/*` và sáu màn hình.
> Bằng chứng: `admin.integration.test.ts` — USER ⇒ 403 ở MỌI route kể cả PATCH đổi vai,
> hạ quyền có hiệu lực ngay (vai đọc từ database), audit đổi vai với `projectId = null`;
> luật "không hạ admin cuối cùng" test bằng hàm thuần vì seed luôn có một admin. Orphan
> hiện USD/giờ, giá không biết là "chưa rõ giá" (không phải 0). Giới hạn: nửa quét cloud
> theo tag chưa chạy — response mang `cloudScanned: false` và màn hình nói điều đó.
>
> **Đã trả (25/09/2026):** `portal-cloud-step` — năm route `/projects/:id/cloud`
> (Plan #26 P6) và bước 2 của wizard + thẻ Cloud trong Cài đặt (P7). Bằng chứng:
> `cloud.integration.test.ts` — credential lưu mã hoá, quét sentinel DB và log sạch, đúng
> một bản active, `validate` trả `valid: false` kèm lý do khi cloud từ chối, `preflight`
> trả ĐÚNG các quyền thiếu, 409/422/503 có slug riêng, payload giải mã bị xoá sau mỗi lần
> đổi token; test Portal `cloud.test.tsx` — ba vai trò, lỗi định dạng chặn ở trang không
> gửi bí mật đi, wizard tạo xong ở lại bước cloud. Phần còn nợ là cloud THẬT, ở
> `cred-federation` và `I31-*`.
>
> **Đã trả (25/09/2026):** `domains-catalog-route` — `GET /domains/catalog` dựng TỪ
> registry (Plan #27). Bằng chứng: `domain-catalog.integration.test.ts` — đủ 16 domain
> của bảng, tool đọc từ adapter đã nạp, và phép kiểm DƯƠNG TÍNH của I28: thả MỘT thư mục
> adapter vào cây tạm ⇒ tool hiện trên catalog kèm trường cấu hình, không sửa tệp nào khác.
>
> **Đã trả (25/09/2026):** `portal-domain-screens` — trang Domain (bật/tắt, chọn tool, form
> dựng từ `configSchema` của adapter, kiểm trực tiếp có nút hành động, lưu cả tập với khoá
> `domain_set_version`), chi tiết domain (trạng thái + CHỖ trôi mà lượt quét ghi), Catalog
> quản trị, bước 3 của wizard. Bằng chứng: `project-domain.integration.test.ts` (đua hai
> PUT ⇒ đúng một thắng, 400 đúng trường, 422 mã catalog, 409 khi project đã rời nháp),
> `domain.test.tsx`. Phần còn lại có mục riêng: trạng thái theo thời gian thực sau khi áp
> (`portal-job-stream`, đã trả ở Plan #28), nâng cấp và quét ngay (`domain-day2-route`), drift trên cluster
> thật (`E16`).

> **Đã trả (25/09/2026, Plan #28):** `portal-job-stream` và `portal-preview`. Hàng đợi
> `pg-boss` (`jobs/boss.ts`) + đối soát, job PROVISION bốn pha có bù trừ xuyên pha, hủy hợp
> tác và tiếp quản khi worker chết (`provision-job.integration.test.ts`, 8 ô trên database
> thật); `GET /preview` (ba mục chi phí bắt buộc, thứ tự ResourceStep, thứ tự deploy theo
> bậc, lý do chặn), `POST /provision` (Idempotency-Key, 428 khi production chưa xác nhận
> đúng con số), danh sách/chi tiết job, SSE đọc từ database, hủy
> (`provisioning.integration.test.ts`, `job-stream.test.ts`); Portal trang Hạ tầng và bước
> 4–5 của wizard, SSE CHỈ gọi `invalidateQueries` và đóng ở trạng thái cuối
> (`provisioning.test.tsx`). Phần cần cluster thật nằm ở `I32-cluster`.

> **Đã trả (26/09/2026, Plan #40):** `portal-env-crud` — `GET/POST/PATCH/DELETE
/projects/:id/environments` (tên nhãn DNS bất biến, trần 8, bốn điều kiện xoá có slug riêng —
> ô âm "rollout `IN_PROGRESS` ⇒ 409" là `environment-rollout-active`), backfill `FlagEnvConfig` qua
> Service 2 thật (`environment.integration.test.ts`, `environment-backfill.integration.test.ts`),
> job `ENVIRONMENT_APPLY` dựng/dọn phần cluster (`provision-job.integration.test.ts`), tab
> Environment của Portal (`environments.test.tsx`; ma trận flag và danh sách làm mới theo
> `qkPrefix`, I38 xanh). Phần cần cluster thật nằm ở `I32-cluster`.

> **Đã trả (27/09/2026, Plan #42):** `portal-response-schema` — mọi route JSON của Service 1 có
> schema dây `.strict()` và một mẫu response THẬT (golden capture, 78 route); phép kiểm mới "đủ theo
> mã" của `wire-golden.test.ts` đọc route KHAI TRONG MÃ (tiền tố lấy từ các lệnh mount) và đỏ khi một
> route gửi qua `sendJson` thiếu dòng trong bảng — đã thử đột biến (bỏ dòng `GET /cost` ⇒ đỏ đúng
> route đó). Bốn route còn lại trả 204 không thân; hai luồng SSE không phải JSON.

## monitoring-real-cluster — chuỗi RED và tín hiệu nền tảng trên cụm thật

- **Vì sao nợ:** [Plan #53] `GET /projects/:id/metrics/red` đọc chuỗi thời gian qua binding `metrics.query`
  (Prometheus trong cụm qua proxy của API server, cùng đường với gate canary §7.4). Máy dev không có cụm, nên
  `series` của Prometheus được kiểm bằng fetch giả (đúng khuôn `query_range`, đúng bước), route và Portal chạy
  trên provider giả và mẫu golden. Chưa có lượt nào đọc số từ một Prometheus thật với workload xuất metric thật.
  Tín hiệu nền tảng (`GET /admin/platform`) có E2E trên kind và k3s của job `vm`, nhưng ở kind không có
  metrics-server nên node là `unavailable`.
- **Tiền đề:** một cụm có Prometheus (domain Monitoring `prometheus-grafana` hay `victoria-metrics` đã triển
  khai), một workload deploy qua UDP có middleware §7.4 xuất `http_requests_total` và histogram độ trễ, có tải.
- **Lệnh:** mở Portal, trang Giám sát của env đó, khoảng 1 giờ; song song chạy PromQL của §7.4 bằng tay qua
  `kubectl port-forward` (lệnh mà thẻ "Mở Grafana" in ra) và so từng điểm.
- **Đạt:** ba biểu đồ của mỗi workload khớp PromQL tay (sai khác ≤ một bước); điểm không có dữ liệu là đường
  đứt, không phải 0; lệnh port-forward mở đúng Grafana. **Không đạt:** chuỗi rỗng khi PromQL tay có số (nhãn
  lệch §7.4), hay bước lệch làm điểm dịch.
- **Tài nguyên:** cụm có Prometheus (~2,5 GiB) và một workload có tải — cùng tiền đề với `portal-rollout-create`.
- **Ảnh hưởng tới kết luận:** câu "Portal cho thấy thứ đang chạy" (Plan #53 QĐ-4) mới được chứng minh ở mức
  hợp đồng và provider giả, chưa ở mức số đo thật.

## monitoring-saas-real — chuỗi thời gian của Datadog, New Relic, Dynatrace thật

- **Vì sao nợ:** [Plan #53] Ba provider SaaS parse response mẫu viết theo tài liệu công khai của từng nhà
  (`/api/v1/query` của Datadog, NRQL `TIMESERIES` của New Relic, `/api/v2/metrics/query` của Dynatrace); điểm
  rỗng là `null`. Gọi thật cần khoá API của tài khoản trả phí — trái yêu cầu chi phí 0 của hạ tầng UDP. Khác
  `saas-metrics-real`: mục đó đo `snapshot` (phân tích canary), mục này đo `series` (trang Giám sát) — hai API
  chuỗi khác nhau của cùng nhà cung cấp; chạy CHUNG một lượt vì cùng tiền đề.
- **Tiền đề:** như `saas-metrics-real` — tài khoản dùng thử của ba nhà, một cluster chạy sample-app với agent
  tương ứng, khoá API đặt vào cấu hình domain Monitoring của project qua Portal.
- **Lệnh:** trang Giám sát của project đó, bốn khoảng 1h / 6h / 24h / 7d; so với biểu đồ cùng truy vấn trên
  giao diện của nhà cung cấp (nút "Mở Datadog" / "Mở New Relic" / "Mở Dynatrace").
- **Đạt:** hình và số khớp giao diện của nhà cung cấp ở cả bốn khoảng; điểm trống hiện là trống.
  **Không đạt:** 4xx do khuôn truy vấn, hay bucket lệch múi giờ.
- **Tài nguyên:** cluster (~3 GiB) + ba tài khoản SaaS dùng thử — dùng lại của lượt `saas-metrics-real`.
- **Ảnh hưởng tới kết luận:** câu "mọi tool Monitoring của §5.5 cho được chuỗi RED" — hiện đúng cho nhánh
  PromQL ở mức hợp đồng, đúng cho ba nhà SaaS ở mức response mẫu.

## vm-oracle-real — UDP trên máy ảo Oracle Cloud Always Free thật

- **Vì sao nợ:** [Plan #52] Máy công khai (§15.1, D-P41) có mã và test: bản phát hành dựng bằng kustomize
  thật và parse bằng `envSchema`, script qua `bash -n`, nối dây workflow; job `vm` của CI diễn tập CHÍNH
  `bootstrap.sh` + `release.sh` trên runner rồi E2E qua HTTPS. Runner KHÔNG thay được máy thật ở năm chỗ:
  kiến trúc arm64 (image build trên Ampere A1), iptables và security list của image Oracle, chứng chỉ Let's
  Encrypt thật qua HTTP-01 (runner không có DNS công khai — lượt CI dùng CA tự ký), IP của khách tới được
  S1/S2 qua ServiceLB với `externalTrafficPolicy: Local` (rate limit theo IP), và workflow `Deploy` qua SSH
  thật. Chưa có máy: tài khoản Oracle cần thẻ để xác minh, do người dùng tự tạo.
- **Tiền đề:** tài khoản Oracle Cloud Free Tier (KHÔNG nâng lên Pay As You Go); máy ảo A1 Ubuntu 24.04 theo
  `deploy/README.md`; tên DuckDNS trỏ về IP của máy; bucket + PAR chỉ-ghi; bốn secret của environment `vm`.
- **Runbook:** (1) `bash udp/deploy/vm/bootstrap.sh` trên máy, điền `~/udp/vm.env` với
  `TLS_ISSUER=letsencrypt-staging`; (2) chạy tay workflow `Deploy`; (3) đổi sang `letsencrypt`, chạy lại;
  (4) từ một máy khác: đăng ký, đăng nhập, tạo project + khoá SDK, `curl -N` vào `/sdk/stream` 5 phút;
  (5) đọc log của Service 1 (`kubectl --kubeconfig ~/.kube/udp-vm.yaml --context udp-vm -n udp logs
deployment/core-backend`) xem `ip` của request là IP thật của máy gọi; (6) `kubectl create job --from=cronjob/udp-backup`
  rồi thấy `udp-<thứ>.dump` trong bucket; (7) tải bản dump về máy ảo và `pnpm --filter @udp/deploy
vm-restore`; (8) sau 7 ngày, đọc Metrics của máy trên Console: bộ nhớ dùng có trên 20% không.
- **Đạt:** trình duyệt tin chứng chỉ của host; HTTP chuyển sang HTTPS; stream SSE sống qua 5 phút; IP trong
  log là IP của máy gọi; bản sao lưu nằm trong bucket và khôi phục được; bộ nhớ dùng > 20% (máy không bị
  coi là rảnh). **Không đạt:** build arm64 hỏng, cert-manager kẹt ở challenge (security list, iptables),
  IP trong log là IP nội bộ của cụm (rate limit gộp mọi khách), hay Oracle gửi thư báo máy rảnh.
- **Tài nguyên:** một máy A1 2 OCPU / 12 GB Always Free, boot volume 100 GB, bucket Object Storage — 0 đồng.
- **Ảnh hưởng tới kết luận:** câu "UDP có một bản chạy công khai, chi phí 0, không trên máy người dùng"
  (§15.1, D-P41) — hôm nay là bảo đảm của mã, test và lượt diễn tập trên runner x86, chưa phải của một
  lần chạy trên Oracle.

> **Đã trả (30/09/2026, Plan #53):** `portal-responsive` — job CI `portal-demo` (Playwright) mở bản xem thử
> tĩnh và đi qua 34 màn của hai khung (mọi route của Portal và Bảng điều khiển, kể cả đăng nhập, đăng ký và năm
> tab Cài đặt) ở 1440×900 VÀ 375×812, khẳng định `document.documentElement.scrollWidth - innerWidth ≤ 1` cùng
> không lỗi console, đúng một `main` và một `h1`, không 404, không "...". 0 màn tràn ngang ở 375px (máy dev,
> Edge, 30/09/2026); ảnh chụp là artifact của mỗi lượt CI. Cổng bắt ngay hai lỗi jsdom không thấy được: lớp cạnh
> của sơ đồ kiến trúc không vẽ (đo trước khi ref của khung cha được gắn) và trang đăng nhập thiếu `main`.

## portal-rollout-create — tạo rollout khi project chưa có cluster và Prometheus

- **Vì sao nợ:** `POST /rollouts/probe` cần một workload thật xuất metric HTTP; không có
  cluster thì nó trả 422 `METRICS_NOT_AVAILABLE` hoặc 503. Tiền đề của Plan #25 là project
  trỏ vào một cluster và một Prometheus có sẵn; nếu tiền đề đó không giữ được thì phần tạo
  rollout chỉ chứng minh được bằng `msw`.
- **Tiền đề:** một cluster và một Prometheus có sẵn (bring-your-own), hoặc bật domain
  Monitoring từ Portal (chọn được từ Plan #27) rồi TRIỂN KHAI nó (trang Hạ tầng, Plan #28)
  — việc đó cần cluster thật (`I32-cluster`).
- **Lệnh:** test tích hợp tạo rollout với Prometheus thật.
- **Đạt:** probe hai pha qua được, rollout lên `IN_PROGRESS`. **Không đạt:** probe luôn
  rỗng ⇒ banner phải nói thật, KHÔNG link tới màn hình đã hoãn.
- **Tài nguyên:** cluster + Prometheus (~2,5 GiB).
- **Ảnh hưởng tới kết luận:** nửa "tạo" của luồng 5; nửa "canh và can thiệp" thì không nợ.

> **Đã trả (26/09/2026, Plan #41):** `portal-sse` — `GET /projects/:id/stream` (cookie phiên,
> VIEWER) phát `flag_changed` `{ environmentId, configVersion }` khi `config_version` của một
> environment tiến; một hub mỗi tiến trình đọc MỌI project đang mở trong một câu mỗi giây
> (`config-version-hub.test.ts`, `config-stream.integration.test.ts` trên server HTTP thật). Portal:
> sự kiện ⇒ CHỈ `invalidateQueries`, `setQueryData` không được gọi lần nào; luồng đóng ⇒ mở lại sau
> backoff (`stream-paging.test.tsx`). Qua proxy/ingress thật: `portal-e2e`.

## portal-pagination — phân trang cho danh sách project và flag

- **Vì sao VẪN nợ:** [v4.11, Plan #41] đã phân trang (`GET /flags` và `GET /projects` trả
  `total`; Portal không bao giờ xin quá 50 hàng, số đếm bằng `limit=1`) và đã đo ở hình học
  dev: trang Flag (50 + stats) p95 839,5 ms, `limit=1` p95 381 ms, cách tải trọn cũ p95
  1 058,3 ms (`raw/portal-pagination-20260926-2345.json`). Trang có stats CHƯA ĐẠT ngưỡng ở hình
  học này: mỗi lượt đi về database ~100 ms, và lượt Service 2 đọc số đếm nối tiếp sau trang.
- **Tiền đề:** runner CI cùng vùng với database (hình học chính thức §14).
- **Lệnh:** `pnpm --filter @udp/core-backend measure:flag-list` trên runner đó.
- **Đạt:** p95 trang Flag ≤ 500 ms. **Không đạt:** vượt cả ở hình học chính thức ⇒ tách stats
  khỏi trang (danh sách hiện trước, sparkline đọc sau).
- **Tài nguyên:** không.
- **Ảnh hưởng tới kết luận:** câu "Portal dùng được khi project lớn" — cùng họ với
  `stale-perf`, và phải đọc cùng nó.

## portal-e2e — end-to-end trên trình duyệt thật

- **Vì sao nợ:** Playwright cần ~500 MB tải browser cộng RAM; máy đo 7,7 GiB thường chỉ
  trống 0,4–1,5 GiB. Một bộ e2e chạy được một lần rồi không ai chạy lại thì tệ hơn không có.
- **Tiền đề:** ≥ 2 GiB RAM trống và ~500 MB đĩa, hoặc một runner CI.
- **Lệnh:** `pnpm --filter @udp/portal e2e` (chưa có).
- **Đạt:** ba luồng đi được đầu-cuối trên trình duyệt thật: đăng nhập, bật flag ở dev,
  rollback một rollout. **Không đạt:** một luồng vỡ ở trình duyệt thật trong khi test
  component xanh ⇒ chỗ lệch là một bài học về giới hạn của jsdom.
- **Tài nguyên:** ~500 MB đĩa + ~1 GiB RAM.
- **Ảnh hưởng tới kết luận:** ba thứ jsdom không đo được: layout, focus **thấy được**, và
  kéo-thả bằng con trỏ.

## portal-dx — đánh giá DX với người dùng thật

- **Vì sao nợ:** cần người dùng thật; §16 đã ghi giới hạn "mẫu thuận tiện n = 10–15".
- **Tiền đề:** có nhóm developer chịu thử.
- **Đo:** thời gian hoàn thành ba tác vụ (bật flag ở một env, tạo rollout, rollback), cộng
  SUS.
- **Đạt:** ba tác vụ đều dưới 2 phút cho người chưa từng dùng. **Không đạt:** một tác vụ
  quá 2 phút ⇒ chỗ chậm là chỗ phải sửa, và nó là một kết quả phải báo cáo chứ không phải
  một test đỏ.
- **Tài nguyên:** không (thời gian người).
- **Ảnh hưởng tới kết luận:** phần đánh giá định tính của luận văn; không ảnh hưởng tính
  đúng.

## legal-review — Điều khoản và Quyền riêng tư cần luật sư đọc

- **Vì sao nợ:** [Plan #60 QĐ-6] `/terms` và `/privacy` viết đúng những gì mã làm (dữ liệu nào, ở đâu, giữ bao
  lâu, cookie nào, bên thứ ba nào), và việc đăng ký đòi tích ô đồng ý. Nhưng văn bản pháp lý của một sản phẩm
  thương mại phải do người có chuyên môn đọc theo Nghị định 13/2023/NĐ-CP và luật của nơi đặt máy chủ; trang hiện
  cũng chưa ghi pháp nhân, địa chỉ và kênh liên hệ thật (chưa có).
- **Tiền đề:** pháp nhân hoặc người chịu trách nhiệm, địa chỉ liên hệ, nơi đặt máy chủ đã chốt (`vm-oracle-real`).
- **Runbook:** luật sư đọc hai trang (bản tiếng Việt là bản gốc); sửa `legal.messages.ts`; đổi `LEGAL.termsVersion`
  (`@udp/config`) và `LEGAL_VERSION` của Portal CÙNG lúc — test `auth-recovery.test.tsx` bắt hai số lệch.
- **Đạt:** có ý kiến bằng văn bản rằng hai trang đủ cho việc mở công khai. **Không đạt:** thiếu điều khoản bắt buộc
  ⇒ thêm, và người đã đồng ý bản cũ thấy lại ô đồng ý khi đăng nhập (chưa dựng: hôm nay chỉ lưu bản đã đồng ý).
- **Tài nguyên:** thời gian của luật sư.
- **Ảnh hưởng tới kết luận:** không ảnh hưởng tính đúng của hệ thống; là điều kiện để mở đăng ký công khai.

## auth-external-real — gửi thư và đăng nhập GitHub thật

- **Vì sao nợ:** [Plan #60 QĐ-7, QĐ-8] Quên mật khẩu và GitHub OAuth đã test với thư giả và GitHub giả ở ranh
  giới (`AuthRuntime` trong `AppDeps`): token một lần, hết hạn, thu hồi phiên, `state` sai, email chưa xác minh,
  email đã có tài khoản mật khẩu. Chưa chạy với một máy chủ SMTP thật và một OAuth App GitHub thật vì cả hai cần
  tài khoản của người dùng.
- **Tiền đề:** dịch vụ SMTP có gói miễn phí (Brevo, Resend…) ⇒ `SMTP_URL`, `MAIL_FROM`; OAuth App trên GitHub
  với callback `<CORS_ORIGIN>/api/v1/auth/github/callback` ⇒ `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Thiếu
  biến nào thì tính năng đó tắt và Portal ẩn link (`GET /auth/options`).
- **Lệnh:** trên bản chạy thật: (1) Quên mật khẩu với một email có tài khoản ⇒ thư tới trong 1 phút, link mở
  `/reset-password`, đặt được mật khẩu, phiên cũ ở trình duyệt khác bị đăng xuất; với email không có tài khoản ⇒
  cùng câu trả lời, không thư; (2) "Tiếp tục với GitHub" ở trang đăng ký (đã tích ô) ⇒ tài khoản mới; đăng xuất
  rồi ở trang đăng nhập ⇒ vào lại đúng tài khoản; email trùng một tài khoản mật khẩu ⇒ thông báo dùng mật khẩu.
- **Đạt:** cả hai luồng như trên; thư không vào thư rác của Gmail. **Không đạt:** thư vào thư rác ⇒ cấu hình
  SPF/DKIM của tên miền gửi; GitHub trả lỗi `redirect_uri` ⇒ callback của OAuth App lệch `CORS_ORIGIN`.
- **Tài nguyên:** gói miễn phí của dịch vụ SMTP, OAuth App của GitHub — 0 đồng.
- **Ảnh hưởng tới kết luận:** câu "người dùng tự lấy lại được tài khoản và đăng nhập bằng GitHub" — hôm nay là bảo
  đảm của mã và test ranh giới.

## packaging-real — đóng gói, đăng nhập OIDC và vá image nền ở sáu CI và ba cloud thật

- **Vì sao nợ:** Plan #61 (61a–61c): đoạn shell build và rebase của sáu CI qua `bash -n` ở mọi ô
  (CI × kiểu đăng nhập × chiến lược), YAML của mọi template parse được, thứ tự và ghim digest được
  bộ hợp đồng kiểm; quyết định rebase của Service 1 chạy trên database thật; job `build-smoke` của CI
  UDP build sáu ứng dụng mẫu bằng ĐÚNG đoạn shell renderer sinh rồi chạy image (đẩy GHCR, chỉ trên
  GitHub Actions). Chưa đo: đăng nhập OIDC thật với ECR, Artifact Registry, ACR (script danh tính,
  trust theo repo và nhánh, `aud` của từng cloud); GitLab với dịch vụ dind, CircleCI `machine`;
  build trong cluster (pod template của Jenkins, task của Tekton, runner của Drone) với BuildKit
  không root trên node thật (seccomp/AppArmor `Unconfined`) và `creator` tự hạ quyền; `pack rebase
--publish` và `/cnb/lifecycle/rebaser` trên registry thật (gồm GHCR không có API referrers); lịch
  rebase kích đúng ở sáu CI; workflow `toolchain.yml` chạy trên GitHub.
- **Tiền đề:** tài khoản ba cloud (gói miễn phí hay tín dụng dùng thử) có registry và cụm của UDP
  (`I32-cluster`); repo thử ở sáu CI; UDP có địa chỉ công khai (tunnel); chạy script danh tính một
  lần mỗi cloud.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- packaging.real` (tệp CHƯA CÓ; nó đẩy một
  commit có Dockerfile và một commit không có Dockerfile vào repo thử ở từng CI, chờ `DEPLOY_SUCCESS`
  với `imageRef` dạng `repo:commit@sha256:…`, rồi kích lượt theo lịch và chờ lần deploy `rebase`).
- **Đạt:** mỗi ô CI × cloud: đẩy được bằng mật khẩu ngắn hạn (không secret dài hạn nào trong CI của
  registry cloud), image chạy được và mang SBOM; lượt rebase đổi digest khi run image có bản mới,
  giữ digest khi không, và Service 1 trả `unchanged`/`skipped` đúng lúc. **Không đạt:** trust policy
  từ chối JWT ⇒ sửa script danh tính của cloud đó; BuildKit không khởi động trên node ⇒ xem lại
  securityContext; `rebaser` không đọc được thông tin đăng nhập ⇒ xem lại thứ tự hạ quyền.
- **Tài nguyên:** ba cụm (~3 GiB mỗi cụm, lần lượt) + tài khoản miễn phí ở năm CI dịch vụ;
  Jenkins/Tekton/Drone cài bằng chính adapter.
- **Ảnh hưởng tới kết luận:** AC-1…AC-7 của Plan #61 đứng ở mức hợp đồng, `bash -n` và build thật
  trên GitHub Actions; câu "sáu CI × chín registry đẩy được không cần khoá dài hạn" và "image
  Buildpacks được vá theo lịch" chưa được chứng minh trên hạ tầng thật.

## signing-kms-real — ký image bằng KMS thật ở ba cloud và cổng deploy với pipeline thật

- **Vì sao nợ:** Plan #61 61d-1: lệnh ký của sáu CI qua `bash -n` ở mọi ô và thứ tự quét → ký → báo được bộ hợp đồng
  kiểm; cổng deploy kiểm bundle THẬT do cosign 3.1.3 ký (test đơn vị) và bundle cùng hình qua HTTP thật trên database
  thật (test tích hợp: ràng buộc repository, đủ bốn mã từ chối, tự bật bắt buộc); job CI `signing-e2e` ký bằng ĐÚNG đoạn
  shell renderer sinh với khoá tệp trên zot và distribution rồi kiểm bằng cosign, skopeo và cổng deploy (chỉ chạy trên
  GitHub Actions; lượt chạy đầu sau khi người dùng đẩy commit 61d-1). Chưa đo: cosign gọi KMS thật (`awskms://`,
  `gcpkms://`, `azurekms://`) bằng thông tin đăng nhập liên kết từ JWT của CI (AWS web identity, GCP `external_account`,
  Azure workload identity); script danh tính tạo khoá và cấp quyền ký ĐÚNG khoá ở ba cloud (Key Vault RBAC lan quyền có
  thử lại); bước ký trong cụm (Jenkins, Tekton, Drone) xin token ServiceAccount với `aud` của cloud; CRI-O/podman trên node
  thật đọc chữ ký tương thích; registry thật không có API referrers (GHCR).
- **Tiền đề:** như `packaging-real` (ba cloud, sáu CI, UDP có địa chỉ công khai) và quyền tạo khoá KMS ở mỗi cloud.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- signing.real` (tệp CHƯA CÓ; nó chạy script danh tính, dán dòng kết
  quả, đẩy một commit, chờ lần deploy có `signature: VERIFIED`, rồi gửi lại bundle cũ để thấy `SIGNATURE_STALE` và một
  image không chữ ký để thấy `SIGNATURE_MISSING`).
- **Đạt:** mỗi ô CI × cloud: bước ký xanh không secret dài hạn, `cosign verify --key` với khoá công khai qua, Service 1 ghi
  `VERIFIED` và tự bật bắt buộc; `skopeo` với policy `sigstoreSigned` nhận chữ ký tương thích. **Không đạt:** KMS từ chối
  ⇒ sửa quyền trong script danh tính của cloud đó; cosign không đổi được JWT ⇒ xem lại biến thông tin đăng nhập; Azure
  ký hỏng ở cosign bản mới ⇒ đối chiếu sigstore#2409 (cosign 3.1.3 dùng sigstore 1.10.8, trước lỗi).
- **Tài nguyên:** như `packaging-real`; chi phí KMS ở tài khoản thử (AWS KMS 1 USD mỗi khoá mỗi tháng, tính theo giờ — xoá
  khoá sau lượt đo).
- **Ảnh hưởng tới kết luận:** AC-8 và AC-10 của Plan #61 đứng ở mức hợp đồng, bundle thật của cosign và E2E với khoá tệp;
  câu "image được ký bằng khoá KMS của chính project ở cả ba cloud" chưa được chứng minh trên hạ tầng thật.

## trusted-deploy-real — token OIDC thật của ba nhà cung cấp, qua UDP có địa chỉ công khai

- **Vì sao nợ:** Plan #61 61d-2a đo được mọi thứ đo được **không cần nhà cung cấp thật**: lõi xác minh qua 22
  ô tất định (khoá sinh trong tiến trình, đồng hồ tiêm vào, `fetch` tiêm vào, `fetch` toàn cục bị thay bằng
  một hàm ném), và đường webhook qua 7 ô tích hợp trên database thật (retry khác replay, token tiêu đúng một
  lần, chế độ bắt buộc tự bật, 401 đồng nhất của §8.3 khi HMAC sai). Chưa đo: một token do **GitHub,
  GitLab hay CircleCI thật** phát, đi qua Internet tới một UDP có địa chỉ công khai. Ba thứ chỉ lượt đó
  chứng minh được: (a) `aud` mà nhà cung cấp thật đặt BẰNG chuỗi mà renderer in vào template — toàn bộ
  thiết kế `aud` dựa vào điều này và một lệch dấu `/` là 401 vĩnh viễn; (b) `exp − iat` thật của mỗi nhà
  cung cấp, con số quyết định lề của `udp_prune_webhook_token_uses` và chưa tra được ở bàn giấy; (c) JWKS
  thật lấy được qua `createEgressFetch` và `kid` của nó khớp token — kể cả sau một lượt xoay khoá của nhà
  cung cấp.
- **Tiền đề:** như `packaging-real` (ba CI thật, UDP có địa chỉ công khai HTTPS mà nhà cung cấp gọi tới
  được), cộng: project GitHub có `permissions: id-token: write`; một instance GitLab (gitlab.com là đủ);
  một tổ chức CircleCI có Organization ID và Project ID điền vào cấu hình domain CI/CD.
- **Lệnh:** `pnpm --filter @udp/core-backend test -- trusted-deploy.real` (tệp CHƯA CÓ; nó đẩy một commit
  cho mỗi nhà cung cấp, chờ lần deploy có `trustedDeploy: VERIFIED`, rồi gửi lại ĐÚNG thân cũ để thấy
  `duplicate` và gửi thân đã đổi `environment` để thấy 401 `TOKEN_REPLAYED`).
- **Đạt:** mỗi nhà cung cấp: lần báo đầu ⇒ 202 và `trustedDeploy: VERIFIED`, chế độ bắt buộc tự bật, đúng
  một hàng `webhook_token_uses`; gửi lại thân y nguyên ⇒ 200 `duplicate` và vẫn đúng một sự kiện; thân đổi
  ⇒ 401 và một hàng `cicd.webhook.rejected`. Ghi lại `exp − iat` đo được vào bảng §8.3. **Không đạt:** `aud`
  lệch ⇒ đọc `detail` của hàng audit để thấy chuỗi nhà cung cấp đã gửi, rồi sửa `CORS_ORIGIN` chứ đừng nới
  phép so; JWKS không với tới ⇒ phải thấy **503** chứ không 401, và tuyệt đối không được deploy; CircleCI
  `aud` không phải `organizationId` ⇒ tính năng custom claims của họ đã đổi, xem lại bảng §8.3.
- **Tài nguyên:** như `packaging-real`; không tốn tiền (ba nhà cung cấp đều cấp token OIDC trong gói miễn
  phí), chỉ cần một địa chỉ công khai cho UDP.
- **Ảnh hưởng tới kết luận:** AC-11 hiện được chứng minh ở mức **cơ chế** (lõi xác minh, thứ tự tầng, tính
  một-lần do database cưỡng chế) nhưng chưa ở mức **liên thông với nhà cung cấp thật**. Vì vậy câu "Trusted
  Deploy thay được secret tĩnh" phải đọc là: đã đúng với token đúng hình dạng, chưa chạy với token do ba
  nhà cung cấp thật phát. Riêng `aud` của CircleCI còn một giới hạn đã công bố ở §16: nó là
  `organizationId` nên không buộc token vào đúng project, và việc buộc đó dựa hoàn toàn vào claim
  `oidc.circleci.com/project-id`.
