# Plan #30 — PLAN (theo `plan30-spec.md` v1)

| Pha | Làm gì                                                                                                                         | Cổng                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| P1  | `domain-apply-plan.ts` THUẦN: hiện tại × đích ⇒ danh sách thay đổi (bật, tắt, đổi tool, đổi cấu hình, đổi preference) theo bậc | test thuần, bảng năm CASE        |
| P2  | `domain-apply.job.ts`: thi hành kế hoạch; CASE 3 blue/green + rebind; rẽ nhánh trong `job-worker`                              | tích hợp (AC-2..AC-4)            |
| P3  | `PUT /domains` trên ACTIVE ⇒ 202 job; `POST …/drift` đồng bộ; `POST …/upgrade` ⇒ job; wire + golden                            | tích hợp (AC-1, AC-5, AC-6), I10 |
| P4  | Portal: lưu domain ACTIVE hiện tiến độ; nút Quét ngay / Nâng cấp                                                               | test Portal, I38                 |
| P5  | Tài liệu (§8.2, §9, D-P18, §16), sổ nợ trả `domain-day2-route`, bàn giao                                                       | design-lint                      |
