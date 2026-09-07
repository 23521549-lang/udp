import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { defineConfig, env } from "prisma/config";

/**
 * Cấu hình Prisma CLI (migrate, db seed, studio).
 *
 * Từ Prisma 7, chuỗi kết nối không còn nằm trong `datasource` của schema. Tách ra
 * đây hoá ra lại đúng với §15.3 của thiết kế, vì hai đường dùng hai chuỗi khác nhau:
 *
 *   Migrate / seed / studio  →  DATABASE_URL_DIRECT (session mode)
 *   Runtime của service      →  DATABASE_URL (pooled, transaction mode)
 *
 * Vì sao Migrate PHẢI dùng session mode: một migration chạy nhiều statement trong
 * cùng một session (tạo type, tạo bảng, tạo index, advisory lock của chính Prisma).
 * Pooler ở transaction mode trả kết nối về pool sau mỗi statement nên trạng thái
 * session biến mất giữa chừng. Đây cũng là điều kiện 1 của ADR-02 cho pg-boss.
 *
 * Với Supabase free tier, DATABASE_URL_DIRECT là **session pooler** (cổng 5432 trên
 * pooler.supabase.com), KHÔNG phải db.<ref>.supabase.co:5432 — host đó chỉ resolve
 * IPv6 nên không kết nối được từ mạng chỉ có IPv4.
 */

// .env nằm ở gốc workspace, không giữ bản sao trong packages/db
loadDotenv({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL_DIRECT"),
  },
});
