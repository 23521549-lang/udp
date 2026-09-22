import { z } from "zod";
import {
  distributionWeightsDbSchema,
  flagServeDbSchema,
  replaceRulesFields,
  replaceRulesRefine,
  ruleInputSchema,
} from "@udp/shared-types";

/**
 * Hợp đồng của `PUT /internal/flag-envs/:id/rules` (§9, §8.4) — hình dùng chung ở
 * `@udp/shared-types/flag-api` [v4.5] (Service 1 kiểm cùng hình ở biên ngoài).
 */
export const replaceRulesSchema = replaceRulesFields
  .strict()
  .superRefine(replaceRulesRefine);

export type ReplaceRulesInput = z.infer<typeof replaceRulesSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface PublicRule {
  id: string;
  ruleType: string;
  condition: unknown;
  serve: unknown;
  priority: number;
  description: string | null;
  bucketSalt: string;
}

/**
 * Trần của `reason` — cùng trần với `RolloutEvent.reason` (VARCHAR(255)), cột
 * Service 3 ghi lý do của chính nó. Không có trần thì một body lỗi làm phình log.
 */
const MAX_RAMP_REASON_LENGTH = 255;

/**
 * Body của `PATCH /internal/rules/:ruleId` — đúng hình dạng §7.3:
 * `{ weights: [{ variantId, weight }], reason }`.
 *
 * Chỉ có `weights`, không có `serve` đầy đủ: Service 3 chỉ đổi phần trăm (§2.2),
 * nên `kind` luôn là `distribution` và bên gọi không có cách nói khác đi.
 * `.strict()` chặn mọi trường khác — `condition`, `priority`, `bucketSalt` — vì
 * I30(b) bắt database từ chối S3 sửa bất cứ thứ gì ngoài `serve`, và endpoint
 * không được rộng hơn cái GRANT.
 */
export const rampRuleSchema = z
  .object({
    weights: distributionWeightsDbSchema,
    /** Ghi log để đối chiếu, không lưu — xem `rampRule` */
    reason: z.string().trim().min(1).max(MAX_RAMP_REASON_LENGTH),
  })
  .strict()
  .superRefine((data, ctx) => {
    /**
     * Tổng = 100 000 và mỗi variant một lần: chạy lại ĐÚNG schema của cột thay
     * vì viết bản thứ hai. Đường dẫn lỗi của nó (`weights`, `weights.N.variantId`)
     * cũng trùng luôn với body này.
     */
    const check = flagServeDbSchema.safeParse({
      kind: "distribution",
      weights: data.weights,
    });
    if (check.success) return;
    for (const issue of check.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  });

export type RampRuleInput = z.infer<typeof rampRuleSchema>;
