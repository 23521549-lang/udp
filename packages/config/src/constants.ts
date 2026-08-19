/**
 * Hằng số nghiệp vụ dùng chung cho cả 3 service.
 *
 * Nguyên tắc: KHÔNG viết số hoặc chuỗi nghiệp vụ trực tiếp trong code.
 * Mọi giá trị có thể phải chỉnh đều nằm ở đây (nếu cố định theo thiết kế)
 * hoặc ở `env` (nếu khác nhau giữa các môi trường).
 *
 * Ranh giới giữa hai nơi:
 *   - constants.ts : giá trị do THIẾT KẾ quy định, giống nhau ở mọi môi trường
 *   - env.ts       : giá trị do MÔI TRƯỜNG quy định, khác nhau giữa dev và prod
 */

// ============================================================
// Environment mặc định khi tạo project (Design v3 §2.2)
// ============================================================

export const DEFAULT_ENVIRONMENTS = [
  { name: "dev", rank: 0, isProduction: false },
  { name: "staging", rank: 1, isProduction: false },
  { name: "prod", rank: 2, isProduction: true },
] as const;

/** Mẫu sinh namespace K8s: udp-{project}-{env}, tối đa 63 ký tự theo chuẩn K8s */
export const K8S_NAMESPACE_MAX_LENGTH = 63;

// ============================================================
// Feature flag (Design v3 §6)
// ============================================================

/**
 * Tổng số bucket cho percentage targeting.
 * 100_000 cho phép ngưỡng tới 0.001% — nhu cầu thật khi canary trên traffic lớn.
 * ĐỔI GIÁ TRỊ NÀY LÀ THAY ĐỔI PHÁ VỠ: mọi người dùng sẽ được phân lại nhóm.
 */
export const TOTAL_BUCKETS = 100_000;

/** Thuộc tính mặc định dùng để hash khi flag không chỉ định rõ */
export const DEFAULT_STICKINESS_ATTRIBUTE = "userId";

/** Variant tự sinh cho flag kiểu BOOLEAN */
export const BOOLEAN_VARIANTS = { ON: "on", OFF: "off" } as const;

/** Ngưỡng cảnh báo flag chết (Design v3 §6.7) */
export const STALE_FLAG_THRESHOLDS = {
  /** ACTIVE nhưng không có lượt đánh giá nào trong N ngày */
  unusedDays: 30,
  /** 100% lượt đánh giá rơi vào cùng một variant suốt N ngày */
  settledDays: 14,
  /** DRAFT quá N ngày mà chưa từng ACTIVE */
  staleDraftDays: 30,
  /** Chặn xóa flag còn được đánh giá trong N ngày gần nhất */
  deleteGuardDays: 7,
} as const;

// ============================================================
// Progressive delivery (Design v3 §7)
// ============================================================

/** Ngưỡng mặc định khi người dùng không chỉ định lúc tạo rollout */
export const DEFAULT_ROLLOUT_THRESHOLDS = {
  errorRate: 0.05,
  latencyP99Ms: 1000,
  minRequests: 100,
  /**
   * Số lần đo LIÊN TIẾP vượt ngưỡng mới rollback.
   * Bằng 1 sẽ rollback vì một spike thoáng qua — xem E6 (§14).
   */
  maxConsecutiveBreaches: 2,
} as const;

// ============================================================
// Điều phối worker — cơ chế lease (Design v3 ADR-05)
// ============================================================

export const LEASE = {
  /** Thời gian giữ lease mỗi lần claim */
  durationSeconds: 60,
  /** Chu kỳ gia hạn — phải NHỎ HƠN NHIỀU so với durationSeconds */
  renewIntervalMs: 20_000,
} as const;

// ============================================================
// Change feed — ba tầng (Design v3 ADR-05)
// ============================================================

