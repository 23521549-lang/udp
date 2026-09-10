/**
 * Lỗi HTTP theo RFC 9457 `application/problem+json`, và danh mục mã lỗi (§9).
 *
 * Vì sao gom vào package dùng chung thay vì để mỗi service tự định nghĩa:
 * bất biến **I36** nói *"không mã lỗi nào tồn tại ngoài catalog"*, và nó chỉ cưỡng
 * chế được bằng trình biên dịch nếu backend lẫn Portal cùng import MỘT object.
 * Mỗi bên một bản sao thì I36 thành lời hứa, không phải bảo đảm.
 *
 * File này KHÔNG import gì từ `@udp/db` — đó là chỗ duy nhất tạo được vòng phụ
 * thuộc `db → shared-types → db`.
 */

/**
 * Đặc tả của một mã lỗi.
 *
 * Bốn trường đầu không phải metadata trang trí: mỗi trường quyết định một hành vi
 * cụ thể ở tầng trên, nên thiếu trường nào là tầng trên phải đoán.
 */
export interface ErrorCodeSpec {
  /** Status trả về. KHÔNG map mù từ đây: xem cảnh báo ở `RECOMMENDED_MISSING` bên dưới */
  httpStatus: number;
  /** Client có nên thử lại không — thay vì để client tự đoán theo status */
  retryable: boolean;
  /**
   * AI sửa được lỗi này. Đây là trường quyết định HÀNH VI UI:
   *   "user"   → hiện nút hành động cụ thể (bật domain, chọn provider, sửa config)
   *   "admin"  → chỉ platform admin thấy chi tiết; người dùng thường thấy thông báo chung
   *   "nobody" → đây là bug: hiện traceId và nút báo lỗi, KHÔNG bảo người dùng "thử lại"
   *
   * Không có nó, UI phải đoán. Đoán sai hướng nào cũng tệ: bảo người dùng thử lại
   * trước một bug thì họ thử mãi; phơi chi tiết lỗi hạ tầng cho người dùng thường
   * thì vừa vô ích vừa rò thông tin.
   */
  fixableBy: "user" | "admin" | "nobody";
  /**
   * Nhãn ngắn, ỔN ĐỊNH, tiếng Anh — đi thẳng vào `ProblemDetails.title` và đồng
   * thời là KHÓA i18n của frontend (§9).
   *
   * Vì sao nằm ở đây chứ không ở một map riêng: `title` "không đổi theo từng lần
   * xảy ra". Để nó ở bảng thứ hai thì hai bảng sẽ lệch nhau, đúng thứ mà việc gom
   * về một nguồn sự thật sinh ra để tránh. Chuỗi hiển thị tiếng Việt thuộc về
   * frontend, tra theo khóa này (bất biến I37).
   */
  title: string;
  /** Mục nào của thiết kế định nghĩa nó — để tra ngược khi tranh luận hành vi */
  docSection: string;
}

/**
 * Danh mục 21 mã lỗi (§9).
 *
 * CẢNH BÁO CHO NGƯỜI SỬA FILE NÀY — hai chữ `as const satisfies` là bắt buộc.
 *
 * Nếu đổi thành `export const ERROR_CATALOG: Record<string, ErrorCodeSpec> = {...}`
 * thì `keyof typeof ERROR_CATALOG` suy ra `string`, và **I36 bị vô hiệu hoàn toàn
 * trong khi mọi thứ vẫn biên dịch xanh** — một mã bịa ra sẽ lọt qua. Đã kiểm chứng
 * bằng `tsc` trên TypeScript 5.9.
 *
 *   `as const`  giữ literal để `keyof` ra union 21 khoá
 *   `satisfies` kiểm hình dạng mà KHÔNG làm mất literal
 */
