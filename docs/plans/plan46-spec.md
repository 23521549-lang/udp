# Plan #46 — SPEC v1: `ATTRIBUTE_SPLIT` ở FLAG_LEVEL

Nguồn: `docs/ban-giao/viec-con-lai-2026-09-28.md` mục 7 (lát thứ nhất); §7.2 (bảng ba chiến lược và
ma trận chiến lược × scope), §7.6, §8.5, §10.9 (`AttributeSplitDetail`), §16 hàng "Lát cắt Luồng 5".

## 1. Phạm vi

Ma trận §7.2 ở cột `FLAG_LEVEL`:

| Chiến lược        | §7.2                                                                                                                                           | Hôm nay                   | Plan này                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `CANARY`          | Ramp `serve.weights` của một rule                                                                                                              | Có                        | Giữ                                                               |
| `ATTRIBUTE_SPLIT` | Rule `ATTRIBUTE_BASED`/`SEGMENT` phục vụ variant mới; promote = đổi default variant; KHÔNG auto-rollback — chỉ hiện metric và cho rollback tay | S1 422                    | **Làm**                                                           |
| `BLUE_GREEN`      | "Không áp dụng — dùng CANARY với `step_percent = 100`"                                                                                         | S1 422 "chưa có executor" | 422 nói đúng lý do thiết kế: không áp dụng, không phải "chưa làm" |

`SERVICE_LEVEL` (mọi chiến lược) là Plan #47.

## 2. Quyết định

### QĐ-1: Cùng hình rule với canary — S2 không đổi

`PATCH /internal/rules/:id` của S2 chỉ đổi TRỌNG SỐ của một rule đã phân phối, không đổi tập variant
("rollout chỉ quyết BAO NHIÊU, không quyết CÁI GÌ"). Vì vậy rule của `ATTRIBUTE_SPLIT` là một rule
`ATTRIBUTE_BASED`/`SEGMENT` phân phối HAI variant — đúng `canaryPairOf` S1 và S3 đã dùng. Bậc duy nhất:
nhóm khớp thuộc tính sang 100% variant mới. Rollback: về `baseline_percentage` như canary. Không cần
route S2 mới, không nới quyền ghi của S3.

### QĐ-2: Chiến lược mang hai thuộc tính, reconciler không rẽ theo tên

`RolloutStrategy` thêm:

- `autoDecide: boolean` — `CANARY` true; `ATTRIBUTE_SPLIT` false. Không tự quyết thì mỗi nhịp phân tích
  vẫn ĐO hai nhánh và ghi `last_decision` HOLD kèm `metricSnapshot` (Portal hiện số), lý do nói rõ hai
  nhóm khác nhau về bản chất (§7.2) — không PROMOTE, không ROLLBACK tự động.
- `finish: "ramp" | "default-variant"` — ý định `PROMOTE` của `CANARY` là lên 100%; của `ATTRIBUTE_SPLIT`
  là đổi variant mặc định của environment sang variant mới rồi đóng `DONE` (event `COMPLETE`, MANUAL).
- `ruleIssue(ruleType)` — `ATTRIBUTE_SPLIT` chỉ nhận `ATTRIBUTE_BASED`/`SEGMENT`; rule bị đổi loại giữa
  chừng ⇒ HOLD kèm lý do, như mọi cấu hình sai khác của `loadFlagTarget`.

### QĐ-3: Đổi mặc định đi `PATCH /internal/flag-envs/:id` với người làm của ý định

S3 gọi route S1 vẫn dùng để đổi mặc định, mang `X-Udp-Actor-Id` là `actor_user_id` của ý định
`PROMOTE` — S2 ghi audit người thật đã bấm (I40), không ẩn danh. Fence kiểm TRƯỚC lời gọi; lời gọi
idempotent (đặt cùng một giá trị), nên worker tỉnh muộn gọi lại cũng vô hại, và DB đóng session sau
đó bằng `updateIfVersion` như mọi đường khác. S2 sống mà từ chối ⇒ ý định bị từ chối có lý do; S2 không
phản hồi ⇒ HOLD, ý định giữ nguyên để vòng sau thử lại.

### QĐ-4: Service 1 và Portal

- S1 nhận `FLAG_LEVEL` + `ATTRIBUTE_SPLIT` khi rule là `ATTRIBUTE_BASED`/`SEGMENT` (422 nếu không); các
  kiểm khác y canary (flag ACTIVE, bật, hai variant, probe pha 1). `stepPercent` bị bỏ qua — một bậc.
- `BLUE_GREEN` + `FLAG_LEVEL` ⇒ 422 "không áp dụng … dùng CANARY với stepPercent = 100 (§7.2)".
- Portal: hộp tạo rollout có chọn chiến lược; `ATTRIBUTE_SPLIT` chỉ liệt kê rule theo thuộc tính/segment
  và ẩn các ô bậc/ngưỡng. Chi tiết rollout `ATTRIBUTE_SPLIT` (§10.9 `AttributeSplitDetail`): số liệu KỸ
  THUẬT của hai nhánh kèm cảnh báo không quy được chênh lệch cho nhánh flag, không z-score, chỉ hai nút
  "Đổi mặc định sang …" và Rollback.

## 3. Tiêu chí chấp nhận

- **AC-1** S3: PENDING ⇒ nhóm khớp sang 100% qua S2 ⇒ IN_PROGRESS; các nhịp sau chỉ ghi HOLD kèm số đo,
  kể cả khi số đo XẤU (không auto-rollback) và khi dwell đã qua (không auto-promote).
- **AC-2** S3: ý định PROMOTE ⇒ `default_variant_id` của env-config đổi sang variant mới qua S2, audit
  mang người bấm, session DONE, event COMPLETE MANUAL trỏ ý định, nhãn `ff` được gỡ; ROLLBACK ⇒ về
  baseline như canary.
- **AC-3** S3: rule bị đổi sang `ALL` ⇒ HOLD kèm lý do; S2 từ chối đổi mặc định ⇒ ý định bị từ chối có lý do.
- **AC-4** S1: tạo `ATTRIBUTE_SPLIT` với rule thuộc tính ⇒ 201; rule `ALL` ⇒ 422; `BLUE_GREEN` ⇒ 422 lý do
  thiết kế.
- **AC-5** Portal: tạo được `ATTRIBUTE_SPLIT`; chi tiết hiện cảnh báo và hai nút đúng.
- **AC-6** Không thoái cấp.
