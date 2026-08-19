import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { COOKIE_NAMES, CSRF_HEADER } from "@udp/config";
import { ForbiddenError } from "../../errors.js";

/** GET/HEAD/OPTIONS không đổi trạng thái nên không cần bảo vệ CSRF */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * So sánh hằng thời gian.
 *
 * `a === b` thoát ra ngay tại ký tự đầu tiên khác nhau, nên thời gian so sánh
 * tiết lộ bao nhiêu ký tự đầu đã đúng — đủ để dò dần từng ký tự của token.
 */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  // timingSafeEqual ném lỗi khi độ dài khác nhau nên phải kiểm tra trước.
  // Độ dài không phải bí mật — token luôn cùng độ dài.
  if (bufferA.length !== bufferB.length) return false;

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Bảo vệ CSRF theo mẫu double-submit cookie.
 *
 * Vì access token nằm trong cookie, trình duyệt tự đính kèm nó vào MỌI request
 * tới domain này — kể cả request do một trang web khác kích hoạt. Middleware
 * này yêu cầu client chứng minh nó ĐỌC được cookie, việc mà trang web khác
 * không làm được do same-origin policy.
 *
 * @param exemptPaths Đường dẫn (tính từ chỗ middleware được mount) được miễn.
 *   Chỉ dành cho các endpoint khởi tạo phiên: lúc đó client CHƯA có CSRF cookie
 *   nên không thể gửi header khớp. Những endpoint này cũng chưa có phiên nào để
 *   lạm dụng, nên miễn trừ không tạo ra lỗ hổng.
 */
export function createCsrfProtection(
  exemptPaths: readonly string[] = [],
): RequestHandler {
  const exempt = new Set(exemptPaths);

  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || exempt.has(req.path)) {
      next();
      return;
    }

    const cookieToken: unknown = req.cookies?.[COOKIE_NAMES.csrfToken];
    const headerToken = req.get(CSRF_HEADER);

    const isValid =
      typeof cookieToken === "string" &&
      typeof headerToken === "string" &&
      cookieToken.length > 0 &&
      safeEquals(cookieToken, headerToken);

    if (!isValid) {
      next(new ForbiddenError("CSRF token không hợp lệ"));
      return;
    }

    next();
  };
}
