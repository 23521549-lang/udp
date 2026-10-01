-- [Plan #61 QĐ-9] Cài đặt build của project (chiến lược, thư mục, Dockerfile, ngôn ngữ, bước test, danh tính build).
-- NULL = mặc định; chỉ mã định danh không bí mật — schema dây chặn mọi thứ trông như khoá.
ALTER TABLE "projects" ADD COLUMN "build_settings" JSONB;
