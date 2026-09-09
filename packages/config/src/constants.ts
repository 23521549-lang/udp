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
// Environment mặc định khi tạo project (Design v4 §2.2)
// ============================================================

export const DEFAULT_ENVIRONMENTS = [
  { name: "dev", rank: 0, isProduction: false },
  { name: "staging", rank: 1, isProduction: false },
  { name: "prod", rank: 2, isProduction: true },
] as const;

/** Nhãn DNS-1123: chữ thường, số, gạch ngang; bắt đầu và kết thúc bằng chữ-số */
export const K8S_NAMESPACE_MAX_LENGTH = 63;

/** Cắt phần tên project TRƯỚC khi nối hậu tố — xem `k8sNamespaceFor` */
const PROJECT_SLUG_MAX = 20;
const ENV_SLUG_MAX = 12;
const PROJECT_ID_SUFFIX_LENGTH = 6;

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Bỏ dấu tiếng Việt rồi rút về nhãn DNS-1123.
 *
 * `normalize("NFD")` tách nguyên âm khỏi dấu thanh để `\p{M}` xoá được phần
 * dấu. Riêng `đ`/`Đ` không phải nguyên âm ghép nên NFD không tách ra, phải thay
 * tay — thiếu dòng đó thì mọi chữ `đ` biến thành gạch ngang.
 */
const toLabel = (value: string, max: number): string =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");

/**
 * Sinh namespace K8s cho một environment.
 *
 * Bản trước — `udp-{project}-{env}` rồi `slice(0, 63)` — hỏng ba cách, cả ba
 * đều đã đo được chứ không phải suy đoán:
 *
 *  1. Tên project dài 64 ký tự làm `dev`, `staging` và `prod` ra CÙNG MỘT
 *     chuỗi, vì phép cắt ăn mất đúng phần hậu tố phân biệt chúng. Hai
 *     environment lẽ ra cô lập lại dùng chung một namespace — phá ranh giới của
 *     ADR-04 và T10, và không index nào bắt được.
 *  2. `"Dự án Bán hàng"` và `"Dứ àn Bán hàng"` cùng ra `udp-d---n-b-n-h-ng-dev`,
 *     vì mọi ký tự có dấu đều bị thay bằng `-`.
 *  3. Tên dài 58 hoặc 63 ký tự cho ra chuỗi kết thúc bằng `-`, vi phạm
 *     DNS-1123 — API server từ chối, nhưng mãi tới lúc provisioning, rất xa chỗ
 *     gây ra lỗi.
 *
 * Ba biện pháp tương ứng: cắt tên project TRƯỚC khi nối env, bỏ dấu thay vì
 * thay bằng `-`, và trim gạch ngang sau mỗi lần cắt. Sáu ký tự đầu của
 * `projectId` chặn va chạm giữa hai project khác tên nhưng cùng slug.
 *
 * Vẫn ném khi kết quả không hợp lệ. Không phải phòng xa thừa: chuỗi này đi
 * thẳng vào API server, nên chỗ rẻ nhất để phát hiện sai là ngay đây.
 */
export function k8sNamespaceFor(projectName: string, projectId: string, envName: string): string {
  const project = toLabel(projectName, PROJECT_SLUG_MAX) || "p";
  const env = toLabel(envName, ENV_SLUG_MAX) || "e";
  const suffix = projectId.replace(/-/g, "").slice(0, PROJECT_ID_SUFFIX_LENGTH).toLowerCase();

  const namespace = `udp-${project}-${suffix}-${env}`;

  if (namespace.length > K8S_NAMESPACE_MAX_LENGTH || !DNS_1123_LABEL.test(namespace)) {
    throw new Error(
      `Không sinh được namespace hợp lệ từ project "${projectName}" và environment ` +
        `"${envName}": kết quả "${namespace}" không phải nhãn DNS-1123.`,
    );
  }

  return namespace;
}

// ============================================================
// Feature flag (Design v4 §6)
// ============================================================

/**
 * Tổng số bucket cho percentage targeting.
 * 100_000 cho phép ngưỡng tới 0.001% — nhu cầu thật khi canary trên traffic lớn.
 * ĐỔI GIÁ TRỊ NÀY LÀ THAY ĐỔI PHÁ VỠ: mọi người dùng sẽ được phân lại nhóm.
 */
