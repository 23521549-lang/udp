import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { isProduction } from "@udp/config";
import { dbConstraintError, httpStatusOf } from "@udp/db";
import { AppError } from "../errors.js";
import { logger, redact } from "../logger.js";
import { buildProblem, sendProblem } from "./problem.js";

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
  sendProblem(
    res,
    buildProblem({
      req,
      status: 404,
      title: "Route not found",
      detail: `Không có route ${req.method} ${req.path}`,
      typeSlug: "not-found",
    }),
  );
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
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isMalformedJson(err)) {
    sendProblem(
      res,
      buildProblem({
        req,
        status: 400,
        title: "Malformed JSON body",
        detail: "Body không phải JSON hợp lệ",
        typeSlug: "malformed-json",
      }),
    );
    return;
  }

  // Lỗi validate từ Zod → 400 kèm chi tiết từng trường, để form phía client
  // hiển thị được lỗi ngay dưới ô nhập tương ứng.
  if (err instanceof ZodError) {
    sendProblem(
      res,
      buildProblem({
        req,
        status: 400,
        title: "Request validation failed",
        detail: "Dữ liệu gửi lên không hợp lệ",
        typeSlug: "validation-failed",
        errors: err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      }),
    );
    return;
  }

  /**
   * Lỗi nghiệp vụ — dự kiến, do người dùng gây ra. Log mức `warn`.
   * Không phân tầng thì log đầy 401 do gõ nhầm mật khẩu và bug thật lẫn vào giữa.
   */
  if (err instanceof AppError) {
    // `details` đi qua redact() ở ĐÂY, không trông vào lời hứa của người ném.
    //
    // Ba chỗ trong codebase từng ghi "PHẢI đã qua redact()" — và `redact()` có
    // ĐÚNG 0 người gọi. Một quy ước không ai cưỡng chế thì chỉ là chú thích.
    // Chạy nó ở điểm hội tụ: mọi AppError đều qua đây, nên không lối nào lách.
    // pino `redact.paths` KHÔNG thay được: nó là wildcard một cấp, còn
    // `details` lồng sâu tuỳ ý.
    logger.warn(
      { err, kind: err.kind, code: err.problemCode, details: redact(err.details) },
      "Business error",
    );
    sendProblem(
      res,
      buildProblem({
        req,
        status: err.statusCode,
        // Có mã nghiệp vụ thì `title` lấy từ catalog; không thì dùng kind làm nhãn
        ...(err.problemCode === undefined
          ? { title: err.kind, typeSlug: err.kind.toLowerCase().replaceAll("_", "-") }
          : { code: err.problemCode }),
        detail: err.message,
      }),
    );
    return;
  }

  /**
   * Ràng buộc do database cưỡng chế (trigger, constraint tự định nghĩa).
   *
   * PHẢI đứng trước nhánh 500 bên dưới. Không có nhánh này, một rule trỏ variant
   * lạ sẽ trả "Lỗi hệ thống" — sai cả status lẫn ý nghĩa, vì đó là lỗi người
   * dùng sửa được, và 500 còn bảo client cứ retry một request không bao giờ đúng.
   */
  const dbError = dbConstraintError(err);
  if (dbError !== undefined) {
    logger.warn({ err, code: dbError.code }, "Database constraint violation");
    sendProblem(
      res,
      buildProblem({
        req,
        status: httpStatusOf(dbError.code),
        code: dbError.code,
        // `detail` giữ NGUYÊN ở production, khác với nhánh 500 bên dưới. Không
        // mâu thuẫn: chuỗi này là câu RAISE do chính ta viết trong migration,
        // không phải message của Prisma — nó không mang đường dẫn file hay tên
        // bảng nội bộ. Và mã này khai `fixableBy: "user"`, nên nói "rule trỏ
        // variant không tồn tại" mà không nói variant NÀO là bỏ người dùng bế tắc.
        detail: dbError.detail,
      }),
    );
    return;
  }

  /**
   * Tới đây là bug chưa lường trước. Log đầy đủ kèm stack để debug, nhưng
   * KHÔNG trả thông báo gốc ra ngoài ở production — thông báo lỗi thường lộ
   * đường dẫn file, tên bảng, thậm chí chuỗi kết nối database.
   */
  logger.error({ err }, "Unexpected error");
  sendProblem(
    res,
    buildProblem({
      req,
      status: 500,
      title: "Internal server error",
      detail: isProduction ? "Lỗi hệ thống" : (err as Error).message,
      typeSlug: "internal",
    }),
  );
};
