import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { CSRF_HEADER, env } from "@udp/config";
import { errorHandler, notFoundHandler } from "./core/http/error-handler.js";
import { requestLogger } from "./core/http/request-logger.js";
import { createCsrfProtection } from "./core/http/middlewares/csrf.middleware.js";
import { generalRateLimiter } from "./core/http/middlewares/rate-limit.middleware.js";
import { healthRouter } from "./modules/health/health.controller.js";
import { metricsRouter } from "./modules/health/metrics.controller.js";
import { authRouter } from "./modules/auth/auth.controller.js";

const API_PREFIX = "/api/v1";

/**
 * Endpoint khởi tạo phiên — miễn kiểm tra CSRF.
 *
 * Lúc gọi hai endpoint này, client CHƯA có CSRF cookie nên không thể gửi header
 * khớp, và cũng chưa có phiên nào để lạm dụng. Mọi endpoint khác được bảo vệ
 * mặc định.
 *
 * `/auth/refresh` ĐÃ BỊ GỠ khỏi danh sách. Lập luận cũ ("chưa có phiên để lạm
 * dụng") sai với chính nó: refresh chạy được LÀ NHỜ cookie phiên `udp_refresh`
 * đã tồn tại, và client đã có `udp_csrf` từ lần đăng nhập trước nên hoàn toàn
 * gửi được header. Trước khi gỡ, thứ duy nhất bảo vệ nó là `SameSite=Lax` —
 * tức là dựa vào một lớp khác chứ không phải lớp được thiết kế cho việc đó.
 *
 * `/logout` cũng không nằm trong danh sách: phiên đã tồn tại và một trang web
 * khác có thể ép người dùng đăng xuất nếu không kiểm tra.
 */
const CSRF_EXEMPT_PATHS = ["/auth/register", "/auth/login"] as const;

/**
 * Tạo Express app.
 *
 * Tách khỏi `listen()` để test tích hợp dựng được app trong bộ nhớ mà không
 * chiếm cổng — thiếu điều này thì các test chạy song song sẽ tranh cổng nhau.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  /**
   * Số hop lấy từ cấu hình, KHÔNG ghim cứng 1 và không suy từ NODE_ENV.
   *
   * `req.ip` là khoá của rate limiter, và Express suy nó từ `X-Forwarded-For`
   * theo đúng con số này. Đặt cao hơn thực tế nghĩa là tin một entry do CLIENT
   * ghi — kẻ tấn công tự chọn IP cho mỗi request và rate limit thành trang trí.
   * Bản trước ghim `1`, đúng khi có duy nhất một proxy; với CDN + ingress (hai
   * hop) hoặc pod tiếp cận được trực tiếp trong cluster thì nó sai.
   */
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true, // bắt buộc: auth dùng httpOnly cookie
      allowedHeaders: ["Content-Type", CSRF_HEADER],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(requestLogger);

  // Endpoint vận hành — không có tiền tố /api/v1 để hạ tầng gọi trực tiếp.
  // Đặt TRƯỚC rate limiter: Prometheus scrape đều đặn và không được bị chặn.
  app.use(healthRouter);
  app.use(metricsRouter);

  /**
   * Hai lớp bảo vệ áp cho TOÀN BỘ API thay vì rải trong từng controller.
   *
   * Đặt ở đây là có chủ đích: mọi endpoint thêm sau này được bảo vệ mặc định.
   * Nếu để mỗi controller tự nhớ, sớm muộn sẽ có một endpoint bị quên — và
   * theo kinh nghiệm thì đó thường là endpoint nguy hiểm nhất.
   */
  app.use(API_PREFIX, generalRateLimiter);
  app.use(API_PREFIX, createCsrfProtection(CSRF_EXEMPT_PATHS));

  app.use(`${API_PREFIX}/auth`, authRouter);

  app.use(notFoundHandler);
  app.use(errorHandler); // PHẢI đăng ký cuối cùng

  return app;
}
