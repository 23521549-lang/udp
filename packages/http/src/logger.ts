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
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact) as T;

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = isSensitive(key) ? REDACTED_PLACEHOLDER : redact(val);
  }
  return result as T;
}
