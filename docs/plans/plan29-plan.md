# Plan #29 — PLAN (theo `plan29-spec.md` v1)

| Pha | Làm gì                                                                                                           | Cổng                               |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P1  | `QUEUES.jobs` + handler rẽ theo `job_type`; ghi trạng thái project của worker có điều kiện `status <> 'DELETED'` | test hàng đợi, lưới Plan #28       |
| P2  | `teardown.job.ts`: gỡ domain, thu tài nguyên (tag ∪ sổ), `adapter.teardown`, cập nhật sổ, kết thúc               | tích hợp SimCloud (AC-1, AC-2)     |
| P3  | `DELETE /projects/:id` xoá mềm + TEARDOWN / hủy PROVISION; gỡ dòng §16                                           | tích hợp (AC-3, AC-4), golden, I10 |
| P4  | Ba lịch biểu: `project-ttl`, `orphan-scan`, `drift-scan` qua `boss.schedule`                                     | tích hợp (AC-5..AC-7)              |
| P5  | Portal: tiến độ TEARDOWN ở trang Hạ tầng, nhãn hết hạn                                                           | test Portal, I38                   |
| P6  | Tài liệu (§9, §16, D-P), sổ nợ trả `drift-scan-cron`, bàn giao                                                   | design-lint, sổ nợ ba nơi          |
