import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { COOKIE_NAMES, CSRF_HEADER } from "@udp/config";
import { csrfTokenFor } from "../cookies.js";
import { verifyAccessToken, verifyRefreshToken } from "../../security/tokens.js";
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
/**
 * Lấy `fid` từ access token, hoặc từ refresh token nếu access đã hết hạn.
 *
 * PHẢI verify chữ ký, không được chỉ decode: nếu không, kẻ tấn công tự dựng một
 * token mang `fid` do mình chọn rồi tính CSRF khớp với nó.
 *
 * Nhánh refresh không phải phòng xa. Cookie access sống 15 phút còn phiên sống
 * 7 ngày, nên `/auth/refresh` — endpoint duy nhất cứu được phiên — thường được
 * gọi ĐÚNG LÚC access đã hết hạn. Chỉ đọc access token ở đây là khoá cứng người
 * dùng ra ngoài sau mười lăm phút.
 */
function familyIdOf(req: Request): string | undefined {
  const access: unknown = req.cookies?.[COOKIE_NAMES.accessToken];
  if (typeof access === "string") {
    try {
      return verifyAccessToken(access).fid;
    } catch {
      // hết hạn hoặc hỏng — thử refresh token bên dưới
    }
  }

  const refresh: unknown = req.cookies?.[COOKIE_NAMES.refreshToken];
  if (typeof refresh === "string") {
    try {
      return verifyRefreshToken(refresh).fid;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

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
    const familyId = familyIdOf(req);

    /**
     * BA điều kiện, không phải hai.
     *
     * Hai điều kiện đầu là double-submit cổ điển: cookie khớp header, chứng
     * minh client ĐỌC được cookie. Điều kiện thứ ba mới là thứ §1.2 yêu cầu —
     * token phải là HMAC của đúng phiên đang gửi kèm.
     *
     * Không có điều kiện thứ ba, cookie tossing đi qua trọn vẹn: kẻ tấn công từ
     * một subdomain ghi `udp_csrf=X` cho domain cha rồi gửi header `X`. Hai giá
     * trị khớp nhau hoàn hảo và middleware không có cách nào biết X không phải
     * do server cấp.
     */
    const isValid =
      typeof cookieToken === "string" &&
      typeof headerToken === "string" &&
      familyId !== undefined &&
      cookieToken.length > 0 &&
      safeEquals(cookieToken, headerToken) &&
      safeEquals(cookieToken, csrfTokenFor(familyId));

    if (!isValid) {
      next(new ForbiddenError("CSRF token không hợp lệ"));
      return;
    }

    next();
  };
}
