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
    .max(14)
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
 * Body của `POST /projects/:id/domains/:type/upgrade` (§8.6). Nâng cấp chạm cluster dùng
 * chung cho MỌI environment, nên project có production phải gõ lại tên domain (428 nếu
 * thiếu hay sai) — cùng cơ chế xác nhận hai bước của §8.4.
 */
export const domainUpgradeBodySchema = z
  .object({ confirm: z.string().max(50).optional() })
  .strict();
export type DomainUpgradeBody = z.infer<typeof domainUpgradeBodySchema>;

/** Slug `type` của lỗi Portal rẽ nhánh — không thêm mã vào catalog 24 mã (I36) */
export const DOMAIN_ERROR_SLUGS = {
  /** Project đang có lượt triển khai chạy: lưu cấu hình domain sau khi lượt đó xong */
  needsApplyJob: "domains-need-apply-job",
  /** Domain hay tool không có trong registry, hoặc domain đã bị gỡ khỏi catalog */
  unknownTool: "domain-tool-unknown",
  /** Nâng cấp: domain đã ở đúng bản adapter mà máy chủ đang nạp */
  upToDate: "domain-up-to-date",
  /** Nâng cấp / quét ngay: domain không chạy trên cluster của project */
  notRunning: "domain-not-running",
} as const;
