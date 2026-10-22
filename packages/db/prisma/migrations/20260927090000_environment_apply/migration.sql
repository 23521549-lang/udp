-- [v4.11] Plan #40 P3 — job `ENVIRONMENT_APPLY` (D-P31): thêm hay bớt MỘT environment trên
-- cluster của project đang chạy (namespace, RBAC, instance theo environment). Cùng hàng
-- `provisioning_jobs`, cùng hàng đợi, lease và đối soát với ba loại job trước (D-P20).
--
-- `ADD VALUE` không chạy được trong transaction trên PostgreSQL < 12; Supabase là 15+.
--
-- Đường lùi: PostgreSQL không bỏ được một giá trị enum — xoá mọi hàng `ENVIRONMENT_APPLY`, rồi
-- dựng lại kiểu (tạo `JobType_old` không có giá trị này, đổi cột, xoá kiểu mới).

ALTER TYPE "JobType" ADD VALUE 'ENVIRONMENT_APPLY';
