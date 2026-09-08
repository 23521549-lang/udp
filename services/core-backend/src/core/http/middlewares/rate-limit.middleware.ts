import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { RATE_LIMIT } from "@udp/config";
import { buildProblem, sendProblem } from "../problem.js";

/**
 * Dùng `handler` chứ KHÔNG dùng `message`.
 *
 * `message` là một object tĩnh, được đóng băng lúc khởi tạo middleware — trước
 * khi có bất kỳ request nào. Nghĩa là nó không thể mang `instance` (URI của
 * request) hay `traceId`, hai trường mà RFC 9457 và §9 yêu cầu. `handler` nhận
 * được `req` nên dựng được `ProblemDetails` đầy đủ, giống hệt năm chỗ phát sinh
 * lỗi còn lại.
 */
const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response): void => {
    sendProblem(
      res,
      buildProblem({
        req,
        status: 429,
        title: "Too many requests",
        detail: "Quá nhiều yêu cầu, vui lòng thử lại sau",
        typeSlug: "rate-limited",
      }),
    );
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
