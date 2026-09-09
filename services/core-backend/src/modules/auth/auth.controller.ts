import { Router, type Request } from "express";
import { COOKIE_NAMES } from "@udp/config";
import { UnauthenticatedError } from "../../core/errors.js";
import { clearAuthCookies, setAuthCookies } from "../../core/http/cookies.js";
import { asyncHandler } from "../../core/http/error-handler.js";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import { authRateLimiter } from "../../core/http/middlewares/rate-limit.middleware.js";
import { validateBody } from "../../core/http/validate.js";
import * as authService from "./auth.service.js";
import { loginSchema, registerSchema } from "./auth.types.js";

export const authRouter: Router = Router();

/**
 * Controller chỉ làm ba việc: đọc request, gọi service, ghi response.
 * Mọi quyết định nghiệp vụ nằm ở service; mọi kiểm tra dữ liệu nằm ở schema.
 * Nhờ ranh giới này, service test được mà không cần dựng Express.
 */

/**
 * Ngữ cảnh thiết bị, CHỈ để hiển thị danh sách phiên trên Portal.
 *
 * Không dùng để xác thực: cả hai đều do client khai và giả mạo được. Ghi lại vì
 * khi người dùng nghi tài khoản bị chiếm, danh sách "thiết bị nào đang đăng
 * nhập" là thứ đầu tiên họ cần nhìn.
 */
function sessionContext(req: Request): {
  userAgent?: string;
  ipAddress?: string;
} {
  const ua = req.get("user-agent");
  return {
    ...(ua === undefined ? {} : { userAgent: ua.slice(0, 255) }),
    ...(req.ip === undefined ? {} : { ipAddress: req.ip }),
  };
}

authRouter.post(
  "/register",
  authRateLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { user, tokens, familyId } = await authService.register(
      req.body,
      sessionContext(req),
    );
    const csrfToken = setAuthCookies(res, tokens, familyId);
    res.status(201).json({ user, csrfToken });
  }),
);

authRouter.post(
  "/login",
  authRateLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { user, tokens, familyId } = await authService.login(
      req.body,
      sessionContext(req),
    );
    const csrfToken = setAuthCookies(res, tokens, familyId);
    res.json({ user, csrfToken });
  }),
);

/**
 * Đăng xuất: thu hồi phiên ở SERVER rồi mới xoá cookie.
 *
 * Xoá cookie thôi là không đủ — ai đã sao chép được refresh token vẫn dùng nó
 * cấp access token mới suốt 7 ngày. Thu hồi hàng `RefreshSession` mới thật sự
 * kết thúc phiên.
 *
 * Giới hạn còn lại, nói rõ để không ai tưởng đã đóng hẳn: access token đã cấp
 * vẫn hợp lệ tới khi hết hạn (tối đa 15 phút). Kiểm từng request với database
 * sẽ xoá nốt cửa sổ đó nhưng đánh đổi bằng một truy vấn mỗi request — hiện chỉ
 * làm cho route PLATFORM_ADMIN, nơi cái giá đó đáng.
 */
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    // CSRF đã được kiểm ở tầng app cho mọi route không nằm trong danh sách miễn
    // trừ — /logout cố ý KHÔNG được miễn.
    const token: unknown = req.cookies[COOKIE_NAMES.refreshToken];
    await authService.logout(typeof token === "string" ? token : undefined);
    clearAuthCookies(res);
    res.status(204).end();
  }),
);

authRouter.post(
  "/refresh",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const token: unknown = req.cookies[COOKIE_NAMES.refreshToken];
    if (typeof token !== "string" || token.length === 0) {
      throw new UnauthenticatedError("Không có refresh token");
    }

    const { user, tokens, familyId } = await authService.refresh(
      token,
      sessionContext(req),
    );
    const csrfToken = setAuthCookies(res, tokens, familyId);
    res.json({ user, csrfToken });
  }),
);

/** Portal gọi khi tải lại trang để khôi phục trạng thái đăng nhập */
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // requireAuth đã bảo đảm req.user tồn tại; dấu ! ở đây là an toàn và
    // được giới hạn trong đúng một dòng.
    const user = await authService.getCurrentUser(requireUser(req).sub);
    res.json({ user });
  }),
);
