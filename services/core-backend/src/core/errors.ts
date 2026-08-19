/**
 * Cây lỗi của ứng dụng.
 *
 * Vì sao không dùng `throw new Error("...")`:
 *  - Không biết lỗi này nên trả HTTP status nào
 *  - Không phân biệt được lỗi do người dùng (4xx) với lỗi hệ thống (5xx),
 *    nên hoặc là log rác, hoặc là bỏ sót lỗi thật
 *  - Thông báo lỗi gốc thường lộ chi tiết nội bộ ra ngoài
 *
 * `code` là mã ổn định để frontend xử lý (hiện thông báo, điều hướng),
 * KHÔNG phải chuỗi tiếng Việt — chuỗi hiển thị thuộc về frontend.
 */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: ErrorCode;

  /** true = lỗi dự kiến (người dùng gây ra). false = bug, cần cảnh báo. */
  readonly isOperational = true;

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_FAILED" as const;
}

export class UnauthenticatedError extends AppError {
  readonly statusCode = 401;
  readonly code = "UNAUTHENTICATED" as const;
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN" as const;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND" as const;
}

/** Dùng cho optimistic lock — xem §8.4, khi hai người cùng sửa một flag */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "CONFLICT" as const;
}
