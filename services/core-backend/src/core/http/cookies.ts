import { createHmac } from "node:crypto";
import type { CookieOptions, Response } from "express";
import { COOKIE_NAMES, env } from "@udp/config";

/**
 * Đường dẫn hẹp cho refresh cookie: trình duyệt chỉ gửi nó tới đúng endpoint
 * refresh, không kèm theo trong mọi request khác. Giảm bề mặt phơi nhiễm của
 * token có thời hạn dài nhất trong hệ thống.
 */
export const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

const MS_PER_SECOND = 1_000;

/**
 * Khoá riêng cho CSRF, dẫn xuất từ khoá ký access token.
 *
 * Dẫn xuất thay vì dùng thẳng: một khoá nên phục vụ đúng một mục đích, và nhãn
 * cố định ở đây bảo đảm giá trị HMAC của CSRF không bao giờ trùng với bất cứ
 * thứ gì được ký bằng cùng khoá gốc. Rẻ hơn một biến môi trường thứ hai mà
 * người vận hành phải nhớ xoay.
 */
const CSRF_KEY = createHmac("sha256", env.JWT_ACCESS_SECRET)
  .update("udp-csrf-v1")
  .digest();

/**
 * Token CSRF của một PHIÊN — tính lại được, nên không cần lưu ở đâu.
 *
 * Khoá là `family_id` chứ không phải access token: family không đổi qua các lần
 * xoay vòng và sống đúng bằng vòng đời phiên, nên một giá trị CSRF dùng được ở
 * mọi route trong suốt 7 ngày.
 */
export const csrfTokenFor = (familyId: string): string =>
  createHmac("sha256", CSRF_KEY).update(familyId).digest("base64url");

/**
 * Thời hạn cookie lấy từ CHÍNH thời hạn của token, không khai báo riêng.
 * Nếu tách làm hai nguồn, sớm muộn sẽ có lúc token còn hạn mà cookie đã bị xoá
 * — hoặc ngược lại, cookie còn nhưng token bên trong đã chết.
 */
const accessMaxAgeMs = env.JWT_ACCESS_TTL * MS_PER_SECOND;
const refreshMaxAgeMs = env.JWT_REFRESH_TTL * MS_PER_SECOND;

/**
 * KHÔNG khai `domain` — cookie ở chế độ host-only.
 *
 * Khai `domain` tường minh biến cookie từ host-only thành domain-scoped: MỌI
 * subdomain đọc và gửi được nó. Vì `udp_csrf` cố ý không httpOnly, một trang
 * chạy trên bất kỳ subdomain nào — môi trường preview, trang marketing, hay một
 * subdomain bị chiếm — chỉ cần `document.cookie` là có token, rồi gửi request
 * kèm header khớp trong khi trình duyệt tự đính `udp_access` vào. `SameSite=Lax`
 * không chặn được vì đó vẫn là same-site.
 *
 * Nếu sau này Portal thật sự phải nằm ở subdomain khác API, cách đúng là CORS
 * kèm `credentials`, không phải nới phạm vi cookie.
 */
const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: "lax",
});

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Đặt ba cookie và trả về CSRF token để controller gửi kèm trong body —
 * Portal cần giá trị này ngay lần đầu, trước khi kịp đọc cookie.
 */
export function setAuthCookies(
  res: Response,
  tokens: AuthTokens,
  familyId: string,
): string {
  res.cookie(COOKIE_NAMES.accessToken, tokens.accessToken, {
    ...baseOptions(),
    maxAge: accessMaxAgeMs,
  });

  res.cookie(COOKIE_NAMES.refreshToken, tokens.refreshToken, {
    ...baseOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshMaxAgeMs,
  });

  /**
   * CSRF token = HMAC CỦA PHIÊN, đúng như §1.2 yêu cầu — không phải chuỗi ngẫu
   * nhiên trần.
   *
   * Double-submit với token ngẫu nhiên chỉ kiểm "cookie khớp header", mà không
   * kiểm token đó THUỘC VỀ AI. Hệ quả là cookie tossing: kẻ tấn công từ một
   * subdomain ghi `udp_csrf=X` cho domain cha rồi gửi header `X-CSRF-Token: X`
   * — hai giá trị khớp nhau hoàn hảo, và middleware không có cách nào biết X
   * không phải do server cấp.
   *
   * Buộc token vào access token thì X phải là HMAC của đúng phiên đang gửi kèm,
   * và kẻ tấn công không có khoá để dựng ra nó.
   */
  const csrfToken = csrfTokenFor(familyId);
  res.cookie(COOKIE_NAMES.csrfToken, csrfToken, {
    ...baseOptions(),
    httpOnly: false,
    maxAge: refreshMaxAgeMs,
  });

  return csrfToken;
}

/**
 * Xoá cookie phải khớp CHÍNH XÁC `domain` và `path` lúc đặt, nếu không trình
 * duyệt giữ lại cookie cũ — người dùng bấm đăng xuất mà phiên vẫn còn.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(COOKIE_NAMES.accessToken, baseOptions());
  res.clearCookie(COOKIE_NAMES.refreshToken, {
    ...baseOptions(),
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(COOKIE_NAMES.csrfToken, {
    ...baseOptions(),
    httpOnly: false,
  });
}
