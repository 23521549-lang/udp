# Kết quả đo — UDP

Mọi con số dưới đây sinh từ file JSON trong `raw/` — mỗi file tự mô tả: commit, `sourceDirty`, `sourceDiffSha256` (hash phần mã chưa commit lúc đo — tái tạo được từ commit chứa file), máy, RAM trống lúc bắt đầu, hình học mạng. Phép đo chưa chạy được vì thiếu hạ tầng: [`kiem-chung-con-no.md`](kiem-chung-con-no.md). Đăng ký giả thuyết trước của E5: [`E5-preregistration.md`](E5-preregistration.md).

Chạy lại: `pnpm --filter @udp/experiments <e3|e4|e14|i34>` (E5: xem sổ nợ). Tuỳ chọn `--note "…"` ghi chú vào kết quả; không sửa tay file JSON.

| Phép đo                      | Trạng thái                                 | File                                                   | Hình học                        |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------- |
| E3 — độ trễ đánh giá         | đo thật (số µs chính thức: sổ nợ E3-quiet) | [`E3-20260922-1906.json`](raw/E3-20260922-1906.json)   | in-process + OFREP dev-geometry |
| E4 — lan truyền cấu hình     | đo thật, dev-geometry (CI: sổ nợ E4-ci)    | [`E4-20260922-1702.json`](raw/E4-20260922-1702.json)   | máy dev → Supabase Singapore    |
| E5 — MTTD/MTTR auto-rollback | chưa chạy — sổ nợ E5                       | —                                                      | —                               |
| E14 — cardinality nhãn `ff`  | đo phía app (Prometheus: sổ nợ)            | [`E14-20260922-1542.json`](raw/E14-20260922-1542.json) | in-process                      |
| I34 — fail-static 5 phút     | đo thật (ĐẠT)                              | [`I34-20260922-1916.json`](raw/I34-20260922-1916.json) | máy dev → Supabase Singapore    |

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
