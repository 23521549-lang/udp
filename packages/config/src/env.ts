import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { envSchema } from "./env-schema.js";

/**
 * Cấu hình môi trường — nguồn sự thật DUY NHẤT cho mọi biến môi trường.
 *
 * Vì sao cần lớp này thay vì đọc thẳng process.env:
 *
 *  1. Fail-fast. Thiếu biến hoặc sai định dạng thì tiến trình dừng NGAY lúc
 *     khởi động với thông báo rõ ràng, thay vì trả về `undefined` rồi nổ ở
 *     một chỗ sâu trong code sau vài giờ chạy.
 *  2. Không magic string. Gõ sai `DATABSE_URL` sẽ bị TypeScript bắt, còn
 *     `process.env.DATABSE_URL` thì im lặng trả về undefined.
 *  3. Ép kiểu một chỗ. Cổng là số, cờ là boolean — không rải `Number(...)`
 *     và `=== "true"` khắp nơi.
 *  4. Tài liệu sống. Schema này CHÍNH LÀ danh sách biến môi trường;
 *     `.env.example` chỉ là bản chép ra cho người đọc.
 */

// Nạp .env ở gốc workspace. Đi lên từ packages/config/src → gốc.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // Dừng ngay khi khởi động thay vì hỏng ngẫu nhiên lúc đang chạy.
  throw new Error(
    `Cấu hình môi trường không hợp lệ:\n${issues}\n\n` +
      `Đối chiếu với .env.example ở gốc workspace.`,
  );
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;

/**
 * Kết nối session mode (owner) cho migration và pg-boss (§15.3). Kênh LISTEN của
 * tầng 3 KHÔNG dùng chuỗi này — nó chạy bằng role của service (`DATABASE_URL_S2_DIRECT`).
 * Không còn fallback về DATABASE_URL: env schema đã bắt buộc khai tường minh,
 * vì một fallback âm thầm sang pooled connection làm migration hỏng giữa chừng.
 */
export const directDatabaseUrl = env.DATABASE_URL_DIRECT;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";
