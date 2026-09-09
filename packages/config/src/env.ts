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

/**
 * Khoá đối xứng mã hoá base64, PHẢI giải ra đúng `bytes` byte.
 *
 * Kiểm cả tính hợp lệ của base64 lẫn độ dài sau khi giải: AES-256-GCM đòi đúng
 * 32 byte, và một chuỗi ngắn hơn không làm thư viện báo lỗi mà chỉ làm khoá yếu
 * đi một cách âm thầm.
 */
function base64Key(bytes: number) {
  return z.string().superRefine((value, ctx) => {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(value, "base64");
    } catch {
      ctx.addIssue({ code: "custom", message: "không phải base64 hợp lệ" });
      return;
    }
    // Buffer.from bỏ qua ký tự lạ thay vì ném, nên phải so vòng ngược lại
    if (
      decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
    ) {
      ctx.addIssue({ code: "custom", message: "không phải base64 hợp lệ" });
      return;
    }
    if (decoded.length !== bytes) {
      ctx.addIssue({
        code: "custom",
        message: `phải giải ra đúng ${bytes} byte, đang là ${decoded.length}`,
      });
    }
  });
}

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

const envSchema = z
  .object({
    // ---------- Runtime ----------
    /**
     * BAT BUOC khai, khong co gia tri mac dinh.
     *
     * Truoc day no `.default("development")`, va do la mot lo hong im lang: moi
     * luat bao ve trong `.superRefine()` ben duoi deu co dang "cam X khi
     * NODE_ENV === production". Quen dat bien thi gia tri thanh "development",
     * moi luat ay khong bao gio no, va he thong chay o production voi
     * `COOKIE_SECURE` dang tat — dung thu ma chung sinh ra de chan. Go SAI ten
     * thi `z.enum` da nem san; chi rieng BO QUEN la lot.
     *
     * Cai gia phai tra la moi noi chay code nay deu phai khai NODE_ENV. Do la
     * cai gia dung: mot he thong khong biet no dang chay o dau thi khong the tu
     * bao ve minh.
     */
    NODE_ENV: z.enum(["development", "test", "production"]),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error"])
      .default("info"),

    // ---------- Database ----------
    /** Kết nối POOLED (transaction mode) — dùng cho truy vấn CRUD thường */
    /**
     * Chuỗi kết nối pooled của user OWNER.
     *
     * Từ khi mỗi service nối bằng role riêng (§1.2), biến này KHÔNG còn là kết nối
     * runtime của service nào. Nó còn lại hai vai: làm khuôn cho `db:service-login`
     * suy ra host/cổng/tenant khi dựng chuỗi kết nối của từng role, và là đường
     * quản trị cho công cụ. Giữ bắt buộc vì thiếu nó thì không cấp được role nào.
     */
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    /**
     * Kết nối SESSION MODE — bắt buộc, và thường KHÁC `DATABASE_URL`.
     *
     * Ba thứ cần nó vì chúng giữ trạng thái qua nhiều statement trong cùng một
     * session, thứ mà pooler ở transaction mode phá vỡ (§15.3):
     *   - Prisma Migrate: một migration là nhiều statement + advisory lock của Prisma
     *   - pg-boss: `migrate` và `supervise` cũng nhiều statement (ADR-02 điều kiện 1)
     *   - Kênh `LISTEN`: đăng ký gắn với MỘT backend cụ thể; trả kết nối về pool là mất
     *
     * Với Supabase free tier, đây là **session pooler** (cổng 5432 trên
     * `pooler.supabase.com`), KHÔNG phải `db.<ref>.supabase.co:5432` — host đó chỉ
     * resolve IPv6 nên không kết nối được từ mạng chỉ có IPv4.
     *
     * v3 để optional và fallback về `DATABASE_URL`. Với Postgres cục bộ thì vô hại
     * vì hai chuỗi giống nhau; với managed Postgres thì fallback đó làm migration
     * hỏng giữa chừng theo cách rất khó chẩn đoán, nên v4 bắt buộc khai tường minh.
     */
    DATABASE_URL_DIRECT: z.string().url().startsWith("postgresql://"),
    /**
     * Trần số kết nối của pool cho MỖI tiến trình.
     *
     * Đây là giá trị do MÔI TRƯỜNG quy định nên nằm ở đây chứ không ở constants.ts:
     * Supabase free tier cho 60 kết nối và đã dùng sẵn 5 cho hạ tầng của họ, còn
     * Postgres tự dựng thì hoàn toàn khác.
     *
     * Vì sao phải khai tường minh: mặc định của pool là `số CPU × 2 + 1`, tức là
     * 17 kết nối trên một máy 8 nhân — chỉ riêng ba service đã vượt trần, chưa kể
     * pg-boss và kết nối session-pinned cho LISTEN. Lỗi khi đó là `too many
     * connections` lúc chạy, không phải lúc build, nên rất tốn thời gian truy vết.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * Chuỗi kết nối của Service 1 — nối bằng role `udp_s1`, KHÔNG phải owner.
     *
     * BẮT BUỘC, không có fallback về `DATABASE_URL`. Fallback ở đây sẽ làm ma
     * trận writer §1.2 hỏng im lặng: owner có toàn quyền nên mọi GRANT theo cột
     * trở nên vô nghĩa, mà ứng dụng vẫn chạy bình thường và test vẫn xanh. Đúng
     * loại lỗi mà v4 đã bỏ fallback `DATABASE_URL_DIRECT` để tránh.
     *
     * Sinh bằng `pnpm db:service-login`.
     */
    DATABASE_URL_S1: z.string().url().startsWith("postgresql://"),

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
    /**
     * Sàn 12 theo §2.2, không phải 10. Default đúng nhưng sàn sai là loại lỗi im
     * lặng nhất: chỉ lộ ra khi ai đó đặt BCRYPT_ROUNDS=10 ở production, và lúc đó
     * không có gì chặn lại.
     */
    BCRYPT_ROUNDS: z.coerce.number().int().min(12).max(15).default(12),

    // ---------- Envelope encryption (§4.3) ----------
    UDP_KEK_VERSION: z.coerce.number().int().positive().default(1),
    /**
     * KEK 32 byte mã hoá base64 — kiểm NGAY TẠI ĐÂY, không hứa hẹn ở đâu khác.
     *
     * Bản trước ghi "kiểm tra độ dài sau khi giải mã ở refine dưới" trong khi
     * không có refine nào, và `.env.example` để sẵn một chuỗi 30 ký tự không
     * phải base64 — copy rồi chạy là hệ thống khởi động XANH với KEK rác, mã hoá
     * credential cloud của khách bằng khoá sai độ dài. Đúng loại lỗi mà cả file
     * này sinh ra để chặn.
     */
    UDP_KEK_V1: base64Key(32),

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
    /**
     * KHÔNG dùng nữa — giữ lại để nói rõ vì sao nó biến mất.
     *
     * Khai `domain` trên cookie biến chúng từ host-only thành domain-scoped: mọi
     * subdomain đọc và gửi được, và vì `udp_csrf` cố ý không httpOnly, một trang
     * trên subdomain bất kỳ chỉ cần `document.cookie` là vượt được CSRF. Cookie
     * giờ để host-only. Nếu sau này Portal thật sự phải nằm ở subdomain khác API,
     * cách đúng là CORS kèm credentials, không phải nới phạm vi cookie.
     */
    COOKIE_DOMAIN: z.string().default("localhost"),
    COOKIE_SECURE: bool.default("false"),
    /**
     * Số proxy tin cậy đứng trước ứng dụng.
     *
     * Rate limit đếm theo `req.ip`, mà `req.ip` do Express suy từ `X-Forwarded-For`
     * theo đúng con số này. Đặt cao hơn thực tế nghĩa là tin một entry do CLIENT
     * ghi, và kẻ tấn công tự chọn IP để mỗi request rơi vào một bucket mới — rate
     * limit thành trang trí. Đặt thấp hơn thực tế thì mọi request chung một IP
     * proxy và người dùng thật chặn lẫn nhau. Không có giá trị nào đúng cho mọi
     * nơi triển khai, nên nó phải là biến chứ không phải hằng số trong code.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    // ---------- Progressive delivery ----------

    // ---------- Change feed (ADR-05) ----------
    /**
     * `snapshot` = chỉ tầng 1. `delta` = bật thêm tầng 2 (con trỏ config_version).
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
  })
  /**
   * Ràng buộc LIÊN BIẾN — thứ không kiểm được khi xét từng biến một.
   *
   * Cả ba đều là loại lỗi im lặng: hệ thống chạy bình thường, không có gì báo,
   * và hậu quả chỉ lộ ra khi bị tấn công hoặc khi đã muộn.
   */
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_REFRESH_SECRET"],
        message:
          "phải KHÁC JWT_ACCESS_SECRET — dùng chung thì refresh token (7 ngày) " +
          "verify được như access token, và hạn 15 phút mất tác dụng hoàn toàn",
      });
    }

    if (env.NODE_ENV === "production" && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message:
          "phải là true ở production — nếu không, cookie phiên đi qua HTTP thuần " +
          "và một lần nghe lén là mất phiên",
      });
    }

    // UDP_KEK_VERSION tồn tại để xoay KEK. Đặt version 2 mà không có UDP_KEK_V2
    // thì lúc chạy tra ra undefined — xoay khoá làm hệ thống hỏng âm thầm.
    if (env.UDP_KEK_VERSION !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["UDP_KEK_VERSION"],
        message: `chỉ hỗ trợ version 1 — chưa khai biến UDP_KEK_V${env.UDP_KEK_VERSION}`,
      });
    }
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

/**
 * Kết nối session mode cho migration, pg-boss và kênh NOTIFY (§15.3).
 * Không còn fallback về DATABASE_URL: env schema đã bắt buộc khai tường minh,
 * vì một fallback âm thầm sang pooled connection làm migration hỏng giữa chừng.
 */
export const directDatabaseUrl = env.DATABASE_URL_DIRECT;

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";
