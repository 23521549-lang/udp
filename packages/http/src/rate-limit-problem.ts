import type { Request, Response } from "express";
import { buildProblem, sendProblem } from "./problem.js";

/**
 * Câu trả lời 429 dùng chung cho mọi rate limiter của mọi service.
 *
 * Ở đây chứ không ở một service, vì I36/I37 nói MỌI lỗi phải là
 * `application/problem+json` theo RFC 9457, và "mọi" gồm cả 429 do middleware
 * bên thứ ba phát ra. Hai service tự viết hai bản thì sớm muộn một bên quên
 * `traceId` hoặc đặt `type` khác — mà lỗi kiểu đó không làm test đỏ, nó chỉ làm
 * client phải xử lý hai hình dạng.
 *
 * Dùng `handler` chứ KHÔNG dùng tuỳ chọn `message` của `express-rate-limit`:
 * `message` là một object tĩnh, bị đóng băng lúc khởi tạo middleware — trước khi
 * có bất kỳ request nào. Nghĩa là nó không thể mang `instance` (URI của request)
 * hay `traceId`, hai trường mà RFC 9457 và §9 yêu cầu.
 *
 * Không import gì từ `express-rate-limit`: chữ ký `(req, res)` vừa đúng thứ thư
 * viện đó gọi, nên package này không phải nhận thêm một phụ thuộc chỉ để khai
 * một kiểu.
 */
export function rateLimitProblemHandler(req: Request, res: Response): void {
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
}
