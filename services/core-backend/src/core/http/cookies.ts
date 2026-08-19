import { randomBytes } from "node:crypto";
import type { CookieOptions, Response } from "express";
import { AUTH, COOKIE_NAMES, env } from "@udp/config";

/**
 * Đường dẫn hẹp cho refresh cookie: trình duyệt chỉ gửi nó tới đúng endpoint
 * refresh, không kèm theo trong mọi request khác. Giảm bề mặt phơi nhiễm của
 * token có thời hạn dài nhất trong hệ thống.
 */
export const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

const MS_PER_SECOND = 1_000;

/**
 * Thời hạn cookie lấy từ CHÍNH thời hạn của token, không khai báo riêng.
 * Nếu tách làm hai nguồn, sớm muộn sẽ có lúc token còn hạn mà cookie đã bị xoá
 * — hoặc ngược lại, cookie còn nhưng token bên trong đã chết.
 */
const accessMaxAgeMs = env.JWT_ACCESS_TTL * MS_PER_SECOND;
const refreshMaxAgeMs = env.JWT_REFRESH_TTL * MS_PER_SECOND;

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: "lax",
  domain: env.COOKIE_DOMAIN,
});

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Đặt ba cookie và trả về CSRF token để controller gửi kèm trong body —
 * Portal cần giá trị này ngay lần đầu, trước khi kịp đọc cookie.
 */
export function setAuthCookies(res: Response, tokens: AuthTokens): string {
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
   * CSRF theo mẫu double-submit. Cookie này CỐ Ý không httpOnly để JavaScript
   * của Portal đọc được và gắn vào header X-CSRF-Token.
   *
   * Vì sao vẫn an toàn: trang web độc hại có thể khiến trình duyệt GỬI cookie
   * của ta đi kèm request, nhưng không ĐỌC được nó (same-origin policy), nên
   * không dựng được header khớp.
   */
  const csrfToken = randomBytes(AUTH.csrfTokenBytes).toString("base64url");
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