export const TOTAL_BUCKETS = 100_000;

/**
 * Thuộc tính mặc định dùng để hash khi flag không chỉ định rõ.
 *
 * `targetingKey` chứ không phải `userId`: đó là tên chuẩn của OpenFeature cho
 * định danh chính trong evaluation context, nên SDK của bất kỳ ngôn ngữ nào cũng
 * điền sẵn. Dùng `userId` buộc mọi ứng dụng phải tự map lại (§6.4).
 */
export const DEFAULT_STICKINESS_ATTRIBUTE = "targetingKey";

/** Variant tự sinh cho flag kiểu BOOLEAN */
export const BOOLEAN_VARIANTS = { ON: "on", OFF: "off" } as const;

/** Ngưỡng cảnh báo flag chết (Design v4 §6.7) */
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
// Progressive delivery (Design v4 §7)
// ============================================================

/** Ngưỡng mặc định khi người dùng không chỉ định lúc tạo rollout (§7.1, §7.4) */
export const DEFAULT_ROLLOUT_THRESHOLDS = {
  /** Ngưỡng TUYỆT ĐỐI cho error rate của nhánh canary */
  errorRate: 0.05,
  /**
   * Ngưỡng TƯƠNG ĐỐI so với nhánh baseline. Cần vì mọi hệ thống đều có nền lỗi
   * sẵn có: so tuyệt đối sẽ rollback nhầm ở service vốn đã có 4% lỗi, và bỏ sót
   * ở service vốn chỉ có 0,01%.
   */
  relativeErrorRate: 1.5,
  latencyP99Ms: 1000,
  /**
   * Số lỗi TỐI THIỂU mới coi là vượt ngưỡng. Ở 100 request, độ phân giải của
   * error rate là 1% — một lỗi duy nhất đã vượt ngưỡng 0,05 nếu không có sàn này.
   */
  minErrors: 5,
  /**
   * Số lần đo LIÊN TIẾP vượt ngưỡng mới rollback.
   * Bằng 1 sẽ rollback vì một spike thoáng qua — E6 đo chính điều này.
   */
  maxConsecutiveBreaches: 2,
} as const;

/**
 * Nhịp của reconciler (§7.1). Bốn con số đầu TÁCH RỜI nhau, và đó là điểm sửa
 * quan trọng nhất của v4 ở tầng progressive delivery.
 *
 * v3 để dwell chặn trước `decide()`, nên sau mỗi lần promote không có phép đo nào
 * trong suốt 5 phút. Với maxConsecutiveBreaches = 2, MTTD tối thiểu thành 10 phút,
 * tự phá lập luận "rollback trong một vòng SSE" và làm phép đo E5 vô nghĩa.
 */
export const ROLLOUT_TIMING = {
  /** Vòng quét của reconciler; mỗi session tự quyết theo analysisInterval của nó */
  loopIntervalMs: 5_000,
  /** Nhịp ĐO metrics */
  analysisIntervalSeconds: 30,
  /** Thời gian tối thiểu ở một bậc TRƯỚC KHI promote */
  stepIntervalSeconds: 300,
  /**
   * Cửa sổ truy vấn metric. Validator ép >= 4 x scrapeInterval mà probe() đo được:
   * cửa sổ hẹp hơn scrape interval thì Prometheus chưa đủ điểm dữ liệu và trả về
   * khoảng trống, dễ bị hiểu nhầm thành "không có lỗi".
   */
  metricWindowSeconds: 60,
  /** Quá hạn này thì kết thúc rollout và revert về baseline, không treo vô hạn */
  maxDurationSeconds: 86_400,
  /** Chưa đủ số request này thì HOLD — một lỗi trên 10 request là 10% error rate */
  warmUpRequests: 100,
  /** Rollback FLAG_LEVEL phải PATCH sang Service 2; hết hạn này ⇒ DEPENDENCY_DOWN */
  rollbackRetrySeconds: 120,
} as const;

