import type { RequestHandler } from "express";
import { COOKIE_NAMES } from "@udp/config";
import { prisma } from "@udp/db";
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
  void (async () => {
    if (!req.user) {
      next(new UnauthenticatedError("Chưa đăng nhập"));
      return;
    }

    /**
     * Đọc vai trò từ DATABASE, không tin payload token.
     *
     * Access token sống 15 phút, nên tin payload nghĩa là một người vừa bị hạ
     * khỏi PLATFORM_ADMIN vẫn giữ toàn quyền suốt 15 phút — và không thao tác
     * nào trong hệ thống rút ngắn được khoảng đó. Với vai trò cao nhất, mười
     * lăm phút là quá dài; một truy vấn một cột cho mỗi request admin là cái
     * giá rẻ để đóng hẳn cửa sổ.
     *
     * Chỉ làm ở đây, KHÔNG làm ở `requireAuth`: route thường chạy với tần suất
     * cao hơn nhiều và hậu quả của một cửa sổ 15 phút ở đó nhỏ hơn hẳn.
     */
    const current = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { platformRole: true },
    });

    if (current?.platformRole !== "PLATFORM_ADMIN") {
      next(new ForbiddenError("Không đủ quyền truy cập"));
      return;
    }

    next();
  })().catch(next);
};
