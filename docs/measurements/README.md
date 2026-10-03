# Kết quả đo — UDP

Mọi con số dưới đây sinh từ file JSON trong `raw/` — mỗi file tự mô tả: commit, `sourceDirty`, `sourceDiffSha256` (hash phần mã chưa commit lúc đo — tái tạo được từ commit chứa file), máy, RAM trống lúc bắt đầu, hình học mạng. Phép đo chưa chạy được vì thiếu hạ tầng: [`kiem-chung-con-no.md`](kiem-chung-con-no.md). Đăng ký giả thuyết trước của E5: [`E5-preregistration.md`](E5-preregistration.md).

Chạy lại: `pnpm --filter @udp/experiments <e3|e4|e7|e14|i34>` (E5: xem sổ nợ); danh sách flag của Portal: `pnpm --filter @udp/core-backend measure:flag-list`; E1: `pnpm --filter @udp/experiments e1`; E8: `pnpm --filter @udp/core-backend e8`; policy admission: `pnpm --filter @udp/core-backend measure:kyverno-crd`. Tuỳ chọn `--note "…"` ghi chú vào kết quả; không sửa tay file JSON.

| Phép đo                            | Trạng thái                                                                             | File                                                                               | Hình học                            |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| E1 — effort mở rộng adapter        | đo thật từ git (0 phá vỡ, 0 nới lỏng)                                                  | [`E1-20260927-0023.json`](raw/E1-20260927-0023.json)                               | git (không mạng)                    |
| E8 — mutation validator            | đo thật (17/17 bị giết)                                                                | [`E8-20260927-0029.json`](raw/E8-20260927-0029.json)                               | in-process                          |
| E7 — phân phối hash                | đo thật (χ² dưới tới hạn α = 0,001 ở cả ba kịch bản, N = 1 000 000)                    | [`E7-20260930-1118.json`](raw/E7-20260930-1118.json)                               | in-process                          |
| E3 — độ trễ đánh giá               | đo thật (số µs chính thức: sổ nợ E3-quiet)                                             | [`E3-20260922-1906.json`](raw/E3-20260922-1906.json)                               | in-process + OFREP dev-geometry     |
| E4 — lan truyền cấu hình           | đo thật, dev-geometry (CI: sổ nợ E4-ci)                                                | [`E4-20260922-1702.json`](raw/E4-20260922-1702.json)                               | máy dev → Supabase Singapore        |
| E5 — MTTD/MTTR auto-rollback       | chưa chạy — sổ nợ E5                                                                   | —                                                                                  | —                                   |
| E14 — cardinality nhãn `ff`        | đo phía app (Prometheus: sổ nợ)                                                        | [`E14-20260922-1542.json`](raw/E14-20260922-1542.json)                             | in-process                          |
| I34 — fail-static 5 phút           | đo thật (ĐẠT)                                                                          | [`I34-20260922-1916.json`](raw/I34-20260922-1916.json)                             | máy dev → Supabase Singapore        |
| Policy admission (Plan #61 61d-3b) | đo thật — 3/3 policy hợp lệ theo CRD Kyverno v1.19.1, kiểm ngược ĐẠT                   | [`kyverno-crd-20261003-1446.json`](raw/kyverno-crd-20261003-1446.json)             | máy dev → raw.githubusercontent.com |
| Danh sách flag (Plan #41)          | đo thật, dev-geometry — trang có stats CHƯA ĐẠT 500 ms (CI: sổ nợ `portal-pagination`) | [`portal-pagination-20260926-2345.json`](raw/portal-pagination-20260926-2345.json) | máy dev → Supabase Singapore        |

## E3 — độ trễ đánh giá (µs, nearest-rank trên mẫu gộp của các vòng)

Máy: 12th Gen Intel(R) Core(TM) i7-12650H, RAM trống lúc đo 1 GiB. 3 vòng × 20 000 lần mỗi ô.

| Flag × rule | Lõi p50 | Lõi p99 | SDK p50 | SDK p99 | SDK / giây |
| ----------- | ------- | ------- | ------- | ------- | ---------- |
| 1 × 1       | 0,9     | 2,2     | 9,3     | 15,6    | 91 716     |
| 1 × 10      | 1,2     | 4,5     | 9,5     | 15,4    | 88 817     |
| 1 × 50      | 2,5     | 3,7     | 11      | 18,7    | 77 356     |
| 10 × 1      | 1       | 2       | 9,2     | 14,8    | 92 716     |
| 10 × 10     | 1,3     | 2,2     | 9,9     | 15,9    | 86 481     |
| 10 × 50     | 2,6     | 4,6     | 11,7    | 19,6    | 73 528     |
| 100 × 1     | 1       | 2,6     | 9,5     | 15,3    | 90 271     |
| 100 × 10    | 1,9     | 4,1     | 10,6    | 17,9    | 80 462     |
| 100 × 50    | 3,9     | 7,1     | 12,3    | 24,9    | 67 824     |

Đối chứng remote (OFREP, khoá CLIENT, 8 req/s, 400 mẫu, gồm tra khoá database): p50 57,6 ms, p90 64,1 ms, p99 108,1 ms.

## E4 — lan truyền cấu hình (dev-geometry)

Điểm đầu: gửi `PATCH /internal/flag-envs/:id` vào Service 2; điểm cuối: provider phát CONFIGURATION_CHANGED. Độ trễ gồm cả RTT của lần ghi tới database ở Singapore.

| Flag | Chế độ   | NOTIFY | p50 (ms) | p99 (ms) | sau commit p50 (ms) | truy vấn/lần | byte server/lần | byte SDK/lần | hết giờ |
| ---- | -------- | ------ | -------- | -------- | ------------------- | ------------ | --------------- | ------------ | ------- |
| 1    | snapshot | có     | 896      | 1 264,8  | 164,9               | 14,6         | 348             | 349          | 0       |
| 1    | snapshot | không  | 1 101,5  | 1 632,9  | 422,6               | 12,9         | 350             | 351          | 0       |
| 1    | delta    | có     | 895,1    | 1 351    | 163,1               | 14,2         | 361             | 362          | 0       |
| 1    | delta    | không  | 1 123    | 1 549,8  | 444,5               | 12,9         | 361             | 361          | 0       |
| 10   | snapshot | có     | 1 098,8  | 1 442,9  | 208                 | 14,6         | 1 753           | 1 753        | 0       |
| 10   | snapshot | không  | 1 181,3  | 1 705,7  | 466,5               | 12,8         | 1 754           | 1 755        | 0       |
| 10   | delta    | có     | 908,1    | 1 169,7  | 167,8               | 14           | 361             | 362          | 0       |
| 10   | delta    | không  | 1 101,9  | 1 567,9  | 407,8               | 12,9         | 361             | 362          | 0       |
| 100  | snapshot | có     | 1 184,3  | 1 719,8  | 226                 | 14,5         | 15 884          | 15 885       | 0       |
| 100  | snapshot | không  | 1 463,1  | 1 955,3  | 541,6               | 12,8         | 15 884          | 15 885       | 0       |
| 100  | delta    | có     | 1 019,5  | 1 453,6  | 168,1               | 14,6         | 361             | 362          | 0       |
| 100  | delta    | không  | 1 249,7  | 1 813,7  | 441,4               | 12,8         | 361             | 362          | 0       |

## E14 — cardinality nhãn `ff` (phía ứng dụng)

Công thức `R·S·M·(B+3)·(1+T·V)`, R = 10, S = 2, M = 1, B = 10.

| T   | V   | Dự đoán | Đủ tổ hợp | Khớp | Thực tế | Byte exposition | Dựng `/metrics` p50 (ms) |
| --- | --- | ------- | --------- | ---- | ------- | --------------- | ------------------------ |
| 0   | 2   | 260     | 260       | có   | 260     | 45 810          | 0,52                     |
| 1   | 2   | 780     | 780       | có   | 780     | 141 580         | 1,18                     |
| 2   | 2   | 1 300   | 1 300     | có   | 1 300   | 237 337         | 1,68                     |
| 3   | 2   | 1 820   | 1 820     | có   | 1 820   | 333 218         | 1,97                     |
| 50  | 2   | 26 260  | 26 260    | có   | 26 247  | 4 856 511       | 42,98                    |
| 0   | 4   | 260     | 260       | có   | 260     | 45 795          | 0,24                     |
| 1   | 4   | 1 300   | 1 300     | có   | 1 274   | 237 412         | 1,7                      |
| 2   | 4   | 2 340   | 2 340     | có   | 2 275   | 429 031         | 4,1                      |
| 3   | 4   | 3 380   | 3 380     | có   | 3 289   | 620 541         | 4,03                     |
| 50  | 4   | 52 260  | 52 260    | có   | 50 986  | 9 666 966       | 93,79                    |

## I34 — fail-static 5 phút giữa lúc có traffic

STALE hợp lệ trong [100, 122] s kể từ lúc ngắt: đồng hồ "còn tươi" được làm mới mỗi nhịp tim 20 s, nên lúc ngắt nó đã già 0 … 20 s.

| Pha                                   | Lần đánh giá khi ngắt | Sai/lỗi | STALE sau (s) | Hội tụ sau thông lại (s) | Ngưỡng hội tụ (s) | Kết luận |
| ------------------------------------- | --------------------- | ------- | ------------- | ------------------------ | ----------------- | -------- |
| hố đen (proxy giữ kết nối, nuốt byte) | 4 865                 | 0       | 110,8         | 8,1                      | 80                | ĐẠT      |
| Service 2 chết                        | 4 836                 | 0       | 110,8         | 2,9                      | 80                | ĐẠT      |

## Lần chạy bị loại

File vẫn giữ trong `raw/` để truy vết; số liệu chính thức lấy từ file mới nhất của mỗi phép đo.

| File                                                   | Lý do                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`E3-20260922-1543.json`](raw/E3-20260922-1543.json)   | throughput SDK tính cả vòng khởi động (lệch với phân vị chỉ tính sau khởi động); đã sửa harness, đo lại                                                                     |
| [`I34-20260922-1555.json`](raw/I34-20260922-1555.json) | tiêu chí đạt sai: đòi STALE ≥ 120 s trong khi thiết kế cho phép sớm tới một nhịp tim (STALE thật ở 110,5 s và 110,1 s, không lần đánh giá nào sai); đã sửa tiêu chí, đo lại |

## Danh sách flag của Portal (Plan #41, dev-geometry)

200 flag × 3 environment, S1 trong tiến trình + Service 2 tiến trình con, 50 lần sau 5 lần làm
nóng. Ngưỡng của sổ nợ: p95 ≤ 500 ms.

| Lời gọi                                         | p50 (ms) | p95 (ms) | p99 (ms) |
| ----------------------------------------------- | -------- | -------- | -------- |
| Trang đầu 50 flag + stats (trang Flag)          | 580,9    | 839,5    | 1 327,2  |
| `limit=1` đọc `total` (thanh số, tổng quan)     | 316,8    | 381      | 413,5    |
| Hai trang 100 + stats (tải trọn, trước Plan 41) | 944,2    | 1 058,3  | 1 110,3  |

Mỗi lời gọi là vài lượt đi về database (~100 ms mỗi lượt ở hình học này): phiên, vai trong project,
trang + tổng (song song), rồi Service 2 đọc số đếm. Trang có stats vượt ngưỡng vì lượt sang Service 2
nối tiếp sau trang; số ở hình học chính thức (cùng vùng với database) còn nợ.

## E1 — effort mở rộng adapter (từ git, tag `adapter-interface-v1` → HEAD)

72/72 tool có adapter đều được thêm SAU tag đóng băng bề mặt interface.

| Chỉ số                                                                                          | Số                                                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Phá vỡ bề mặt (tên phương thức/thuộc tính `CloudAdapter`, `DomainAdapter`, `CicdDomainAdapter`) | **0** — không tên nào bị đổi hay bỏ                                                         |
| Thành viên THÊM vào bề mặt sau tag                                                              | 1: `DomainAdapter.restoreTo?` (Plan #61 61d-3a) — tuỳ chọn, không chỗ gọi nào vỡ            |
| Nới lỏng bộ contract test (`E1-relaxations.json`)                                               | **0**                                                                                       |
| Mở rộng bối cảnh `DomainAdapterContext`                                                         | 2 trường: `environments` (D-P29), `signedImages` (Plan #61 61d-3b)                          |
| Commit sau tag sửa tệp interface (kiểu, không tên)                                              | 4 — chỉ P37 (D-P28, `PipelineTemplateParams.steps`) buộc sửa adapter ĐÃ có: 6 adapter CI/CD |
| Tệp danh mục domain (`domains.ts`) phải sửa khi thêm tool                                       | **0** trên cả 11 lô                                                                         |

> **[v4.12, Plan #61 61d-3a] Vì sao thêm `restoreTo?` và vì sao nó được ĐẾM.** §8.6 quy tắc 3 nói "nâng cấp thất
> bại thì hạ về bản cũ, không để trạng thái lửng lơ". Nhưng registry nạp MỘT bản adapter mỗi tool, nên cổng
> `rollback` của đường nâng cấp cắm cứng `FAILED` và mọi lần thất bại kết thúc ở `ROLLBACK_FAILED` với cụm **không**
> được hạ về — tức quy tắc 3 chưa bao giờ có hiệu lực. Một adapter khai được đường đi lên từ bản cũ thì nó mang theo
> định nghĩa bản cũ, nên chính nó là bên duy nhất áp lại được. Thành viên này **tuỳ chọn**, nên không một chỗ gọi
> hay adapter nào đang có phải sửa; nhưng nó vẫn là một lần bề mặt đóng băng rộng ra, và E1 đếm nó. Nhân đợt này
> cũng đóng một lỗ của chính cổng đóng băng: hai bộ đọc của `adapter-interface-freeze.test.ts` dùng
> `/^ {2}(\w+)\(/` nên **không đếm** thành viên tuỳ chọn (`foo?()`) — ai cũng thêm được mà cổng không thấy. Đã kiểm:
> trước đợt này không interface nào dùng lỗ đó.

Tệp ngoài thư mục adapter theo lô (không tính test, tài liệu):

| Lô (commit)               | Tool | Lớp nền | Lõi adapter | Schema | Mã sản phẩm |
| ------------------------- | ---- | ------- | ----------- | ------ | ----------- |
| Helm base (`e68a863`)     | 1    | 1       | 0           | 0      | 1           |
| SaaS base (`067a7bd`)     | 1    | 2       | 0           | 0      | 0           |
| P31 Monitoring            | 4    | 3       | 0           | 0      | 2           |
| P31 Tracing               | 3    | 0       | 0           | 0      | 0           |
| P32 Logging               | 7    | 0       | 1           | 0      | 0           |
| P33 Mesh/Ingress/PD       | 9    | 1       | 0           | 0      | 0           |
| P34 GitOps/Policy/Secrets | 10   | 2       | 0           | 0      | 0           |
| P35 Registry              | 9    | 3       | 0           | 0      | 0           |
| P36 CI/CD                 | 6    | 6       | 1           | 2      | 22          |
| P37 IaC/Security          | 14   | 6       | 2           | 0      | 15          |
| P38 Database/Cost         | 8    | 2       | 5           | 0      | 18          |

Đọc trung thực: tool được thêm theo lô, cùng commit với phần mở rộng lớp nền (`adapter-base/`) của
họ adapter đó — lớp nền là điểm mở rộng đã thiết kế, không phải mã sản phẩm. Ở P31–P35 (42 tool),
ngoài lớp nền chỉ có 2 tệp sản phẩm (hai provider metrics SaaS) và 1 tệp lõi (một phép của bộ contract). Con số lớn ở P36–P38 là TÍNH NĂNG giao cùng commit (luồng webhook deploy §8.3, route chi
phí, `CLOUD_MISMATCH`) — lịch sử git không tách tự động được phần nào adapter bắt buộc cần. Mục (b)
của §14.1 (adapter thứ ba do người ngoài nhóm viết) chưa làm được: cần người thật.

## E8 — mutation testing lên capability validator

17 mutant viết tay trên `capability.resolver.ts`, mỗi mutant một nhánh của §5.3 (exclusive, conflicts,
anyOf, semver, D-4', D-10, verifyChosen, topo sort, khai báo sai dạng). Oracle độc lập sinh đủ
**7/7** mã kết quả.

| Lần đo                                                                             | Bị giết | Giết bởi differential riêng | Sống |
| ---------------------------------------------------------------------------------- | ------- | --------------------------- | ---- |
| [`E8-20260927-0026`](raw/E8-20260927-0026.json) — bộ sinh chưa có `conflicts`      | 17/17   | 13                          | 0    |
| [`E8-20260927-0029`](raw/E8-20260927-0029.json) — bộ sinh có `conflicts` một chiều | 17/17   | 14                          | 0    |

Lần đo đầu tìm ra một lỗ hổng của bộ sinh differential: nó không bao giờ sinh `conflicts`, nên mutant
"chỉ kiểm một chiều" chỉ bị test viết tay giết. Sau khi vá (cùng commit), differential giết được nó.
Ba mutant còn lại chỉ bị test viết tay giết là kiểm KHAI BÁO sai dạng (semver hỏng, anyOf một nhánh,
khoảng semver sai) — ngoài miền của differential theo thiết kế: bộ sinh chỉ tạo khai báo hợp lệ.

Mọi tệp thô parse qua schema chung `@udp/shared-types/measurements` (`packages/shared-types/tests/measurements.test.ts`)
— và trang **Bằng chứng** của Bảng điều khiển nền tảng (`/admin/evidence`, Plan #56) vẽ biểu đồ thẳng từ chúng.
