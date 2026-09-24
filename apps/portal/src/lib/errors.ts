import { ERROR_CATALOG, type ErrorCode } from "@udp/shared-types/problem";
import { isApiError } from "./http";

/**
 * Chữ tiếng Việt cho 24 mã lỗi của §9 — bất biến I37: `title` của catalog là KHOÁ, chuỗi
 * hiển thị thuộc về frontend.
 *
 * `Record<ErrorCode, string>` chứ không phải object tự do: thêm mã thứ 25 vào catalog mà
 * quên dịch là lỗi biên dịch ở đây, không phải một thông báo tiếng Anh lọt lên màn hình.
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  MISSING_CAPABILITY: "Thiếu một năng lực mà công cụ này cần.",
  MISSING_ANY_OF: "Cần bật ít nhất một trong các năng lực bắt buộc.",
  VERSION_MISMATCH: "Phiên bản năng lực không tương thích.",
  CONFLICT: "Hai công cụ cùng đòi một năng lực độc quyền.",
  AMBIGUOUS_PROVIDER:
    "Có nhiều nguồn cùng cung cấp năng lực này, hãy chọn một.",
  RECOMMENDED_MISSING: "Nên bật thêm một năng lực được khuyến nghị.",
  CYCLIC_DEPENDENCY: "Cấu hình domain có vòng phụ thuộc.",
  ORPHAN_RULE: "Có rule trỏ tới một variant không còn tồn tại.",
  VARIANT_IN_USE: "Variant này vẫn đang được một rule dùng.",
  METRICS_NOT_AVAILABLE: "Nguồn metrics chưa có dữ liệu cho workload này.",
  TRACKED_FLAG_LIMIT: "Environment này đã theo dõi quá nhiều flag cùng lúc.",
  FLAG_RECENTLY_EVALUATED:
    "Flag vẫn đang được đánh giá gần đây, chưa lưu trữ được.",
  SEGMENT_IN_USE: "Segment vẫn đang được rule của flag dùng.",
  INSUFFICIENT_PERMISSIONS: "Credential cloud thiếu quyền cần thiết.",
  QUOTA_EXCEEDED: "Vượt trần tài nguyên của project.",
  CLUSTER_UNREACHABLE: "Không kết nối được tới cluster.",
  ROLLOUT_IN_PROGRESS: "Đang có một rollout chạy trên đối tượng này.",
  DUPLICATE_RESOURCE: "Tên hoặc key này đã tồn tại.",
  OPTIMISTIC_LOCK:
    "Dữ liệu vừa được người khác sửa. Đã tải lại bản mới, hãy xem rồi lưu lại.",
  CONFIRMATION_REQUIRED: "Thao tác này cần xác nhận bằng cách gõ lại key.",
  PRECONDITION_FAILED: "Điều kiện của thao tác không còn đúng.",
  PROVIDER_UNAVAILABLE:
    "Một dịch vụ phụ thuộc đang không phản hồi. Thử lại sau.",
  IDEMPOTENCY_KEY_REUSED: "Yêu cầu bị gửi trùng với nội dung khác.",
  EGRESS_BLOCKED: "Địa chỉ đích bị chặn vì lý do an toàn.",
};

const STATUS_COPY: Record<number, string> = {
  400: "Dữ liệu gửi lên không hợp lệ.",
  401: "Phiên đăng nhập đã hết hạn.",
  403: "Bạn không có quyền làm việc này.",
  404: "Không tìm thấy dữ liệu.",
  413: "Dữ liệu gửi lên quá lớn.",
  429: "Thao tác quá nhanh. Đợi một chút rồi thử lại.",
};

const isErrorCode = (code: string): code is ErrorCode => code in ERROR_CATALOG;

/**
 * Một câu cho người dùng từ một lỗi bất kỳ.
 *
 * Lỗi mà "không ai sửa được" (`fixableBy: nobody`) và lỗi 5xx kèm mã tra cứu: đó là bug,
 * nói "thử lại" là bảo người dùng lặp một việc vô ích (§9, `ErrorCodeSpec.fixableBy`).
 */
export function messageOf(error: unknown): string {
  if (!isApiError(error)) return "Có lỗi không mong đợi.";
  if (error.kind === "network") return "Mất kết nối tới máy chủ.";
  if (error.kind === "contract") {
    return "Phản hồi của máy chủ không đúng định dạng. Tải lại trang, nếu vẫn lỗi hãy báo cho quản trị.";
  }

  const problem = error.problem;
  const code = problem?.code;
  if (code !== undefined && isErrorCode(code)) {
    const text = ERROR_COPY[code];
    return ERROR_CATALOG[code].fixableBy === "nobody"
      ? `${text} Mã tra cứu: ${problem?.traceId ?? "?"}`
      : text;
  }
  const field = problem?.errors?.[0];
  if (field !== undefined) return field.message;
  if (error.status >= 500) {
    return `Lỗi hệ thống. Mã tra cứu: ${problem?.traceId ?? "?"}`;
  }
  return STATUS_COPY[error.status] ?? problem?.detail ?? "Có lỗi xảy ra.";
}

/** Lỗi theo từng trường của form — hiện NGAY cạnh ô nhập, không bao giờ qua toast (§10.10) */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error)) return {};
  const out: Record<string, string> = {};
  for (const e of error.problem?.errors ?? []) {
    if (out[e.field] === undefined) out[e.field] = e.message;
  }
  return out;
}
