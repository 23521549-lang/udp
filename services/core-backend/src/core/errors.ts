import type { ErrorCode } from "@udp/shared-types/problem";

/**
 * Cây lỗi của ứng dụng.
 *
 * Vì sao không dùng `throw new Error("...")`:
 *  - Không biết lỗi này nên trả HTTP status nào
 *  - Không phân biệt được lỗi do người dùng (4xx) với lỗi hệ thống (5xx),
 *    nên hoặc là log rác, hoặc là bỏ sót lỗi thật
 *  - Thông báo lỗi gốc thường lộ chi tiết nội bộ ra ngoài
 *
 * ---
 *
 * HAI TẦNG MÃ, đừng nhầm lẫn:
 *
 *   `AppErrorKind`  — phân loại ở tầng GIAO THỨC: request sai, chưa đăng nhập,
 *                     không đủ quyền, không tìm thấy... Mỗi loại một status.
 *                     Định nghĩa ngay dưới đây vì nó là chuyện riêng của HTTP.
 *
 *   `ErrorCode`     — mã NGHIỆP VỤ trong `ERROR_CATALOG` của `@udp/shared-types`
 *                     (§9): thiếu capability, vượt quota, không tra được metrics...
 *                     Mã này đi kèm `fixableBy` để Portal biết nên hiện nút hành
 *                     động hay hiện traceId.
 *
 * Hai tầng bổ sung cho nhau chứ không cạnh tranh. Một lỗi 401 KHÔNG có mã nghiệp
 * vụ nào phủ được, và đó chính là lý do `ProblemDetails.code` là optional. Ngược
 * lại, `QUOTA_EXCEEDED` cần cả status 422 lẫn mã nghiệp vụ để Portal xử lý đúng.
 *
 * `AppErrorKind` là mã ổn định cho frontend xử lý, KHÔNG phải chuỗi tiếng Việt —
 * chuỗi hiển thị thuộc về frontend.
 */
export type AppErrorKind =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly kind: AppErrorKind;

  /** true = lỗi dự kiến (người dùng gây ra). false = bug, cần cảnh báo. */
  readonly isOperational = true;

  /**
   * Chữ ký giữ nguyên hai tham số đầu để mọi lời gọi `new XError("...")` sẵn có
   * không phải sửa. Tham số thứ ba là tuỳ chọn, dùng khi lỗi có mã nghiệp vụ.
   *
   * @param details      Dữ liệu phụ. PHẢI đã qua redact() nếu có thể chứa secret.
   * @param problemCode  Mã trong ERROR_CATALOG, nếu lỗi này ứng với một mã nghiệp vụ.
   */
  constructor(
    message: string,
    readonly details?: unknown,
    readonly problemCode?: ErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly kind = "VALIDATION_FAILED" as const;
}

export class UnauthenticatedError extends AppError {
  readonly statusCode = 401;
  readonly kind = "UNAUTHENTICATED" as const;
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly kind = "FORBIDDEN" as const;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly kind = "NOT_FOUND" as const;
}

/** Dùng cho optimistic lock — xem §8.4, khi hai người cùng sửa một flag */
/**
 * 422 — request đọc hiểu được nhưng sai về mặt ngữ nghĩa.
 *
 * Tách khỏi `ValidationError` (400) vì `ERROR_CATALOG` đặt nhiều mã ở đúng 422:
 * `IDEMPOTENCY_KEY_REUSED`, `QUOTA_EXCEEDED`, `INSUFFICIENT_PERMISSIONS`. Không
 * có lớp này thì mã trong catalog nói 422 còn HTTP thật trả 400, và client tra
 * catalog theo `code` sẽ thấy hai con số khác nhau cho cùng một lỗi.
 */
export class UnprocessableError extends AppError {
  readonly statusCode = 422;
  readonly kind = "VALIDATION_FAILED" as const;
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly kind = "CONFLICT" as const;
}
