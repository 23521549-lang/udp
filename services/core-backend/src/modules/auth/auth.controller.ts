import { Router } from "express";
import { COOKIE_NAMES } from "@udp/config";
import { UnauthenticatedError } from "../../core/errors.js";
import { clearAuthCookies, setAuthCookies } from "../../core/http/cookies.js";
import { asyncHandler } from "../../core/http/error-handler.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
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

authRouter.post(
  "/register",
  authRateLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { user, tokens } = await authService.register(req.body);
    const csrfToken = setAuthCookies(res, tokens);
    res.status(201).json({ user, csrfToken });
  }),
);

authRouter.post(
  "/login",
  authRateLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { user, tokens } = await authService.login(req.body);
    const csrfToken = setAuthCookies(res, tokens);
    res.json({ user, csrfToken });
  }),
);

/**
 * Đăng xuất chỉ xoá cookie phía trình duyệt.
 *
 * Giới hạn đã biết: access token vẫn hợp lệ tới khi hết hạn (tối đa 15 phút)
 * nếu ai đó đã sao chép được nó. Vô hiệu hoá ngay lập tức đòi hỏi danh sách đen
 * hoặc cột phiên bản token — chưa cần ở phạm vi hiện tại, nhưng phải nói rõ
 * thay vì để người đọc tưởng token bị thu hồi tức thì.
 */
authRouter.post("/logout", (_req, res) => {
  // CSRF đã được kiểm ở tầng app cho mọi route không nằm trong danh sách miễn
  // trừ — /logout cố ý KHÔNG được miễn.
  clearAuthCookies(res);
  res.status(204).end();
});

authRouter.post(
  "/refresh",
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const token: unknown = req.cookies?.[COOKIE_NAMES.refreshToken];
    if (typeof token !== "string" || token.length === 0) {
      throw new UnauthenticatedError("Không có refresh token");
    }

    const { user, tokens } = await authService.refresh(token);
    const csrfToken = setAuthCookies(res, tokens);
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
    const user = await authService.getCurrentUser(req.user!.sub);
    res.json({ user });
  }),
);
