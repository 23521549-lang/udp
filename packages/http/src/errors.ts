import {
  ERROR_CATALOG,
  type ErrorCode,
  type FieldError,
  type SuggestedAction,
} from "@udp/shared-types/problem";

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
  | "PRECONDITION_FAILED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "RELAYED"
  | "CONFIRMATION_REQUIRED"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly kind: AppErrorKind;

  /** true = lỗi dự kiến (người dùng gây ra). false = bug, cần cảnh báo. */
  readonly isOperational = true;

  /**
   * [v4.4] Id của tài nguyên liên quan tới lỗi mà Portal cần dẫn tới — rollout
   * đang giữ chỗ (`ROLLOUT_IN_PROGRESS`), rollout vừa được yêu cầu huỷ khi bù trừ
   * thất bại. Đi ra trường `resourceId` của Problem Details; `details` thì KHÔNG
   * (nó chỉ vào log, qua `redact()`). Chỉ là id, không mang nội dung.
   */
  resourceId: string | undefined;

  /** [v4.11] Slug `type` đặt tường minh — xem `withTypeSlug` */
  typeSlug: string | undefined;

  /**
   * [v4.11] Việc người dùng làm được để hết lỗi (§5.3: "Bật Prometheus") — đi ra trường
   * `suggestedAction` của Problem Details để Portal vẽ thành nút, không phải một câu chữ.
   */
  suggestedAction: SuggestedAction | undefined;

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
    this.resourceId = undefined;
    this.typeSlug = undefined;
    this.suggestedAction = undefined;
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }

  /** Gắn hành động gợi ý — xem `suggestedAction` */
  withSuggestedAction(action: SuggestedAction): this {
    this.suggestedAction = action;
    return this;
  }

  /** Gắn id tài nguyên liên quan — xem `resourceId` */
  withResource(resourceId: string): this {
    this.resourceId = resourceId;
    return this;
  }

  /**
   * [v4.11] Slug RIÊNG cho `type` của Problem Details, khi hai lỗi cùng `kind` cần phân
   * biệt được ở client.
   *
   * Ca cụ thể: 403 vì thiếu quyền và 403 vì CSRF sai đều là `ForbiddenError`, nên slug
   * suy từ `kind` cho cả hai là `forbidden` và client phải đọc câu tiếng Việt để rẽ
   * nhánh. Đây là cách sửa nhỏ nhất; **không** thêm một `kind` mới, vì `kind` ánh xạ ngữ
   * nghĩa HTTP và chẻ nó ra làm mờ chính ánh xạ đó.
   *
   * NÉM khi lỗi đã có `problemCode`: với một lỗi có mã, `type` được suy từ mã (client tra
   * catalog bằng mã), nên đặt slug ở đó là một lời gọi **không có tác dụng**. Một hàm chỉ
   * chạy ở nửa số ca mà không báo gì là cái bẫy đắt hơn vấn đề nó đi sửa.
   */
  withTypeSlug(slug: string): this {
    if (this.problemCode !== undefined) {
      throw new Error(
        `withTypeSlug("${slug}") vô nghĩa khi lỗi đã có problemCode ` +
          `"${this.problemCode}": type suy từ mã, không từ slug`,
      );
    }
    this.typeSlug = slug;
    return this;
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

/**
 * [v4.11] Response của CHÍNH server không khớp schema đã khai — một lỗi hợp đồng, 500.
 *
 * Vì sao cần một lớp riêng thay vì để `ZodError` thoát ra: `errorHandler` bắt `ZodError`
 * **trước** mọi nhánh khác và trả **400 "Dữ liệu gửi lên không hợp lệ"** kèm đường dẫn
 * trường — tức một bug của server hiện ra như lỗi của người dùng, và nhánh đó không log
 * gì cả. Người dùng sẽ ngồi sửa form cho một lỗi họ không gây ra.
 */
export class ResponseContractError extends AppError {
  readonly statusCode = 500;
  readonly kind = "INTERNAL" as const;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly kind = "NOT_FOUND" as const;
}

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

/**
 * 409 — xung đột trạng thái: request đúng, nhưng trạng thái hiện tại không cho phép.
 *
 * Optimistic lock có lớp riêng — `OptimisticLockError` bên dưới — vì nó phải mang
 * theo bản mới nhất. (Chú thích "dùng cho optimistic lock" từng nằm lạc phía trên
 * `UnprocessableError`.)
 */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly kind = "CONFLICT" as const;
}

/**
 * 409 `OPTIMISTIC_LOCK` — người khác đã lưu trước, KÈM bản mới nhất (§8.4).
 *
 * §8.4 nói đúng chữ "409 Conflict + bản mới nhất để hiển thị diff": người dùng cần
 * thấy người kia đã lưu GÌ để quyết định, không chỉ biết mình đã thua. Trước lớp này,
 * bản mới nhất được nhét vào `details` của một `ConflictError` — mà `details` chỉ đi vào
 * log, không bao giờ lên dây. Câu chú thích "trả 409 kèm bản mới nhất" vì thế đã
 * không đúng từ Plan #10.
 *
 * `current` là một trường RIÊNG, không phải `details`: `details` có thể chứa bất cứ
 * gì người ném muốn ghi log, còn `current` là đúng bản ghi mà người gọi đang sửa —
 * thứ duy nhất vừa an toàn vừa có nghĩa để gửi lại cho họ.
 */
export class OptimisticLockError extends ConflictError {
  constructor(
    message: string,
    readonly current: unknown,
  ) {
    super(message, undefined, "OPTIMISTIC_LOCK");
  }
}