export const ERROR_CATALOG = {
  // ---- Capability validator (§5.3). Bảy mã này là tập mà oracle của E8 phải
  // sinh ra đủ khi kiểm độ phủ validator (bất biến I35) ----
  MISSING_CAPABILITY: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Missing capability",
    docSection: "§5.3",
  },
  MISSING_ANY_OF: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Missing one of required capabilities",
    docSection: "§5.3",
  },
  VERSION_MISMATCH: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Capability version mismatch",
    docSection: "§5.3",
  },
  CONFLICT: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Exclusive capability conflict",
    docSection: "§5.3",
  },
  AMBIGUOUS_PROVIDER: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Ambiguous capability provider",
    docSection: "§5.3",
  },
  /**
   * CẢNH BÁO chứ không phải lỗi — `httpStatus: 200` là CÓ CHỦ Ý.
   * §9 xếp nó vào `warnings[]` của `DomainValidationResponse`, không vào `errors[]`.
   * Đây là lý do `error-handler.ts` KHÔNG được map mù `httpStatus` từ catalog:
   * làm vậy sẽ có ngày trả `application/problem+json` kèm status 200.
   */
  RECOMMENDED_MISSING: {
    httpStatus: 200,
    retryable: false,
    fixableBy: "user",
    title: "Recommended capability missing",
    docSection: "§5.3",
  },
  CYCLIC_DEPENDENCY: {
    httpStatus: 500,
    retryable: false,
    fixableBy: "nobody",
    title: "Cyclic capability dependency",
    docSection: "§5.3",
  },

  // ---- Feature flag (§6) ----
  /**
   * [v4] Trước đây §6.7 dùng mã này để chặn lưu nhưng nó không nằm trong danh mục,
   * tức là trái I36. Bổ sung thành mã thứ 19.
   */
  ORPHAN_RULE: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Rule references a non-existent variant",
    docSection: "§6.7",
  },
  /**
   * [v4] Mã thứ 20. TÁCH khỏi ORPHAN_RULE có chủ đích, vì hai tình huống khác
   * nhau đúng ở chỗ quan trọng nhất với người gọi:
   *
   *   ORPHAN_RULE     request SAI NỘI DUNG — gửi lại y nguyên vẫn hỏng
   *   VARIANT_IN_USE  request ĐÚNG, trạng thái xung đột — gỡ rule rồi thử lại là được
   *
   * Gộp chúng làm mất `retryable` và `suggestedAction`, hai trường §9 sinh ra để
   * Portal biết nên hiện nút "Sửa rule" hay nút "Thử lại".
   */
  VARIANT_IN_USE: {
    httpStatus: 409,
    retryable: true,
    fixableBy: "user",
    title: "Variant is still referenced by a rule",
    docSection: "§6.7",
  },
  METRICS_NOT_AVAILABLE: {
    httpStatus: 422,
    retryable: true,
    fixableBy: "user",
    title: "Metrics source has no data for this target",
    docSection: "§6.6, §8.5",
  },
  TRACKED_FLAG_LIMIT: {
    httpStatus: 409,
    retryable: false,
    fixableBy: "user",
    title: "Too many flags tracked in this environment",
    docSection: "§6.6",
  },

  // ---- Cloud adapter và quota (§4) ----
  INSUFFICIENT_PERMISSIONS: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Cloud credential lacks required permissions",
    docSection: "§4.2",
  },
  QUOTA_EXCEEDED: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Resource quota exceeded",
    docSection: "§4.4",
  },
  CLUSTER_UNREACHABLE: {
    httpStatus: 503,
    retryable: true,
    fixableBy: "admin",
    title: "Tenant cluster unreachable",
    docSection: "§4.6",
  },

  // ---- Progressive delivery và đồng thời (§7) ----
  ROLLOUT_IN_PROGRESS: {
    httpStatus: 409,
    retryable: true,
    fixableBy: "user",
    title: "A rollout is already in progress",
    docSection: "§8.6",
  },
  /**
   * [v4] Mã thứ 21. Vi phạm ràng buộc UNIQUE bất kỳ — tên project trùng, key
   * flag trùng, email đã đăng ký.
   *
   * Không gộp vào `CONFLICT`: mã đó dành riêng cho xung đột capability độc
   * quyền ở §5.3 và mang 422. Cũng không gộp vào `OPTIMISTIC_LOCK`: cái đó
   * `retryable` vì refetch rồi gửi lại là xong, còn ở đây gửi lại y nguyên vẫn
   * trùng — người dùng phải ĐỔI giá trị.
   *
   * Trước khi có mã này, mọi P2002 rơi xuống nhánh 500 "Lỗi hệ thống": sai
   * status, và bảo client retry một request không bao giờ đúng.
   */
  DUPLICATE_RESOURCE: {
    httpStatus: 409,
    retryable: false,
    fixableBy: "user",
    title: "Resource already exists",
    docSection: "§2.2",
  },
  OPTIMISTIC_LOCK: {
    httpStatus: 409,
    retryable: true,
    fixableBy: "user",
    title: "Resource was modified by someone else",
    docSection: "§2.2",
  },
  /** Fencing đã chặn một worker tỉnh muộn — không phải lỗi người dùng (I23) */
  PRECONDITION_FAILED: {
    httpStatus: 412,
    retryable: false,
    fixableBy: "nobody",
    title: "Precondition failed",
    docSection: "§7.1, I23",
  },
  PROVIDER_UNAVAILABLE: {
    httpStatus: 503,
    retryable: true,
    fixableBy: "admin",
    title: "Dependent service unavailable",
    docSection: "§7.6",
  },

  // ---- Giao thức HTTP và bảo mật ----
  /** Cùng key nhưng khác body — lỗi lập trình của client, không phải của người dùng */
  IDEMPOTENCY_KEY_REUSED: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "nobody",
    title: "Idempotency key reused with a different body",
    docSection: "§9",
  },
  EGRESS_BLOCKED: {
    httpStatus: 422,
    retryable: false,
    fixableBy: "user",
    title: "Outbound address blocked by egress guard",
    docSection: "§12 T11",
  },
} as const satisfies Record<string, ErrorCodeSpec>;

