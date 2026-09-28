import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { SDK_STATS } from "./constants.js";

/**
 * Schema của mọi biến môi trường — KHÔNG tác dụng phụ (không đọc `process.env`, không nạp `.env`).
 * `env.ts` parse `process.env` bằng nó lúc khởi động; công cụ triển khai kiểm cấu hình SINH RA cho
 * cluster bằng CHÍNH nó (`deploy/`, Plan #49) — hai nơi không thể lệch nhau.
 */

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

/**
 * [v4.11] Khoá riêng RSA dạng PEM, MÃ HOÁ BASE64 để nằm gọn trên một dòng `.env`.
 *
 * Kiểm ngay tại đây rằng nó là khoá RSA đọc được và dài ≥ 2048 bit: một khoá hỏng mà chỉ
 * lộ ra lúc cloud của khách gọi đổi token là một lỗi xa chỗ phải sửa tới ba bước.
 */
function rsaPrivateKeyBase64Pem() {
  return z.string().superRefine((value, ctx) => {
    try {
      const key = createPrivateKey(
        Buffer.from(value, "base64").toString("utf8"),
      );
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
      if (key.asymmetricKeyType !== "rsa" || bits < 2048) {
        ctx.addIssue({
          code: "custom",
          message: `phải là khoá RSA ≥ 2048 bit, đang là ${String(key.asymmetricKeyType)} ${String(bits)} bit`,
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "không phải base64 của một khoá riêng PEM đọc được",
      });
    }
  });
}

/**
 * [v4.11] Biến TUỲ CHỌN mà chuỗi rỗng nghĩa là "chưa đặt".
 *
 * `.env.example` từng khai các biến tuỳ chọn là `KEY=""`, và `.env` chép từ đó mang chuỗi
 * rỗng. Không có bước này thì chuỗi rỗng đi thẳng vào `.regex()`/`.uuid()` và một môi
 * trường không bật tính năng ấy lại không khởi động được.
 */
function optionalSetting<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
}

/** Issuer OIDC: URL tuyệt đối, không query/fragment, không `/` cuối (OpenID Discovery §3) */
const oidcIssuerUrl = z
  .string()
  .url()
  .refine(
    (v) => !v.endsWith("/") && !v.includes("?") && !v.includes("#"),
    "không có `/` cuối, query hay fragment",
  );

