import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { isProduction } from "@udp/config";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";

/**
 * Bọc handler async để lỗi được chuyển tới errorHandler.
 *
 * Express 4 KHÔNG tự bắt promise rejection. Thiếu lớp bọc này, một `await` ném
 * lỗi sẽ treo request cho tới khi client timeout, và không có dòng log nào —
 * loại lỗi tốn nhiều giờ để tìm ra.
 */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Không có route ${req.method} ${req.path}`,
    },
  });
};

/**
 * Nhận diện lỗi JSON hỏng do `express.json()` ném ra.
 *
 * Nếu không xử lý riêng, client gửi JSON sai cú pháp sẽ nhận 500 — nói rằng
 * lỗi thuộc về máy chủ, trong khi thực tế lỗi nằm ở request. Sai mã trạng thái
 * khiến client retry vô ích và làm nhiễu cảnh báo về lỗi hệ thống thật.
 */
function isMalformedJson(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: number }).status === 400 &&
    "body" in err
  );
}

/** Middleware xử lý lỗi — phải đăng ký CUỐI CÙNG, sau mọi route */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (isMalformedJson(err)) {
    res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Body không phải JSON hợp lệ",
      },
    });
    return;
  }

  // Lỗi validate từ Zod → 400 kèm chi tiết từng trường, để form phía client
  // hiển thị được lỗi ngay dưới ô nhập tương ứng.
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Dữ liệu gửi lên không hợp lệ",
        details: err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  /**
   * Lỗi nghiệp vụ — dự kiến, do người dùng gây ra. Log mức `warn`.
   * Không phân tầng thì log đầy 401 do gõ nhầm mật khẩu và bug thật lẫn vào giữa.
   */
  if (err instanceof AppError) {
    logger.warn({ err, code: err.code }, "Business error");
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  /**
   * Tới đây là bug chưa lường trước. Log đầy đủ kèm stack để debug, nhưng
   * KHÔNG trả thông báo gốc ra ngoài ở production — thông báo lỗi thường lộ
   * đường dẫn file, tên bảng, thậm chí chuỗi kết nối database.
   */
  logger.error({ err }, "Unexpected error");
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: isProduction ? "Lỗi hệ thống" : (err as Error).message,
    },
  });
};