/**
 * 412 — fencing token đã cũ (I23).
 *
 * Tách khỏi `ConflictError` (409) vì hai thứ khác nhau đúng ở chỗ người gọi cần
 * biết: 409 `OPTIMISTIC_LOCK` bảo "tải lại rồi thử lại", còn 412 bảo "một worker
 * khác đã thay mặt anh — DỪNG". Catalog khai mã này `retryable: false`,
 * `fixableBy: "nobody"`: worker tỉnh muộn mà thử lại là ghi đè đúng thứ fencing
 * sinh ra để bảo vệ. §7.1 xử lý nó bằng đúng một dòng `return`.
 *
 * Luôn ném kèm `problemCode: "PRECONDITION_FAILED"` để `title` lấy từ catalog.
 */
export class PreconditionFailedError extends AppError {
  readonly statusCode = 412;
  readonly kind = "PRECONDITION_FAILED" as const;
}

/**
 * 428 `CONFIRMATION_REQUIRED` [v4.5] — thao tác trên production cần người dùng
 * xác nhận tường minh (gõ lại key của flag, §8.4). Portal nhận mã này thì mở hộp
 * xác nhận rồi gửi lại; một boolean `confirm: true` thì gửi mù được, gõ lại key
 * thì không.
 */
export class ConfirmationRequiredError extends AppError {
  readonly statusCode = 428;
  readonly kind = "CONFIRMATION_REQUIRED" as const;

  constructor(message: string) {
    super(message, undefined, "CONFIRMATION_REQUIRED");
  }
}

/**
 * 503 `PROVIDER_UNAVAILABLE` [v4.4] — một service hay nguồn mà request này phụ
 * thuộc không phản hồi (Service 2, Prometheus). Retryable theo catalog: chính thử
 * lại là cách chữa, khác 500.
 *
 * Mã mặc định là `PROVIDER_UNAVAILABLE` vì đó là nghĩa DUY NHẤT của 503 trong
 * catalog; truyền mã khác chỉ khi catalog có mã 503 hẹp hơn (`CLUSTER_UNREACHABLE`).
 */
export class ServiceUnavailableError extends AppError {
  readonly statusCode = 503;
  readonly kind = "UNAVAILABLE" as const;

  constructor(
    message: string,
    details?: unknown,
    problemCode: ErrorCode = "PROVIDER_UNAVAILABLE",
  ) {
    super(message, details, problemCode);
  }
}

/**
 * [v4.5] Lỗi NGHIỆP VỤ của một service phía sau (Service 2), chuyển tới Portal
 * nguyên vẹn qua Service 1: status, mã catalog, `detail`, `errors`, `current` (bản
 * mới nhất của 409 OPTIMISTIC_LOCK — Portal hiện diff), `resourceId`. `instance` và
 * `traceId` là của request Service 1 — người dùng báo lỗi bằng traceId của S1.
 *
 * Chỉ dựng từ `relayedProblemOf`, nơi quyết định status nào được chuyển tiếp: 404,
 * 409, 422 là trả lời có nghĩa cho người dùng; 401 (sai bí mật nội bộ), 400 (hợp
 * đồng hai service lệch nhau) thì KHÔNG — chuyển 401 tới Portal là đăng xuất người
 * dùng vì một lỗi cấu hình của máy chủ.
 */
export class RelayedProblemError extends AppError {
  readonly kind = "RELAYED" as const;

  constructor(
    readonly statusCode: number,
    readonly problem: RelayedProblem,
  ) {
    super(problem.detail ?? problem.title, undefined, problem.code);
    if (problem.resourceId !== undefined) this.withResource(problem.resourceId);
  }
}

export interface RelayedProblem {
  title: string;
  detail?: string;
  code?: ErrorCode;
  errors?: FieldError[];
  current?: unknown;
  resourceId?: string;
}

const RELAYABLE_STATUSES: ReadonlySet<number> = new Set([404, 409, 422]);

/**
 * `typeSlug` của 404 "không có route" (`notFoundHandler`) — KHÁC slug của 404
 * nghiệp vụ. Hai service lệch phiên bản (S1 gọi một route S2 chưa có) là lỗi hợp
 * đồng, không phải "không tìm thấy flag": không chuyển tiếp, và không để lộ đường
 * dẫn `/internal/...` ra Portal.
 */
export const ROUTE_NOT_FOUND_SLUG = "route-not-found";

const isFieldError = (x: unknown): x is FieldError =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Record<string, unknown>)["field"] === "string" &&
  typeof (x as Record<string, unknown>)["message"] === "string";

/**
 * Body Problem Details của service phía sau ⇒ `RelayedProblemError`, hoặc
 * `undefined` khi status không được chuyển tiếp (bên gọi coi là lỗi hợp đồng).
 * Mã không có trong catalog bị bỏ (I36): Portal chỉ dịch được mã nó biết.
 */
export function relayedProblemOf(
  status: number,
  body: unknown,
): RelayedProblemError | undefined {
  if (!RELAYABLE_STATUSES.has(status)) return undefined;
  const raw =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (
    typeof raw["type"] === "string" &&
    raw["type"].endsWith(`/${ROUTE_NOT_FOUND_SLUG}`)
  ) {
    return undefined;
  }
  const code =
    typeof raw["code"] === "string" && Object.hasOwn(ERROR_CATALOG, raw["code"])
      ? (raw["code"] as ErrorCode)
      : undefined;
  return new RelayedProblemError(status, {
    title: typeof raw["title"] === "string" ? raw["title"] : "Error",
    ...(typeof raw["detail"] === "string" ? { detail: raw["detail"] } : {}),
    ...(code === undefined ? {} : { code }),
    ...(Array.isArray(raw["errors"])
      ? { errors: raw["errors"].filter(isFieldError) }
      : {}),
    ...("current" in raw ? { current: raw["current"] } : {}),
    ...(typeof raw["resourceId"] === "string"
      ? { resourceId: raw["resourceId"] }
      : {}),
  });
}
