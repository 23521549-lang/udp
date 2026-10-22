import { z } from "zod";
import { ENVIRONMENT } from "@udp/config/constants";

/** Trần và luật tên — Portal dựng form theo chính các số server cưỡng chế */
export { ENVIRONMENT };

/**
 * [v4.11, Plan #40] Thân route environment (§9) — S1 kiểm, Portal dựng form theo cùng schema.
 *
 * Tên BẤT BIẾN sau khi tạo: namespace Kubernetes, tiền tố SDK key (`udp_sk_<env>_…`) và tên
 * instance Helm theo environment đều suy từ nó, đổi tên là mồ côi cả ba. `PATCH` vì thế chỉ nhận
 * hai cờ.
 */
export const environmentNameSchema = z
  .string()
  .regex(
    ENVIRONMENT.namePattern,
    `Tên environment: chữ thường, số, gạch ngang; bắt đầu bằng chữ, tối đa ${String(ENVIRONMENT.nameMaxLength)} ký tự`,
  );

export const createEnvironmentBodySchema = z
  .object({
    name: environmentNameSchema,
    isProduction: z.boolean().default(false),
    /** Vắng ⇒ ngược với `isProduction` (§8.3: production không tự deploy từ webhook) */
    autoDeploy: z.boolean().optional(),
  })
  .strict();
export type CreateEnvironmentBody = z.infer<typeof createEnvironmentBodySchema>;

export const updateEnvironmentBodySchema = z
  .object({
    /** Bật mà không nói `autoDeploy` ⇒ `autoDeploy = false` (§8.3) */
    isProduction: z.boolean().optional(),
    autoDeploy: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.isProduction !== undefined || b.autoDeploy !== undefined, {
    message: "Cần ít nhất một trường: isProduction hoặc autoDeploy",
  });
export type UpdateEnvironmentBody = z.infer<typeof updateEnvironmentBodySchema>;

/** Slug `type` của lỗi Portal rẽ nhánh — không thêm mã vào catalog mã lỗi (I36) */
export const ENVIRONMENT_ERROR_SLUGS = {
  /** Project đã đủ `ENVIRONMENT.maxPerProject` environment */
  limit: "environment-limit",
  /** Xoá environment cuối cùng của project */
  last: "environment-last",
  /** Còn rollout sống trên environment */
  rolloutActive: "environment-rollout-active",
  /** Còn flag đang bật ở environment (§9) */
  flagsEnabled: "environment-flags-enabled",
  /** Đã có audit hay deploy trỏ tới — lịch sử append-only không bị xoá theo (§2.2) */
  hasHistory: "environment-has-history",
  /** Project đang dựng, đang xoá, hay đang có job khác chạy trên cluster */
  projectBusy: "environment-project-busy",
} as const;
