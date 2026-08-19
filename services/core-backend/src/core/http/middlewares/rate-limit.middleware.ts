import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";

const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Quá nhiều yêu cầu, vui lòng thử lại sau",
    },
  },
} as const;

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
});

export const generalRateLimiter = rateLimit({
  ...shared,
  windowMs: RATE_LIMIT.general.windowMs,
  limit: RATE_LIMIT.general.max,
});
