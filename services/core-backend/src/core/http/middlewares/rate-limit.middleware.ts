import { createHash } from "node:crypto";
import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";
import { ipKey, rateLimitProblemHandler } from "@udp/http";

const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  /** 429 cũng phải là problem+json (I36/I37) — khuôn chung ở `@udp/http` */
  handler: rateLimitProblemHandler,
} as const;

/**
 * Khoá đếm cho endpoint xác thực: IP **và** danh tính được nhắm tới.
 *
 * Chỉ đếm theo IP là chưa đủ ở cả hai chiều:
 *
 *  - IPv6 cấp cho một người dùng cả một dải /64, nên "mỗi địa chỉ một bucket"
 *    nghĩa là hàng tỷ bucket miễn phí, không cần giả mạo header nào. Việc gộp
 *    dải nằm ở `ipKey` của `@udp/http`.
 *  - Credential stuffing PHÂN TÁN nhắm vào MỘT tài khoản đi qua hàng nghìn IP
 *    khác nhau, nên không ngưỡng theo IP nào chặn được. Thêm email vào khoá làm
 *    số lần thử trên một tài khoản bị đếm bất kể đến từ đâu.
 *
 * Email băm chứ không để nguyên: khoá của rate limiter nằm trong bộ nhớ và có
 * thể lộ ra qua log hay công cụ chẩn đoán, mà email là dữ liệu cá nhân.
 */
function authRateKey(req: Request): string {
  const ip = ipKey(req.ip ?? "");
  const body: unknown = req.body;
  const email =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { email?: unknown }).email === "string"
      ? (body as { email: string }).email.trim().toLowerCase()
      : "";
  if (email === "") return ip;
  return `${ip}|${createHash("sha256").update(email).digest("base64url").slice(0, 16)}`;
}

/**
 * Giới hạn chặt cho endpoint xác thực.
 *
 * Không có nó, `POST /auth/login` là công cụ dò mật khẩu miễn phí: bcrypt tuy
 * chậm nhưng kẻ tấn công có thể chạy song song hàng nghìn kết nối. Đây cũng là
 * lớp phòng vệ trước việc dò xem email nào đã đăng ký.
 */
export const authRateLimiter = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.auth.windowMs,
  limit: RATE_LIMIT.auth.max,
  keyGenerator: authRateKey,
});

export const generalRateLimiter = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.general.windowMs,
  limit: RATE_LIMIT.general.max,
});