/**
 * §6.6 — Trần số flag được gắn nhãn `ff` cùng lúc trong một environment.
 *
 * Đây là trần CỨNG chứ không phải gợi ý: số series histogram tỉ lệ với
 * (1 + T x V). Với T = 3 và V = 2 thì hệ số là 7, cộng thêm chứ không nhân chéo.
 * Gắn nhãn cho MỌI flag như v3 định làm, với 50 flag, hệ số là 101. E14 đo điều này.
 */
export const MAX_TRACKED_FLAGS_PER_ENV = 3;

// ============================================================
// Điều phối worker — cơ chế lease (Design v4 ADR-05)
// ============================================================

/**
 * Lease của RolloutSession — vòng điều khiển chạy mỗi 5 giây nên mất lease phải
 * phát hiện nhanh.
 */
export const ROLLOUT_LEASE = {
  /** Thời gian giữ lease mỗi lần claim */
  durationSeconds: 60,
  /** Chu kỳ gia hạn — phải NHỎ HƠN NHIỀU so với durationSeconds */
  renewIntervalMs: 20_000,
} as const;

/**
 * Lease của ProvisioningJob — KHÁC ROLLOUT_LEASE, và khác có chủ đích (§2.2).
 *
 * Một bước provisioning gọi API cloud có thể mất vài phút (tạo cluster, chờ
 * load balancer cấp IP). Dùng chung 60 giây thì worker vẫn đang sống sẽ bị coi
 * là chết giữa chừng, và một worker thứ hai nhảy vào tạo tài nguyên trùng — đúng
 * kịch bản tốn tiền thật mà ADR-02 sinh ra để chặn. Gia hạn cùng nhịp `touch()`
 * của pg-boss.
 */
export const JOB_LEASE = {
  durationSeconds: 300,
  renewIntervalMs: 30_000,
} as const;

// ============================================================
// Change feed — ba tầng có tự kiểm (Design v4 ADR-05)
// ============================================================

export const CHANGE_FEED = {
  /** Chu kỳ poll config_version (tầng 1) */
  pollIntervalMs: 500,
  /** Jitter ngẫu nhiên để các replica không đồng pha */
  pollJitterMs: 200,
  /**
   * Định kỳ tính lại sha256 của snapshot và so với Environment.configHash.
   * configVersion là SỐ ĐẾM nên nó không phải checksum: replica áp delta sai nội
   * dung nhưng đúng số vẫn lọt nếu chỉ so version (I15a).
   */
  hashVerifyIntervalMs: 60_000,
  /** Số lần fallback liên tiếp trước khi ngắt mạch tầng 2 */
  circuitBreakerThreshold: 3,
  /** Thời gian tắt tầng 2 sau khi ngắt mạch */
  circuitBreakerCooldownMs: 5 * 60_000,
  /** Giữ ConfigChangeLog bao lâu trước khi dọn */
  retentionDays: 7,
} as const;

// ============================================================
// Xác thực (Design v4 §10.4)
// ============================================================

export const AUTH = {
  /**
   * bcrypt cắt âm thầm mọi thứ sau byte thứ 72. Không chặn ở tầng validate thì
   * hai mật khẩu khác nhau ở ký tự thứ 80 sẽ đăng nhập được cho nhau.
   */
  passwordMinLength: 8,
  passwordMaxLength: 72,
  /** Số byte ngẫu nhiên của CSRF token */
  /**
   * KHÔNG dùng nữa. Token CSRF không còn là chuỗi ngẫu nhiên mà là HMAC của
   * `family_id` (§1.2) — độ dài do SHA-256 quyết định, không phải hằng số này.
   * Giữ lại để lần sau không ai thêm lại một token ngẫu nhiên trần.
   */
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
  /**
   * Giới hạn cho SDK (§2.2). Hai tầng vì hai mối lo khác nhau: `perKey` chặn một
   * khách hàng ngốn hết tài nguyên chung, `perKeyIp` chặn một máy đơn lẻ dùng
   * key hợp lệ để dội. Chỉ có `perKey` thì một IP hỏng làm cả tổ chức bị khoá.
   */
  sdk: {
    perKey: { windowMs: 60_000, max: 100 },
    perKeyIp: { windowMs: 60_000, max: 600 },
    /** Số kết nối SSE đồng thời tối đa cho mỗi IP */
    maxStreamsPerIp: 5,
  },
} as const;

