# Plan #29 — Teardown, xoá project và ba lịch biểu bảo vệ chi phí — SPEC

Trạng thái: **v1, 25/09/2026**. Nguồn: ADR-02, ADR-08, §2.3 (không hard-delete), §4.2 thứ
tự teardown chín bậc, §4.4 lớp 3 (TTL) và lớp 4 (orphan-scan), §8.6 nhánh A (quét drift),
§9 `DELETE /projects/:id` ("soft-delete + enqueue teardown"), §16 dòng "`DELETE
/projects/:id` xoá mềm nhưng chưa enqueue teardown"; sổ nợ `drift-scan-cron`.

## 1. Mục tiêu

1. **Job TEARDOWN** trên CÙNG worker, lease, fencing và đối soát của Plan #28.
2. **`DELETE /projects/:id`** giữ hợp đồng hiện có (OWNER, 204) nhưng làm đủ §9: xoá mềm
   và tạo job TEARDOWN trong CÙNG transaction. Gỡ dòng §16.
3. **Ba lịch biểu** trên pg-boss: `project-ttl`, `orphan-scan`, `drift-scan` (trả
   `drift-scan-cron`).
4. **Portal:** trang Hạ tầng hiện tiến độ TEARDOWN; project hết hạn mà `WARN` có nhãn.

**Không thuộc plan này:** `DOMAIN_APPLY` cho project ACTIVE và hai route Day-2 (Plan #30).

## 2. Ràng buộc nền

| Mã  | Ràng buộc                                                                                  | Nguồn      |
| --- | ------------------------------------------------------------------------------------------ | ---------- |
| R1  | Nguồn sự thật là TAG trên cloud; sổ là gợi ý thứ tự                                        | ADR-08     |
| R2  | K8S_MANAGED xoá trước và CHỜ biến mất trước bậc mạng; hết hạn chờ ⇒ `ORPHAN_SUSPECTED`     | §4.2, §4.5 |
| R3  | Không bao giờ tự xoá project có environment production đã deploy                           | §4.4 lớp 3 |
| R4  | Mọi quyết định tiêu/thôi tiêu tiền của hệ thống ghi `AuditLog(actor SYSTEM)` TRƯỚC khi làm | §4.4       |
| R5  | Quét drift chỉ ghi `last_error` (I32 chiều c)                                              | §8.6       |
| R6  | Không thoái cấp: K1..K10, golden, I10, I22, I38, lưới Plan #28                             | yêu cầu    |

## 3. Quyết định

### QĐ-1: TEARDOWN dùng `adapter.teardown`, không `runner.compensate`

Bù trừ của runner chỉ biết step của kế hoạch. Teardown phải dọn cả tài nguyên Kubernetes
sinh ra (ELB/ENI/EBS, `discoverK8sManaged` theo tag `kubernetes.io/cluster/<tên>`) và CHỜ
chúng biến mất — thứ chỉ `adapter.teardown` (`runTeardown` chín bậc) làm. Đầu vào =
`listTaggedResources` (tag, ADR-08) ∪ hàng sổ còn sống không thấy qua tag (kind không gắn
tag lúc tạo, tra bằng `lookupById` của step). Kết quả `deleted`/`failed` cập nhật sổ:
`DELETING → DELETED | ORPHAN_SUSPECTED`.

### QĐ-2: Trạng thái của job TEARDOWN dùng lại enum hiện có

`QUEUED → COMPENSATING → DONE | COMPENSATION_FAILED` — cùng nghĩa "đang dọn", không thêm
migration enum. Hủy không áp dụng (dọn dở dang tệ hơn dọn xong).

### QĐ-3: Xoá project khi đang có job PROVISION

Job còn hủy được ⇒ yêu cầu hủy; bù trừ của nó chính là teardown (không tạo job thứ hai).
Job đang bù trừ ⇒ để nó xong. Mọi ghi trạng thái project của worker (PROVISIONING, ACTIVE,
DRAFT, ERROR) có điều kiện `status <> 'DELETED'`: project đã xoá mềm không bao giờ sống lại.
Project chưa từng có hàng sổ nào và không có job ⇒ chỉ xoá mềm.

### QĐ-4: Hàng đợi chung cho mọi loại job

`QUEUES.provision` đổi thành `QUEUES.jobs` (`udp-jobs`); handler đọc `job_type` rồi rẽ
nhánh. Một hàng, một đối soát, một lease — không nhân ba cơ chế.

### QĐ-5: Mốc cảnh báo TTL nhớ bằng audit

`expiryDecision` ⇒ `warn` ghi `project.ttl.warn {threshold}` đúng một lần mỗi mốc (tra
audit trước khi ghi); `teardown` ⇒ ghi `project.ttl.teardown` (actor SYSTEM) TRƯỚC, rồi xoá
mềm + TEARDOWN như QĐ-3; `teardown-blocked` ⇒ ghi một lần. Không thêm cột.

### QĐ-6: orphan-scan không đổi trạng thái sai cạnh

Hàng `CREATING` quá `STALE_CREATING_MINUTES`: tra theo tag; thấy ⇒ gắn `provider_id`
(`markCreated`) — hàng hội tụ; không thấy ⇒ giữ nguyên, chỉ ghi audit để
`GET /admin/orphan-resources` hiện. Tài nguyên mang tag project mà sổ không có (`unmatched`
của `classifyOrphans`) ⇒ audit kèm USD/giờ. Không lịch nào tự xoá tài nguyên.

## 4. Tiêu chí chấp nhận

| Mã   | Tiêu chí                                                                                                   | Cách kiểm        |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| AC-1 | TEARDOWN trên SimCloud: cloud không còn tài nguyên của project, mọi hàng sổ DELETED, `cluster_access` null | tích hợp         |
| AC-2 | K8S_MANAGED (LB mô phỏng mang tag cluster) xoá trước bậc mạng; không biến mất kịp ⇒ ORPHAN_SUSPECTED       | tích hợp         |
| AC-3 | `DELETE /projects/:id` ACTIVE ⇒ 204 + job TEARDOWN QUEUED trong cùng transaction; DRAFT trống ⇒ không job  | tích hợp         |
| AC-4 | Xoá khi PROVISION đang chạy ⇒ hủy + bù trừ; project KHÔNG trở lại DRAFT/ERROR                              | tích hợp         |
| AC-5 | TTL: mốc 24h ghi cảnh báo đúng một lần qua hai lượt; production đã deploy ⇒ blocked, không xoá             | tích hợp + thuần |
| AC-6 | orphan-scan: CREATING cũ tìm thấy theo tag ⇒ CREATED; không thấy ⇒ giữ nguyên                              | tích hợp         |
| AC-7 | drift-scan: ba chu kỳ chỉ đổi `last_error`/`updated_at` (dùng lại phép kiểm I32-c)                         | tích hợp         |
| AC-8 | Không thoái cấp                                                                                            | lệnh cổng        |

## 5. Nợ kiểm chứng

`I31-*` (teardown trên cloud thật), `k8s-managed-discovery` (hình tag thật) giữ nguyên.
Trả `drift-scan-cron`.

## 6. Nhật ký review

| Vòng | Phát hiện                                                                    | Xử lý                    |
| ---- | ---------------------------------------------------------------------------- | ------------------------ |
| v1   | Bù trừ của Plan #28 ghi project DRAFT/ERROR — sẽ hồi sinh project đã xoá mềm | QĐ-3                     |
| v1   | Nháp đầu đòi gõ tên project (428) cho DELETE — §9 không có, Portal đã tự hỏi | Giữ hợp đồng 204 hiện có |
