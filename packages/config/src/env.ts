import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const port = z.coerce.number().int().min(1).max(65_535);

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;
type DurationUnit = keyof typeof SECONDS_PER_UNIT;

/**
 * Thời lượng dạng người đọc được (`15m`, `7d`) → số GIÂY.
 *
 * Hai lợi ích so với việc giữ nguyên chuỗi:
 *  - `.env` vẫn dễ đọc, nhưng code nhận về một con số dùng được ngay cho cả
 *    JWT lẫn `maxAge` của cookie. Trước đây TTL viết ở `.env` còn `maxAge` lại
 *    hardcode trong code — hai nguồn sự thật cho cùng một giá trị.
 *  - Gõ sai (`15mm`, `1 hour`) bị bắt ngay lúc khởi động thay vì tạo ra token
 *    có thời hạn kỳ quặc mà không ai để ý.
 */
const durationSeconds = z
  .string()
  .regex(
    /^\d+[smhd]$/,
    "Thời lượng phải có dạng số kèm đơn vị s/m/h/d, ví dụ 15m",
  )
  .transform((value) => {
    const amount = Number(value.slice(0, -1));
    const unit = value.slice(-1) as DurationUnit;
    return amount * SECONDS_PER_UNIT[unit];
  });

const envSchema = z.object({
  // ---------- Runtime ----------
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),

  // ---------- Database ----------
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  /**
   * Kết nối trực tiếp (session mode) — dùng cho migration, pg-boss và kênh
   * NOTIFY. Xem §15.3: hai cơ chế này ngừng hoạt động sau connection pooler
   * ở chế độ transaction. Bỏ trống thì dùng chung DATABASE_URL.
   */
  DATABASE_URL_DIRECT: z.string().url().optional(),

  // ---------- Auth ----------
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "JWT secret phải dài tối thiểu 32 ký tự"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT secret phải dài tối thiểu 32 ký tự"),
  /** Đọc vào dạng "15m", dùng ra dạng số giây */
  JWT_ACCESS_TTL: durationSeconds.default("15m"),
  JWT_REFRESH_TTL: durationSeconds.default("7d"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // ---------- Envelope encryption (§4.3) ----------
  UDP_KEK_VERSION: z.coerce.number().int().positive().default(1),
  /** KEK 32 byte mã hoá base64 — kiểm tra độ dài sau khi giải mã ở refine dưới */
  UDP_KEK_V1: z.string().min(1),

  // ---------- Bí mật nội bộ giữa 3 service ----------
  INTERNAL_SERVICE_SECRET: z.string().min(32),

  // ---------- Ports ----------
  CORE_BACKEND_PORT: port.default(3001),
  FLAG_SERVICE_PORT: port.default(3002),
  PD_CONTROLLER_PORT: port.default(3003),
  PORTAL_PORT: port.default(5173),

  // ---------- URL nội bộ ----------
  FLAG_SERVICE_URL: z.string().url(),
  CORE_BACKEND_URL: z.string().url(),
  PROMETHEUS_URL: z.string().url(),

  // ---------- CORS / Cookie ----------
  CORS_ORIGIN: z.string().url(),
  COOKIE_DOMAIN: z.string().default("localhost"),
  COOKIE_SECURE: bool.default("false"),

  // ---------- Progressive delivery ----------
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // ---------- Change feed (ADR-05) ----------
  /**
   * `snapshot` = chỉ tầng 1. `delta` = bật thêm tầng 2 (con trỏ xid8).
   * Cho phép đo đối chứng hai chế độ trên cùng hệ thống — phép đo E4 (§14).
   */
  CHANGEFEED_MODE: z.enum(["snapshot", "delta"]).default("snapshot"),
  /** Bật LISTEN/NOTIFY làm tầng 3. Tắt khi triển khai sau pooler. */
  CHANGEFEED_NOTIFY_ENABLED: bool.default("true"),

  // ---------- Job queue ----------
  /**
   * Thời hạn thực thi job, tính bằng phút. PHẢI lớn hơn thời gian provisioning
   * tối đa (EKS mất 15–20 phút). Đặt quá ngắn thì pg-boss giao lại job đang
   * chạy cho worker khác ⇒ tạo cluster thứ hai trên tài khoản của developer.
   * Xem ADR-02, điều kiện 2.
   */
  JOB_EXPIRE_MINUTES: z.coerce.number().int().min(30).default(45),
  JOB_RETRY_LIMIT: z.coerce.number().int().min(0).default(3),
  PGBOSS_SCHEMA: z.string().default("pgboss"),

  // ---------- Cloud MANAGED mode (tuỳ chọn) ----------
  MANAGED_AWS_ACCESS_KEY_ID: z.string().optional(),
  MANAGED_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  MANAGED_AWS_REGION: z.string().default("ap-southeast-1"),
  MANAGED_GCP_SERVICE_ACCOUNT_JSON: z.string().optional(),
  MANAGED_GCP_PROJECT_ID: z.string().optional(),
  MANAGED_AZURE_TENANT_ID: z.string().optional(),
  MANAGED_AZURE_CLIENT_ID: z.string().optional(),
  MANAGED_AZURE_CLIENT_SECRET: z.string().optional(),
  MANAGED_AZURE_SUBSCRIPTION_ID: z.string().optional(),
});

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

/** Kết nối direct dùng cho migration, pg-boss, NOTIFY (§15.3) */
export const directDatabaseUrl = env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";