export const envSchema = z
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
     * Hai thứ cần nó vì chúng giữ trạng thái qua nhiều statement trong cùng một
     * session, thứ mà pooler ở transaction mode phá vỡ (§15.3):
     *   - Prisma Migrate: một migration là nhiều statement + advisory lock của Prisma
     *   - pg-boss: `migrate` và `supervise` cũng nhiều statement (ADR-02 điều kiện 1)
     *
     * Kênh `LISTEN` của tầng 3 cũng cần session mode, nhưng KHÔNG đi bằng chuỗi này:
     * chuỗi này là owner, còn kênh nghe chạy bằng role của chính service — xem
     * `DATABASE_URL_S2_DIRECT`.
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
    /**
     * Chuoi ket noi cua Service 2 — noi bang role `udp_s2`.
     *
     * Cung ly do voi S1: khong fallback. Nhung o day con mot ly do rieng —
     * `udp_s2` chi duoc UPDATE dung HAI cot cua `environments`
     * (`config_version`, `config_hash`). Neu chuoi ket noi roi ve owner thi
     * gioi han ay bien mat, va mot loi lap trinh cua S2 ghi de `name` hay
     * `k8s_namespace` cua environment se thanh cong im lang.
     *
     * Sinh bang `pnpm db:service-login udp_s2`.
     */
    DATABASE_URL_S2: z.string().url().startsWith("postgresql://"),
    /**
     * Chuỗi kết nối của Service 3 — nối bằng role `udp_s3`.
     *
     * Cùng luật với S1/S2: không fallback. `udp_s3` là role hẹp nhất (§1.2: tám
     * cột của `rollout_sessions`, INSERT event, và đúng một cột `serve` của rule
     * cho kill-switch). Rơi về owner là S3 ghi được mọi thứ, và một bug của
     * reconciler sẽ sửa cấu hình flag của người dùng mà không ai chặn.
     *
     * Sinh bằng `pnpm db:service-login udp_s3`.
     */
    DATABASE_URL_S3: z.string().url().startsWith("postgresql://"),
    /**
     * Kênh LISTEN của tầng 3 (ADR-05) — role `udp_s2`, SESSION MODE (cổng 5432).
     *
     * Vì sao một chuỗi riêng: `LISTEN` gắn với MỘT backend nên không đi qua pooler
     * transaction mode được — đã đo: qua 6543 không nhận notification nào trong 5
     * giây, qua 5432 nhận sau ~150ms. Và vì sao không dùng `DATABASE_URL_DIRECT`:
     * chuỗi đó là owner, đưa nó vào runtime của S2 là bỏ ranh giới quyền mà
     * `DATABASE_URL_S2` dựng lên. Kết nối nghe chạy bằng chính `udp_s2`, và S2
     * khẳng định `current_user` của nó trước khi mở cổng.
     *
     * Chỉ bắt buộc khi `CHANGEFEED_NOTIFY_ENABLED` bật — xem luật liên biến bên
     * dưới. Sinh CÙNG LÚC với `DATABASE_URL_S2` bằng `pnpm db:service-login udp_s2`.
     */
    DATABASE_URL_S2_DIRECT: z
      .string()
      .url()
      .startsWith("postgresql://")
      .optional(),
    /**
     * [v4.3] Kênh `LISTEN rollout_intent` của Service 3 (§7.6) — role `udp_s3`,
     * SESSION MODE (cổng 5432), cùng lý do với `DATABASE_URL_S2_DIRECT`: LISTEN
     * không đi qua pooler transaction mode, và kênh nghe không được chạy bằng
     * owner. Bắt buộc khi `ROLLOUT_INTENT_LISTEN_ENABLED` bật. Sinh CÙNG LÚC với
     * `DATABASE_URL_S3` bằng `pnpm db:service-login udp_s3`.
     */
    DATABASE_URL_S3_DIRECT: z
      .string()
      .url()
      .startsWith("postgresql://")
      .optional(),

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
    /**
     * [v4.10] Trần là 2 vì `UDP_KEK_V2` là biến cuối cùng tồn tại.
     *
     * Một trần cao hơn là một lời hứa về những biến chưa có: `UDP_KEK_VERSION = 3` sẽ đi
     * qua schema rồi vỡ ở refine — đúng, nhưng muộn hơn và với thông điệp khó hiểu hơn
     * "phải ≤ 2".
     */
    UDP_KEK_VERSION: z.coerce.number().int().min(1).max(2).default(1),
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
    /**
     * [v4.10] KEK version 2 — TUỲ CHỌN, và nó phải tuỳ chọn.
     *
     * Xoay KEK là việc hiếm, nên đòi biến này luôn có nghĩa là mọi môi trường phải sinh
     * một khoá thứ hai không dùng tới — và một khoá không dùng tới là khoá không ai xoay,
     * không ai soát, nhưng vẫn mở được mọi credential nếu nó rò.
     */
    UDP_KEK_V2: base64Key(32).optional(),

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
    /**
     * [v4.11] Tuỳ chọn: chỉ `GET /admin/system/health` của Service 1 hỏi Service 3, và
     * thiếu URL thì trang admin nói "không rõ" chứ không đoán `localhost`.
     */
    PD_CONTROLLER_URL: z.string().url().optional(),
    /**
     * [v4.11, Plan #51 QĐ-9] URL gốc của Service 3 nhìn từ cluster TENANT — Service 1 ghi nó vào webhook gate của
     * `Canary` (Flagger gọi về S3 trước mỗi bậc). Khác `PD_CONTROLLER_URL` (địa chỉ trong mạng của control
     * plane). Thiếu ⇒ rollout SERVICE_LEVEL với Flagger trả 422, Argo Rollouts không cần nó.
     */
    PD_CONTROLLER_WEBHOOK_URL: z.string().url().optional(),
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
    /**
     * Tầng 3 (ADR-05) — bật/tắt CẢ HAI phía: writer phát `NOTIFY` trong transaction
     * ghi, và replica S2 `LISTEN` qua `DATABASE_URL_S2_DIRECT`.
     *
     * Hai phía đi cùng một cờ vì cả hai đều có giá: `NOTIFY` bắt commit của mọi
     * transaction có nó xếp hàng qua một khoá toàn cục của PostgreSQL
     * (`PreCommit_Notify` trong `async.c`). Tắt cờ mà writer vẫn phát thì cấu hình
     * "không NOTIFY" của phép đo E4 vẫn trả giá đó — không phải đối chứng sạch.
     *
     * Tắt khi chỉ có chuỗi qua pooler transaction mode: hệ thống vẫn đúng, độ trễ
     * nền quay về chu kỳ poll 500ms.
     */
    CHANGEFEED_NOTIFY_ENABLED: bool.default("true"),
    /**
     * [v4.3] Service 3 nghe `NOTIFY rollout_intent` để xử lý intent ngay (§7.6).
     * Cờ RIÊNG, không dùng chung `CHANGEFEED_NOTIFY_ENABLED`: cờ kia là công tắc
     * đối chứng của phép đo E4 trên đường lan truyền cấu hình, còn kênh này chỉ đổi
     * độ trễ xử lý intent (≤ 5 giây vòng quét ⇒ ~0,5 giây). Tắt thì intent vẫn
     * được xử lý ở vòng quét kế — đúng, chỉ chậm hơn.
     */
    ROLLOUT_INTENT_LISTEN_ENABLED: bool.default("true"),

    // ---------- Telemetry đánh giá flag (§2.2 FlagEvaluationStat) ----------
    /**
     * [v4.9] Chu kỳ Service 2 đẩy số đếm `/sdk/stats` đang gộp trong bộ nhớ xuống
     * `flag_evaluation_stats`. Là biến môi trường chứ không chỉ hằng số vì test
     * tích hợp (provider chạy với Service 2 là tiến trình con) cần chu kỳ ngắn để
     * không chờ 15 giây; mặc định và sàn lấy từ `SDK_STATS.ingest`.
     */
    SDK_STATS_FLUSH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(SDK_STATS.ingest.minFlushIntervalMs)
      .default(SDK_STATS.ingest.flushIntervalMs),

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

    // ---------- UDP là OIDC issuer (Plan #26 QĐ-5, tuỳ chọn) ----------
    /**
     * [v4.11] Federation GCP (Workload Identity) và Azure (federated credential) tin token
     * do UDP ký: cloud của khách đọc `<issuer>/.well-known/openid-configuration` rồi JWKS.
     * Hai biến đi CÙNG NHAU; thiếu cả hai thì federation GCP/Azure báo lỗi cấu hình rõ
     * ràng, còn credential tĩnh và AWS (AssumeRole) vẫn chạy.
     */
    UDP_OIDC_ISSUER: optionalSetting(oidcIssuerUrl),
    UDP_OIDC_SIGNING_KEY: optionalSetting(rsaPrivateKeyBase64Pem()),

    // ---------- AWS federation: UDP là bên được tin (Plan #26 QĐ-5, tuỳ chọn) ----------
    /**
     * [v4.11] `AWS_ROLE`: khách tạo role tin `UDP_AWS_PRINCIPAL_ARN` với điều kiện
     * `sts:ExternalId` = HMAC-SHA256(`UDP_EXTERNAL_ID_SECRET`, projectId) — tất định theo
     * project, không đoán được, không phải lưu. Principal PHẢI là identity nền mà Service 1
     * chạy dưới nó (IRSA / instance role), vì chính nó gọi `sts:AssumeRole`. Hai biến đi
     * cùng nhau; thiếu cả hai thì `AWS_ROLE` báo "chưa bật", khoá tĩnh vẫn chạy.
     */
    UDP_AWS_PRINCIPAL_ARN: optionalSetting(
      z
        .string()
        .regex(
          /^arn:aws[\w-]*:iam::\d{12}:(role|user)\/[\w+=,.@/-]{1,512}$/,
          "phải là ARN của một IAM role hoặc user",
        ),
    ),
    UDP_EXTERNAL_ID_SECRET: optionalSetting(z.string().min(32)),

    // ---------- Cloud MANAGED mode (tuỳ chọn) ----------
    /**
     * [v4.11] Cloud mà UDP nhận triển khai vào tài khoản CỦA CHÍNH NÓ, dùng identity nền
     * của platform (§4.3: IRSA / workload identity / managed identity) — không khoá tĩnh
     * nào trong env. Danh sách phân tách bằng dấu phẩy; rỗng = không nhận MANAGED.
     */
    MANAGED_CLOUDS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== ""),
      )
      .pipe(z.array(z.enum(["aws", "gcp", "azure"]))),
    /** Project GCP đích của MANAGED — bắt buộc khi `gcp` có trong `MANAGED_CLOUDS` */
    MANAGED_GCP_PROJECT_ID: optionalSetting(
      z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    ),
    /** Subscription + resource group đích của MANAGED — bắt buộc khi có `azure` */
    MANAGED_AZURE_SUBSCRIPTION_ID: optionalSetting(z.string().uuid()),
    MANAGED_AZURE_RESOURCE_GROUP: optionalSetting(
      z.string().regex(/^[\w().-]{1,90}$/),
    ),

    // ---------- Provisioning (Plan #28, ADR-06) ----------
    /**
     * [v4.11] Địa chỉ egress của UDP (CIDR IPv4, phân tách bằng dấu phẩy): API endpoint
     * public của cluster khách chỉ mở cho các dải này (`publicAccessCidrs`). Rỗng = triển
     * khai này không provisioning được — `POST /provision` nói thẳng, không mở endpoint
     * ra `0.0.0.0/0` thay cho người vận hành.
     */
    UDP_EGRESS_CIDRS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== ""),
      )
      .pipe(
        z.array(
          z
            .string()
            .regex(
              /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([0-9]|[12]\d|3[0-2])$/,
              "phải là CIDR IPv4, ví dụ 203.0.113.0/24",
            ),
        ),
      ),
  })
  /**
   * Ràng buộc LIÊN BIẾN — thứ không kiểm được khi xét từng biến một.
   *
   * Ba luật đầu là loại lỗi im lặng: hệ thống chạy bình thường, không có gì báo,
   * và hậu quả chỉ lộ ra khi bị tấn công hoặc khi đã muộn. Luật cuối chặn một cấu
   * hình nửa vời của tầng 3: bật cờ mà thiếu chuỗi thì kênh nghe hỏng ngay lúc
   * Service 2 khởi động, xa chỗ phải sửa.
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

    /**
     * [v4.10] MỌI `v` trong `[1, UDP_KEK_VERSION]` đều phải có biến `UDP_KEK_V<v>`.
     *
     * Bản trước chỉ đòi `UDP_KEK_VERSION === 1`, tức nó chặn được việc xoay khoá nhưng
     * KHÔNG phát biểu được điều kiện thật. Guard yếu hơn — chỉ đòi biến của version hiện
     * tại — là guard làm một hệ thống đặt `UDP_KEK_VERSION = 2` mà thiếu `UDP_KEK_V1`
     * khởi động XANH, rồi mất mọi hàng còn `kek_version = 1`. Và những hàng đó không mất
     * ồn ào: chúng chỉ không giải mã được nữa, vào đúng lúc người ta đang xoay khoá vì
     * nghi khoá bị lộ.
     *
     * **Ai bảo vệ `v = 1`:** không phải vòng lặp này mà chính schema — `UDP_KEK_V1` là
     * `base64Key(32)` không `.optional()`, nên một môi trường thiếu nó không qua được
     * bước parse, bất kể `UDP_KEK_VERSION` bằng mấy. Vòng lặp hôm nay do đó chỉ thật sự
     * kiểm `v = 2`. Viết ra điều này vì một chú thích nói "vòng lặp bảo vệ mọi v" là một
     * chú thích làm người đọc tin rằng có thể hạ `UDP_KEK_V1` xuống `.optional()` mà
     * không mất gì.
     *
     * Vẫn là một vòng lặp chứ không phải một câu `if` cho `v = 2`: hình dạng của điều
     * kiện là "với mọi v", và viết đúng hình dạng đó là cách version 3 không cần ai nhớ
     * ra phải thêm một câu `if` nữa.
     */
    const keks: Readonly<Record<number, string | undefined>> = {
      1: env.UDP_KEK_V1,
      2: env.UDP_KEK_V2,
    };
    for (let v = 1; v <= env.UDP_KEK_VERSION; v += 1) {
      if (keks[v] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [`UDP_KEK_V${String(v)}`],
          message:
            `thiếu khi UDP_KEK_VERSION = ${String(env.UDP_KEK_VERSION)} — ` +
            `mọi hàng còn kek_version = ${String(v)} sẽ không giải mã được`,
        });
      }
    }

    /**
     * Xoay khoá mà khoá mới TRÙNG khoá cũ là không xoay gì cả.
     *
     * Ca này không phải giả thuyết: cách nhanh nhất để "thử xoay khoá" là copy giá trị
     * `UDP_KEK_V1` sang `UDP_KEK_V2` rồi tăng version. Mọi thứ chạy, `kek_version` lên 2,
     * job `rotate-kek` báo thành công — và khoá được cho là đã thay thì vẫn mở được toàn
     * bộ dữ liệu cũ lẫn mới.
     */
    if (env.UDP_KEK_V2 !== undefined && env.UDP_KEK_V2 === env.UDP_KEK_V1) {
      ctx.addIssue({
        code: "custom",
        path: ["UDP_KEK_V2"],
        message:
          "trùng UDP_KEK_V1 — xoay khoá sang chính khoá cũ không thay thế gì",
      });
    }

    if (
      (env.UDP_AWS_PRINCIPAL_ARN === undefined) !==
      (env.UDP_EXTERNAL_ID_SECRET === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: [
          env.UDP_AWS_PRINCIPAL_ARN === undefined
            ? "UDP_AWS_PRINCIPAL_ARN"
            : "UDP_EXTERNAL_ID_SECRET",
        ],
        message:
          "UDP_AWS_PRINCIPAL_ARN và UDP_EXTERNAL_ID_SECRET đi cùng nhau — trust policy " +
          "của khách cần cả principal lẫn ExternalId",
      });
    }

    if (
      env.MANAGED_CLOUDS.includes("gcp") &&
      env.MANAGED_GCP_PROJECT_ID === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["MANAGED_GCP_PROJECT_ID"],
        message:
          "bắt buộc khi MANAGED_CLOUDS có gcp — MANAGED cần biết project đích",
      });
    }
    if (
      env.MANAGED_CLOUDS.includes("azure") &&
      (env.MANAGED_AZURE_SUBSCRIPTION_ID === undefined ||
        env.MANAGED_AZURE_RESOURCE_GROUP === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["MANAGED_AZURE_RESOURCE_GROUP"],
        message:
          "MANAGED_AZURE_SUBSCRIPTION_ID và MANAGED_AZURE_RESOURCE_GROUP bắt buộc khi " +
          "MANAGED_CLOUDS có azure",
      });
    }

    if (
      (env.UDP_OIDC_ISSUER === undefined) !==
      (env.UDP_OIDC_SIGNING_KEY === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: [
          env.UDP_OIDC_ISSUER === undefined
            ? "UDP_OIDC_ISSUER"
            : "UDP_OIDC_SIGNING_KEY",
        ],
        message:
          "UDP_OIDC_ISSUER và UDP_OIDC_SIGNING_KEY đi cùng nhau — có issuer mà không " +
          "khoá thì không ký được token, có khoá mà không issuer thì cloud không tìm được JWKS",
      });
    }

    if (
      env.NODE_ENV === "production" &&
      env.UDP_OIDC_ISSUER !== undefined &&
      !env.UDP_OIDC_ISSUER.startsWith("https://")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["UDP_OIDC_ISSUER"],
        message:
          "phải là https ở production — Google STS và Entra ID chỉ tin issuer https",
      });
    }

    if (
      env.CHANGEFEED_NOTIFY_ENABLED &&
      env.DATABASE_URL_S2_DIRECT === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL_S2_DIRECT"],
        message:
          "bắt buộc khi CHANGEFEED_NOTIFY_ENABLED=true — kênh LISTEN của tầng 3 cần chuỗi " +
          "SESSION MODE của role udp_s2 (`pnpm db:service-login udp_s2`), hoặc đặt " +
          "CHANGEFEED_NOTIFY_ENABLED=false khi chỉ có chuỗi qua pooler",
      });
    }

    if (
      env.ROLLOUT_INTENT_LISTEN_ENABLED &&
      env.DATABASE_URL_S3_DIRECT === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL_S3_DIRECT"],
        message:
          "bắt buộc khi ROLLOUT_INTENT_LISTEN_ENABLED=true — kênh LISTEN rollout_intent cần " +
          "chuỗi SESSION MODE của role udp_s3 (`pnpm db:service-login udp_s3`), hoặc đặt " +
          "ROLLOUT_INTENT_LISTEN_ENABLED=false",
      });
    }
  });
