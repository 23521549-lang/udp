import pino from "pino";
import {
  env,
  isDevelopment,
  REDACT_ALLOWLIST,
  REDACTED_KEY_PATTERNS,
  REDACTED_PLACEHOLDER,
} from "@udp/config";

/**
 * Logger dùng chung.
 *
 * Điểm quan trọng nhất ở đây là REDACT. Dự án giữ credential cloud của người
 * khác; một dòng `logger.info({ credential })` vô ý là rò rỉ thật. Danh sách
 * khóa nhạy cảm dùng CHUNG với AuditLog và ProvisioningJob.lastError, khai báo
 * một chỗ ở @udp/config để không có nơi nào quên.
 */

/**
 * pino chỉ nhận ĐƯỜNG DẪN cụ thể, không nhận regex — nên danh sách này KHÔNG
 * sinh ra được từ `REDACTED_KEY_PATTERNS`, nó là bản khai thứ hai viết tay.
 *
 * Sự trùng lặp đó được KIỂM chứ không được tin: test `logger-redact` khẳng định
 * HAI CHIỀU — mọi khoá lá ở đây khớp một pattern bên `@udp/config`, VÀ mọi
 * pattern bên đó có ít nhất một đường dẫn ở đây. Chiều thứ hai mới là chiều gây
 * rò rỉ, và nó từng bị bỏ sót.
 *
 * GIỚI HẠN phải biết: `*.x` của pino là wildcard MỘT CẤP — nó khớp `{a:{x}}`
 * nhưng KHÔNG khớp `{x}` hay `{a:{b:{x}}}`. `redact()` thì đệ quy vô hạn. Hai
 * cơ chế không tương đương về độ sâu, và không có cách nào làm chúng tương
 * đương bằng danh sách path. Vì vậy mọi thứ có thể chứa secret phải đi qua
 * `redact()` TRƯỚC khi tới logger, chứ đừng trông vào `redact.paths`.
 * Thêm một đường dẫn ở đây mà quên thêm pattern bên kia sẽ làm test đỏ — vì
 * `redact()` dùng cho AuditLog đi theo pattern, còn log request đi theo danh
 * sách này, và hai bên lệch nhau nghĩa là secret bị che ở một nơi, lộ ở nơi kia.
 */
export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.secret",
  "*.credential",
  "*.encryptedPayload",
  "*.encryptedDek",
  "*.serviceAccountJson",
  "*.accessKeyId",
  "*.secretAccessKey",
  "*.clientSecret",
  // Nhóm dưới đây từng THIẾU trong khi `REDACTED_KEY_PATTERNS` đã có, và test
  // chỉ kiểm chiều paths → patterns nên không thấy. Chiều bỏ sót lại đúng là
  // chiều gây rò rỉ: `redact()` che chúng ở AuditLog, pino thì để nguyên trong
  // log request.
  "*.passwd",
  "*.apiKey",
  "*.apikey",
  "*.api_key",
  "*.privateKey",
  "*.sshKey",
  "*.webhookKey",
  "*.kubeconfigKey",
  "*.bucketSalt",
  // [v4.9] Plaintext SDK key trong response tạo khoá — nằm CẠNH `key`, không trong nó
  "*.secretKey",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: REDACTED_PLACEHOLDER },
  ...(isDevelopment
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
});

/**
 * Một khoá là nhạy cảm khi nó khớp pattern VÀ không nằm trong allowlist.
 *
 * Thứ tự đó quan trọng: allowlist là ngoại lệ hẹp cho những cái tên kết thúc
 * bằng "key" mà lại là định danh hiển thị (`targetingKey`, `idempotencyKey`).
 * Đảo thứ tự — allowlist trước — sẽ biến nó thành cửa hậu cho mọi khoá thật.
 */
export function isSensitive(key: string): boolean {
  if (REDACT_ALLOWLIST.some((p) => p.test(key))) return false;
  return REDACTED_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Che giá trị nhạy cảm trong object bất kỳ trước khi ghi AuditLog hay lưu
 * lastError. Đệ quy, giữ nguyên cấu trúc để diff before/after vẫn đọc được.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet());
}

/** Chỗ của một tham chiếu vòng — xem chú thích trong `redactInner` */
export const REDACTED_CYCLE = "[CYCLE]";

/**
 * [v4.10] Trường của `Error` được GIỮ LẠI, và vì sao điều đó là một bản sửa an toàn.
 *
 * `message`, `name`, `stack` và `cause` của `Error` là thuộc tính **không liệt kê được**,
 * nên `Object.entries(err)` trả rỗng và bản trước biến mọi lỗi thành `{}`. Đã đo:
 * `redact(new Error("x", { cause: inner }))` ra đúng `{}`.
 *
 * Hậu quả có hai mặt, và mặt thứ hai mới là lý do phải sửa:
 *
 *  1. Bí mật nằm sâu trong lỗi (`err.cause.config.headers.Authorization` — I12, §12 T3)
 *     **biến mất**, nên nó an toàn. Nhưng nó an toàn do TÌNH CỜ, không do luật: hàm không
 *     hề che nó, nó chỉ không nhìn thấy gì. Một lần ai đó thêm nhánh đọc `err.message`
 *     là lỗ hổng mở lại, và không phép kiểm nào đỏ.
 *  2. `ProvisioningJob.lastError` và `AuditLog.before/after` nhận `{}` cho MỌI lỗi, tức
 *     những cột tồn tại để chẩn đoán thì không mang thông tin nào.
 *
 * `stack` KHÔNG được giữ, có chủ đích: `lastError` dùng cho retry và hiển thị (§2.2) nên
 * mã lỗi cộng thông điệp là đủ, còn stack thì dài và đã có trong log qua serializer của
 * pino. Giữ nó ở đây là nhân đôi dữ liệu lớn nhất vào một cột JSONB của mọi job thất bại.
 */
const ERROR_FIELDS = ["name", "message", "code"] as const;

function redactInner<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object") return value;
  // Date là object không có khoá riêng — đệ quy biến nó thành `{}`, và
  // `current.updatedAt` của 409 OPTIMISTIC_LOCK tới Portal thành rỗng (QA Plan #19)
  if (value instanceof Date) return value;

  /**
   * Vòng tham chiếu.
   *
   * Không phải giả thuyết: `err.cause = err` xảy ra khi một lớp bọc lỗi gói lại chính nó,
   * và nhiều SDK giữ tham chiếu ngược từ `response` về `request`. Bản trước không có guard
   * nào, nên một object như thế làm hàm này đệ quy tới tràn stack — trong đường ghi audit,
   * tức một lần ghi audit làm sập tiến trình.
   */
  if (seen.has(value)) return REDACTED_CYCLE as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, seen)) as T;
  }

  const result: Record<string, unknown> = {};

  if (value instanceof Error) {
    for (const field of ERROR_FIELDS) {
      const val = (value as unknown as Record<string, unknown>)[field];
      if (val !== undefined) {
        result[field] = isSensitive(field)
          ? REDACTED_PLACEHOLDER
          : redactInner(val, seen);
      }
    }
    if (value.cause !== undefined) {
      result["cause"] = redactInner(value.cause, seen);
    }
  }

  for (const [key, val] of Object.entries(value)) {
    result[key] = isSensitive(key)
      ? REDACTED_PLACEHOLDER
      : redactInner(val, seen);
  }
  return result as T;
}