/**
 * Union 21 mã. Đây là thứ cưỡng chế I36: gán một chuỗi không có trong catalog vào
 * `ProblemDetails.code` sẽ KHÔNG BIÊN DỊCH ĐƯỢC, không cần test nào.
 */
export type ErrorCode = keyof typeof ERROR_CATALOG;

/** Kiểm lúc nạp module — thà sập lúc khởi động còn hơn thiếu mã mà không ai biết */
const EXPECTED_ERROR_CODES = 21;
if (Object.keys(ERROR_CATALOG).length !== EXPECTED_ERROR_CODES) {
  throw new Error(
    `ERROR_CATALOG có ${Object.keys(ERROR_CATALOG).length} mã, §9 nói ${EXPECTED_ERROR_CODES}.`,
  );
}

/** Lỗi ở mức từng trường, dùng cho kết quả validate của Zod */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Hành động cụ thể mà Portal hiện thành nút bấm.
 *
 * Đây là thứ biến một thông báo lỗi thành một việc làm được: thay vì
 * "Flagger cần metrics.query", người dùng thấy nút "Bật Prometheus" (§5.3).
 */
export interface SuggestedAction {
  type: "ENABLE_DOMAIN" | "SWITCH_TOOL" | "CHOOSE_PROVIDER";
  domainType: string;
  toolId?: string | undefined;
  capabilityId?: string | undefined;
}

/**
 * Hình dạng lỗi DUY NHẤT của mọi API, theo RFC 9457.
 *
 * Mọi trường optional đều khai `?: T | undefined` chứ không phải `?: T`. Lý do:
 * `exactOptionalPropertyTypes: true` phân biệt hai cách khai đó, và dựng object
 * theo kiểu `{ detail: err.detail }` với `err.detail?: string` sẽ KHÔNG biên dịch
 * được nếu khai `?: T`. Đã kiểm chứng bằng `tsc`.
 */
export interface ProblemDetails {
  /** URI định danh loại lỗi, vd "https://udp.dev/problems/capability-conflict" */
  type: string;
  /** Nhãn ổn định, không đổi theo từng lần xảy ra — dùng làm khóa i18n */
  title: string;
  status: number;
  /** Chi tiết của đúng lần này. PHẢI đi qua redact() trước khi gán (I12) */
  detail?: string | undefined;
  /** URI của chính request gây lỗi */
  instance?: string | undefined;
  /**
   * OPTIONAL có chủ ý. 401, 403, 404 và lỗi 500 chung không có mã nào trong 21 mã
   * phủ được — bắt buộc `code` sẽ làm những trường hợp đó không biểu diễn nổi.
   */
  code?: ErrorCode | undefined;
  errors?: FieldError[] | undefined;
  suggestedAction?: SuggestedAction | undefined;
  /**
   * Trường mở rộng của RFC 9457, CHỈ có với `OPTIMISTIC_LOCK`: bản mới nhất của
   * resource để Portal hiển thị diff (§8.4 "409 Conflict + bản mới nhất").
   */
  current?: unknown;
  /** Luôn có, để đối chiếu với log. Đây là thứ người dùng đọc cho support */
  traceId: string;
}
