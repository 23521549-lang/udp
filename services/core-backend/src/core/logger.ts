import pino from "pino";
import { env, isDevelopment, REDACTED_KEY_PATTERNS } from "@udp/config";

/**
 * Logger dùng chung.
 *
 * Điểm quan trọng nhất ở đây là REDACT. Dự án giữ credential cloud của người
 * khác; một dòng `logger.info({ credential })` vô ý là rò rỉ thật. Danh sách
 * khóa nhạy cảm dùng CHUNG với AuditLog và ProvisioningJob.lastError, khai báo
 * một chỗ ở @udp/config để không có nơi nào quên.
 */

/** pino cần đường dẫn cụ thể; sinh từ pattern để giữ một nguồn khai báo */
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.secret",
  "*.credential",
  "*.encryptedPayload",
  "*.serviceAccountJson",
  "*.accessKeyId",
  "*.secretAccessKey",
  "*.clientSecret",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[REDACTED]" },
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
 * Che giá trị nhạy cảm trong object bất kỳ trước khi ghi AuditLog hay lưu
 * lastError. Đệ quy, giữ nguyên cấu trúc để diff before/after vẫn đọc được.
 */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact) as T;

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    const isSensitive = REDACTED_KEY_PATTERNS.some((p) => p.test(key));
    result[key] = isSensitive ? "[REDACTED]" : redact(val);
  }
  return result as T;
}
