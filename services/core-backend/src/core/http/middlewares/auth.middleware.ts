import type { RequestHandler } from "express";
import { COOKIE_NAMES } from "@udp/config";
import { ForbiddenError, UnauthenticatedError } from "../../errors.js";
import { verifyAccessToken } from "../../security/tokens.js";

/**
 * Bắt buộc đăng nhập.
 *
 * Token đọc từ httpOnly cookie chứ không phải header Authorization: JavaScript
 * trên trang không chạm được vào cookie đó, nên một lỗ hổng XSS không lấy được
 * token mang đi nơi khác. Cái giá phải trả là phải chống CSRF — xem
 * csrf.middleware.ts.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token: unknown = req.cookies?.[COOKIE_NAMES.accessToken];

  if (typeof token !== "string" || token.length === 0) {
    next(new UnauthenticatedError("Chưa đăng nhập"));
    return;
  }

  req.user = verifyAccessToken(token);
  next();
};

/**
 * Quyền quản trị TOÀN HỆ THỐNG.
 *
 * KHÔNG dùng cho quyền trong project — cái đó thuộc về `ProjectMember` và sẽ
 * có middleware riêng (`requireProjectRole`). Việc tách hai loại quyền là lý do
 * `User.role` được đổi thành `User.platformRole` ở thiết kế v3.
 */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new UnauthenticatedError("Chưa đăng nhập"));
    return;
  }

  if (req.user.platformRole !== "PLATFORM_ADMIN") {
    next(new ForbiddenError("Không đủ quyền truy cập"));
    return;
  }

  next();
};