// ============================================================
// SSE (Design v4 §6.3)
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
// SDK key (Design v4 §2.2)
// ============================================================

export const SDK_KEY = {
  serverPrefix: "udp_sk_",
  clientPrefix: "udp_ck_",
  /** Số byte ngẫu nhiên của key */
  randomBytes: 32,
  /**
   * Số ký tự CUỐI lưu lại để hiển thị trong UI.
   *
   * Đuôi chứ không phải đầu: khoá có dạng `udp_sk_{env}_{random}`, nên tám ký
   * tự đầu là `udp_sk_l` cho MỌI khoá server ở live — lưu chúng không phân
   * biệt được khoá nào với khoá nào, tức là hỏng đúng mục đích của cột.
   */
  displaySuffixLength: 6,
  /** Throttle cập nhật last_used_at để không ghi DB mỗi request */
  lastUsedThrottleMs: 60_000,
} as const;

// ============================================================
// Quota tài nguyên mặc định (Design v4 §4.4)
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
  /**
   * [v4 §4.1] Load balancer là nguồn chi phí ẩn lớn thứ hai sau NAT gateway, và
   * nguy hiểm hơn vì nó sinh ra NGOÀI tầm adapter: mỗi Service kiểu LoadBalancer
   * do domain adapter hoặc do chính app của khách tạo đều đẻ một ELB. Trần này
   * được cưỡng chế bằng admission webhook trong cluster, không chỉ ở tầng API.
   */
  maxLoadBalancers: 3,
} as const;

/** TTL mặc định cho project ở môi trường lab (giờ). null = không hết hạn */
export const DEFAULT_PROJECT_TTL_HOURS = 6;

// ============================================================
// Redaction — danh sách khóa bị che trước khi ghi log/audit
// (Design v4 §2.2, §12)
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
  /accesskey/i,
  /clientsecret/i,
  /** Header xác thực và cookie phiên — lọt vào AuditLog qua payload request */
  /authorization/i,
  /cookie/i,
  /**
   * Mọi trường có tên KẾT THÚC bằng "key": sshKey, dekKey, webhookKey,
   * kubeconfigKey, privateKey. Cố tình rộng — với một biện pháp bảo mật thì
   * chặn-mặc-định là hướng đúng: bỏ sót một khoá là rò rỉ, che nhầm một nhãn
   * chỉ là hiển thị xấu. Những cái che nhầm được liệt kê ở REDACT_ALLOWLIST
   * ngay dưới, nơi mỗi ngoại lệ phải được viết ra và đọc lại.
   */
  /.+key$/i,
  /** Mọi thứ bắt đầu bằng "encrypted" là ciphertext: encryptedPayload, encryptedDek */
  /^encrypted/i,
] as const;

/**
 * Khoá KHÔNG BAO GIỜ được che, dù khớp pattern ở trên.
 *
 * Đây là những cái tên kết thúc bằng "key" nhưng mang định danh để HIỂN THỊ và
 * TRUY VẾT chứ không mang bí mật. Che chúng đi không làm hệ thống an toàn hơn,
 * mà làm mất đúng thứ cần để đọc log: `idempotencyKey` là chìa khoá lần ra job
 * trùng của ADR-02, `targetingKey` là thuộc tính hash mặc định của OpenFeature,
 * `variantKey`/`flagKey` là nhãn của mọi thống kê đánh giá flag.
 *
 * Danh sách này là ngoại lệ có kiểm soát, nên nó phải NGẮN và mỗi mục phải giải
 * thích được. Thêm một dòng ở đây là một quyết định bảo mật, không phải dọn dẹp.
 */
export const REDACT_ALLOWLIST = [
  // `key` tran KHONG can o day: /.+key$/i doi it nhat mot ky tu dung truoc, nen
  // no von khong khop. Mot dong allowlist khong mien tru gi la dong gay hieu nham.
  /^idempotency_?key$/i,
  /^variant_?key$/i,
  /^flag_?key$/i,
  /^targeting_?key$/i,
  /^bucket_?key$/i,
  /^stickiness_?key$/i,
] as const;

export const REDACTED_PLACEHOLDER = "[REDACTED]";
