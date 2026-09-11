import { z } from "zod";
import { MAX_RULES_PER_ENV_CONFIG } from "@udp/config";
import {
  conditionIssue,
  distributionWeightsDbSchema,
  flagServeDbSchema,
  RULE_TYPES,
} from "@udp/shared-types";
import { INT4_MAX, INT4_MIN } from "../../core/int4.js";

/**
 * Hợp đồng của `PUT /internal/flag-envs/:id/rules` (§9, §8.4).
 *
 * PUT theo nghĩa "đây là TOÀN BỘ danh sách rule của env-config này" — nhưng
 * KHÔNG theo nghĩa "xoá hết rồi chèn lại". §8.4 nói đúng chữ: "Sinh
 * `bucket_salt` cho rule MỚI / Rule cũ GIỮ NGUYÊN `bucket_salt` → đổi trọng số
 * không xáo lại nhóm người dùng (I1)". Nên mỗi rule mang theo danh tính của nó:
 * có `id` là rule đang có, không có `id` là rule mới.
 */

const ruleInput = z
  .object({
    /** Có ⇒ rule ĐANG CÓ: cập nhật tại chỗ, giữ `bucket_salt`. Không có ⇒ rule mới */
    id: z.string().uuid().optional(),
    ruleType: z.enum(RULE_TYPES),
    /** Kiểm theo `ruleType` ở `superRefine` bên dưới — hình dạng phụ thuộc loại */
    condition: z.unknown(),
    /** Tổng weight và tính duy nhất do schema DB kiểm; thứ tự do service ép */
    serve: flagServeDbSchema,
    /**
     * Cột là INTEGER (int4). Không chặn ở đây thì một số ngoài khoảng đi thẳng
     * xuống Postgres, ném `22003`, và thành 500 thay vì 400.
     */
    priority: z.number().int().min(INT4_MIN).max(INT4_MAX),
    description: z.string().trim().max(255).nullable().optional(),
  })
  /**
   * `.strict()` chặn đúng một thứ quan trọng: `bucketSalt`. Nhận nó từ client là
   * cho người gọi quyền xáo lại nhóm người dùng bằng một lời PUT — thứ I1 cấm.
   * Salt chỉ được sinh ở server, đúng một lần, lúc tạo rule.
   */
  .strict();

export const replaceRulesSchema = z
  .object({
    /**
     * Optimistic lock theo `FlagEnvConfig.updated_at` (§2.2 "optimistic lock ở
     * mức env" — sửa rule ở dev không chặn người sửa prod).
     */
    lastKnownUpdatedAt: z.string().datetime({ offset: true }),
    rules: z.array(ruleInput).max(MAX_RULES_PER_ENV_CONFIG),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const [i, rule] of data.rules.entries()) {
      const issue = conditionIssue(rule.ruleType, rule.condition);
      if (issue !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "condition"],
          message: issue,
        });
      }
    }

    const ids = data.rules.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "Một rule xuất hiện hai lần trong danh sách",
      });
    }
  });

export type ReplaceRulesInput = z.infer<typeof replaceRulesSchema>;
export type RuleInput = ReplaceRulesInput["rules"][number];

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
