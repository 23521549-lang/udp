import type { Request, Response } from "express";
import {
  ERROR_CATALOG,
  type ErrorCode,
  type ProblemDetails,
} from "@udp/shared-types/problem";

/**
 * Dựng và gửi lỗi theo RFC 9457.
 *
 * Tách khỏi `error-handler.ts` vì có SÁU chỗ trong service phát sinh lỗi, không
 * phải một: `notFoundHandler`, JSON hỏng, `ZodError`, `AppError`, lỗi ngoài dự
 * kiến, và middleware rate limit. Để mỗi chỗ tự dựng object thì `Content-Type`
 * và `traceId` sẽ thiếu ở một vài chỗ, và không ai phát hiện được cho tới khi
 * client gặp một hình dạng lỗi lạ.
 */

/** RFC 9457 yêu cầu media type riêng; `res.json()` mặc định trả application/json */
const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Namespace của `type` URI. Chưa cần host thật, chỉ cần định danh ổn định */
const PROBLEM_TYPE_BASE = "https://udp.dev/problems";

/**
 * `traceId` lấy từ `req.id` do `pino-http` sinh sẵn cho MỌI request.
 *
 * Nhờ vậy id mà người dùng đọc cho support khớp đúng dòng log của request đó,
 * không cần dựng thêm hạ tầng correlation nào. Nếu vì lý do gì không có id,
 * trả chuỗi rỗng thay vì bịa ra một id không tra được trong log.
 */
function traceIdOf(req: Request): string {
  const id: unknown = (req as Request & { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/** `type` URI suy từ mã, không cần bảng thứ hai */
function typeUriOf(code: ErrorCode | undefined, fallbackSlug: string): string {
  const slug = code ? code.toLowerCase().replaceAll("_", "-") : fallbackSlug;
  return `${PROBLEM_TYPE_BASE}/${slug}`;
}

export interface BuildProblemInput {
  req: Request;
  status: number;
  /** Nhãn ổn định tiếng Anh, dùng làm khóa i18n. Bỏ trống thì lấy từ catalog */
  title?: string;
  /** Chi tiết của đúng lần này. PHẢI đã qua redact() nếu có thể chứa secret (I12) */
  detail?: string;
  code?: ErrorCode;
  errors?: ProblemDetails["errors"];
  suggestedAction?: ProblemDetails["suggestedAction"];
  /** Dùng cho lỗi giao thức không có mã nghiệp vụ, vd "not-found", "internal" */
  typeSlug?: string;
  /** Chỉ với `OPTIMISTIC_LOCK`: bản mới nhất để hiển thị diff (§8.4) */
  current?: unknown;
}

/**
 * Dựng `ProblemDetails`.
 *
 * CHÚ Ý: `status` là tham số BẮT BUỘC và KHÔNG được suy từ `ERROR_CATALOG`. Lý do
 * là `RECOMMENDED_MISSING` có `httpStatus: 200` — nó là cảnh báo nằm trong
 * `warnings[]` của kết quả validate, không phải một lỗi ném ra. Map mù từ catalog
 * sẽ có ngày trả `application/problem+json` kèm status 200.
 */
export function buildProblem({
  req,
  status,
  title,
  detail,
  code,
  errors,
  suggestedAction,
  typeSlug = "about:blank",
  current,
}: BuildProblemInput): ProblemDetails {
  const resolvedTitle = title ?? (code ? ERROR_CATALOG[code].title : "Error");

  return {
    type: typeUriOf(code, typeSlug),
    title: resolvedTitle,
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: req.originalUrl,
    ...(code === undefined ? {} : { code }),
    ...(errors === undefined ? {} : { errors }),
    ...(suggestedAction === undefined ? {} : { suggestedAction }),
    ...(current === undefined ? {} : { current }),
    traceId: traceIdOf(req),
  };
}

/** Gửi lỗi kèm đúng media type của RFC 9457 */
export function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
}
