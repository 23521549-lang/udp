import { FailReason, RolloutAction, RolloutStatus } from "@udp/db";
import {
  decisionSchema,
  INTENT_ACTIONS as SHARED_INTENT_ACTIONS,
  metricQueriesSchema,
  rolloutThresholdsSchema,
  type IntentAction,
} from "@udp/shared-types";
import { z } from "zod";

/**
 * Hình dạng dữ liệu của một rollout session ở phía Service 3.
 *
 * Số thập phân của Postgres (`numeric(5,2)`) về tới đây là `number`: cast
 * `::float8` ngay trong SQL của repository (đã đo: `Prisma.Decimal` cộng với số
 * cho ra CHUỖI). JSON (`thresholds`, `metric_queries`, `last_decision`) đi qua
 * zod ở biên, cùng chỗ, để reconciler chỉ làm việc với kiểu chắc chắn.
 *
 * Enum lấy THẲNG từ `@udp/db` (`z.nativeEnum`), không chép tay: bản chép là
 * chỗ lỗi "SQL claim bỏ sót PAUSED" của v3 sinh ra (§7.1). Hình của các cột JSONB
 * mà Service 1 cũng đọc (`last_decision`, `thresholds`, `metric_queries`) ở
 * `@udp/shared-types` [v4.4].
 */

/**
 * Bốn ý định người dùng ghi được (§7.6) — danh sách ở `@udp/shared-types` (S1
 * nhận, S3 đọc); ở đây khẳng định nó là tập con của enum database.
 */
export const INTENT_ACTIONS =
  SHARED_INTENT_ACTIONS satisfies readonly RolloutAction[];
export type { IntentAction };

/** Hàng SQL thô trước khi đi qua zod — cột đã cast ở repository */
export const sessionRowSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  flagEnvConfigId: z.string().uuid().nullable(),
  targetingRuleId: z.string().uuid().nullable(),
  targetVariantId: z.string().uuid().nullable(),
  workloadName: z.string().nullable(),
  rolloutScope: z.enum(["FLAG_LEVEL", "SERVICE_LEVEL"]),
  strategy: z.enum(["CANARY", "ATTRIBUTE_SPLIT", "BLUE_GREEN"]),
  controlMode: z.enum(["UDP_DRIVEN", "TOOL_DRIVEN"]),
  status: z.nativeEnum(RolloutStatus),
  currentTrafficPercentage: z.number(),
  baselinePercentage: z.number().nullable(),
  thresholds: rolloutThresholdsSchema,
  metricQueries: metricQueriesSchema.nullable(),
  stepPercent: z.number(),
  stepIntervalSeconds: z.number().int(),
  analysisIntervalSeconds: z.number().int(),
  metricWindowSeconds: z.number().int(),
  warmUpRequests: z.number().int(),
  maxDurationSeconds: z.number().int(),
  lastStepAt: z.coerce.date().nullable(),
  lastDecision: decisionSchema.nullable(),
  version: z.number().int(),
  claimedBy: z.string().nullable(),
  claimedUntil: z.coerce.date().nullable(),
  failReason: z.nativeEnum(FailReason).nullable(),
  createdAt: z.coerce.date(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

export interface IntentRow {
  id: string;
  action: IntentAction;
  /** [v4.11, Plan #46] Người đã bấm — S3 chuyển nó cho S2 khi thi hành ý định ghi cấu hình flag (I40) */
  actorUserId: string | null;
  createdAt: Date;
}
