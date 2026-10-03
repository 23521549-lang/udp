import { z } from "zod";
import { CAPABILITY_IDS, type CapabilityId } from "./capability.js";

/**
 * [v4.11] Hợp đồng ghi cấu hình domain của project (Plan #27, §8.1, §9) — một nguồn cho
 * Portal và Service 1. Body là TOÀN BỘ trạng thái đích: validator kiểm trạng thái ĐÍCH,
 * không phần thay đổi (§8.2), và khoá `domain_set_version` chỉ bảo vệ khi mỗi lần ghi mang
 * cả tập.
 */

const domainTypeSchema = z
  .string()
  .regex(/^[A-Z][A-Z_]{1,49}$/, "domain không hợp lệ");
const toolIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "tool không hợp lệ");

export const domainTargetSchema = z
  .object({
    domainType: domainTypeSchema,
    toolId: toolIdSchema,
    /** Parse lại bằng `configSchema` CỦA TOOL ở máy chủ — ở đây chỉ là object */
    config: z.record(z.unknown()),
  })
  .strict();

export const capabilityPreferenceSchema = z
  .object({
    capabilityId: z.custom<CapabilityId>(
      (v) => CAPABILITY_IDS.some((id) => id === v),
      "capability không hợp lệ",
    ),
    /** `<domaintype>:<toolid>` chữ thường, như `providedBy` của binding */
    providerToolId: z
      .string()
      .regex(/^[a-z_]+:[a-z0-9-]+$/, "provider không hợp lệ"),
  })
  .strict();

const targetShape = {
  /** CHỈ domain được bật; domain vắng mặt là tắt */
  domains: z
    .array(domainTargetSchema)
    .max(16)
    .refine(
      (ds) => new Set(ds.map((d) => d.domainType)).size === ds.length,
      "mỗi domain chỉ xuất hiện một lần",
    ),
  preferences: z
    .array(capabilityPreferenceSchema)
    // Một lựa chọn mỗi capability — trần suy từ danh sách, không ghi tay (từng là 14)
    .max(CAPABILITY_IDS.length)
    .refine(
      (ps) => new Set(ps.map((p) => p.capabilityId)).size === ps.length,
      "mỗi capability chỉ một lựa chọn",
    ),
};

/** Body của `POST /projects/:id/domains/validate` — kiểm, không lưu */
export const domainTargetStateSchema = z.object(targetShape).strict();
export type DomainTargetState = z.infer<typeof domainTargetStateSchema>;

export const putDomainsBodySchema = z
  .object({
    ...targetShape,
    lastKnownDomainSetVersion: z.number().int().nonnegative(),
  })
  .strict();
export type PutDomainsBody = z.infer<typeof putDomainsBodySchema>;

/**
 * Giá trị giữ chỗ của một trường bí mật trên dây (Plan #31 QĐ-1): máy chủ trả nó thay cho
 * bí mật đã lưu, Portal gửi lại đúng nó ⇒ giữ nguyên bí mật cũ.
 */
export const KEPT_SECRET = { $udpSecret: "kept" } as const;

export const isKeptSecret = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (v as Record<string, unknown>).$udpSecret === "kept" &&
  Object.keys(v).length === 1;

/**
 * Body của `POST /projects/:id/domains/:type/upgrade` (§8.6). Nâng cấp chạm cluster dùng
 * chung cho MỌI environment, nên project có production phải gõ lại tên domain (428 nếu
 * thiếu hay sai) — cùng cơ chế xác nhận hai bước của §8.4.
 */
export const domainUpgradeBodySchema = z
  .object({
    confirm: z.string().max(50).optional(),
    /**
     * [v4.11, Plan #45] Bản người dùng đã thấy ở `GET …/versions` — khác bản máy chủ đang nạp
     * (máy chủ vừa đổi sau khi họ mở hộp) ⇒ 409 `domain-version-unavailable`.
     */
    toVersion: z.string().min(1).max(50).optional(),
  })
  .strict();
export type DomainUpgradeBody = z.infer<typeof domainUpgradeBodySchema>;

/**
 * [v4.11, Plan #45] Body của `POST /projects/:id/domains/:type/retry` — áp lại domain về cấu
 * hình đang lưu. Cùng xác nhận của nâng cấp: chạm cluster dùng chung mọi environment.
 */
export const domainRetryBodySchema = z
  .object({ confirm: z.string().max(50).optional() })
  .strict();
export type DomainRetryBody = z.infer<typeof domainRetryBodySchema>;

/** Slug `type` của lỗi Portal rẽ nhánh — không thêm mã vào catalog mã lỗi (I36) */
export const DOMAIN_ERROR_SLUGS = {
  /** Project đang có lượt triển khai chạy: lưu cấu hình domain sau khi lượt đó xong */
  needsApplyJob: "domains-need-apply-job",
  /** Domain hay tool không có trong registry, hoặc domain đã bị gỡ khỏi catalog */
  unknownTool: "domain-tool-unknown",
  /** Nâng cấp: domain đã ở đúng bản adapter mà máy chủ đang nạp */
  upToDate: "domain-up-to-date",
  /** Nâng cấp / quét ngay: domain không chạy trên cluster của project */
  notRunning: "domain-not-running",
  /** [v4.11, Plan #45] Áp lại: domain đang có việc chạy trên nó, hoặc chưa từng triển khai */
  notRetryable: "domain-not-retryable",
  /** [v4.11, Plan #45] Nâng cấp: `toVersion` không phải bản máy chủ đang nạp */
  versionUnavailable: "domain-version-unavailable",
  /** [v4.11, Plan #38] Chi phí: project chưa bật Cost Management (không có `cost.query`) */
  costNotEnabled: "cost-not-enabled",
  /**
   * [v4.11, Plan #53 QĐ-4] Giám sát: project chưa có nguồn `metrics.query` (chưa bật domain
   * Monitoring). KHÔNG lặng lẽ đọc Prometheus của nền tảng — nó không thấy cluster của khách, và
   * một biểu đồ rỗng nói sai rằng "không có lưu lượng".
   */
  metricsNotEnabled: "metrics-not-enabled",
} as const;

/** `GET /projects/:id/cost?days=` — cửa sổ 1–30 ngày (Plan #38 QĐ-8) */
export const costQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(30).default(7) })
  .strict();
export type CostQuery = z.infer<typeof costQuerySchema>;

/** [v4.11, Plan #53] `GET /projects/:id/metrics/red?envId&range` */
export const redQuerySchema = z
  .object({
    envId: z.string().uuid(),
    range: z.enum(["1h", "6h", "24h", "7d"]).default("6h"),
  })
  .strict();
export type RedQuery = z.infer<typeof redQuerySchema>;