export const CHANGE_FEED = {
  /** Chu kỳ poll config_version (tầng 1) */
  pollIntervalMs: 500,
  /** Jitter ngẫu nhiên để các replica không đồng pha */
  pollJitterMs: 200,
  /** Tầng 2 đứng im quá lâu (transaction dài chặn horizon) ⇒ rơi về tầng 1 */
  horizonStallTimeoutMs: 30_000,
  /** Số lần fallback liên tiếp trước khi ngắt mạch tầng 2 */
  circuitBreakerThreshold: 3,
  /** Thời gian tắt tầng 2 sau khi ngắt mạch */
  circuitBreakerCooldownMs: 5 * 60_000,
  /** Giữ ConfigChangeLog bao lâu trước khi dọn */
  retentionDays: 7,
} as const;

// ============================================================
// Xác thực (Design v3 §10.4)
// ============================================================

export const AUTH = {
  /**
   * bcrypt cắt âm thầm mọi thứ sau byte thứ 72. Không chặn ở tầng validate thì
   * hai mật khẩu khác nhau ở ký tự thứ 80 sẽ đăng nhập được cho nhau.
   */
  passwordMinLength: 8,
  passwordMaxLength: 72,
  /** Số byte ngẫu nhiên của CSRF token */
  csrfTokenBytes: 32,
} as const;

/**
 * Tên cookie. Tập trung ở đây vì cả backend lẫn Portal đều tham chiếu tới —
 * đổi tên ở một chỗ là đủ.
 */
export const COOKIE_NAMES = {
  accessToken: "udp_access",
  refreshToken: "udp_refresh",
  /** Cố ý KHÔNG httpOnly để Portal đọc được và gắn vào header */
  csrfToken: "udp_csrf",
} as const;

export const CSRF_HEADER = "X-CSRF-Token";

/** Giới hạn tần suất cho endpoint nhạy cảm — chống dò mật khẩu */
export const RATE_LIMIT = {
  auth: { windowMs: 15 * 60_000, max: 20 },
  general: { windowMs: 60_000, max: 300 },
} as const;

// ============================================================
// SSE (Design v3 §6.3)
// ============================================================

export const SSE = {
  /** Nhịp tim chống proxy đóng kết nối idle (nginx/ALB thường 60s) */
  heartbeatMs: 20_000,
  /** Số lần SSE thất bại liên tiếp trước khi SDK chuyển sang polling */
  fallbackAfterFailures: 3,
  /** Chu kỳ polling khi SSE không khả dụng */
  pollingFallbackMs: 30_000,
} as const;

// ============================================================
// SDK key (Design v3 §2.2)
// ============================================================

export const SDK_KEY = {
  serverPrefix: "udp_sk_",
  clientPrefix: "udp_ck_",
  /** Số byte ngẫu nhiên của key */
  randomBytes: 32,
  /** Số ký tự đầu lưu lại để hiển thị trong UI */
  displayPrefixLength: 12,
  /** Throttle cập nhật last_used_at để không ghi DB mỗi request */
  lastUsedThrottleMs: 60_000,
} as const;

// ============================================================
// Quota tài nguyên mặc định (Design v3 §4.4)
// ============================================================

/**
 * Trần tài nguyên áp cho project mới. Cưỡng chế ở MỌI lời gọi adapter.
 * Trong mô hình BYOC, bug về vòng lặp provisioning tiêu tiền thật của
 * developer — nên đây là giá trị an toàn, người dùng phải chủ động nâng.
 */
export const DEFAULT_RESOURCE_QUOTA = {
  maxNodes: 3,
  maxNodeSize: "medium",
  maxDatabases: 2,
  maxStorageGb: 50,
} as const;

/** TTL mặc định cho project ở môi trường lab (giờ). null = không hết hạn */
export const DEFAULT_PROJECT_TTL_HOURS = 6;

// ============================================================
// Redaction — danh sách khóa bị che trước khi ghi log/audit
// (Design v3 §2.2, §12)
// ============================================================

export const REDACTED_KEY_PATTERNS = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /apikey/i,
  /api_key/i,
  /private_?key/i,
  /serviceaccountjson/i,
  /encrypted_?payload/i,
  /accesskey/i,
  /clientsecret/i,
] as const;

export const REDACTED_PLACEHOLDER = "[REDACTED]";
