import { pinoHttp } from "pino-http";
import type { RequestHandler } from "express";
import { logger } from "../logger.js";

/**
 * Endpoint hạ tầng — bị hạ tầng gọi liên tục và không mang thông tin nghiệp vụ.
 * Prometheus scrape /metrics mỗi 15 giây; Kubernetes gọi /healthz và /readyz
 * còn dày hơn. Log chúng sẽ nhấn chìm những dòng log thật sự cần đọc.
 */
const SILENT_PATHS = new Set(["/metrics", "/healthz", "/readyz"]);

export const requestLogger: RequestHandler = pinoHttp({
  logger,

  autoLogging: {
    ignore: (req) => {
      const path = req.url.split("?")[0] ?? "";
      return SILENT_PATHS.has(path);
    },
  },

  /**
   * Mức log theo kết quả, không phải theo việc "có request".
   * 5xx là bug cần cảnh báo; 4xx là người dùng gửi sai, chỉ cần warn.
   * Không phân tầng thì log đầy 401 do gõ nhầm mật khẩu, và bug thật lẫn vào giữa.
   */
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },

  customSuccessMessage: (req, res) =>
    `${req.method} ${req.url} → ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} → ${res.statusCode} (${err.message})`,

  /**
   * Chỉ giữ trường thật sự cần khi đọc log.
   * Mặc định pino-http in TOÀN BỘ header của cả request lẫn response — vừa
   * không đọc nổi, vừa là rủi ro: Authorization và Cookie nằm trong đó.
   * Lớp redact ở logger.ts đã che, nhưng cách an toàn hơn là không log.
   */
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
