import { FailReason, RolloutAction, RolloutStatus } from "@udp/db";
import {
  metricQueriesSchema,
  rolloutThresholdsSchema,
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
 * chỗ lỗi "SQL claim bỏ sót PAUSED" của v3 sinh ra (§7.1).
 */

export const DECISIONS = ["PROMOTE", "HOLD", "ROLLBACK"] as const;
export type DecisionKind = (typeof DECISIONS)[number];

/** Một nhánh đã đo — con số và cờ có dữ liệu; `hasData = false` thì các số là 0 */
const branchSnapshotSchema = z.object({
  requestCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  latencyP99Ms: z.number().optional(),
  hasData: z.boolean(),
});

/**
 * `metric_snapshot` theo đúng hình dạng `latestMetricSnapshot` của §9 — cùng một
 * hình cho `last_decision.metricSnapshot` lẫn `RolloutEvent.metric_snapshot`,
 * để Service 1 trả thẳng cho Portal không phải dịch. `queries` là MẢNG truy vấn
 * thật đã chạy (ba cho canary, hai cho baseline), `at` là epoch ms.
 */
export const metricSnapshotSchema = z.object({
  canary: branchSnapshotSchema,
  /** Không có nhánh đối chứng thì `hasData = false` — con số của canary không nói lên điều gì (§7.4) */
  baseline: branchSnapshotSchema,
  zScore: z.number().nullable(),
  queries: z.object({
    canary: z.array(z.string()),
    baseline: z.array(z.string()),
  }),
  windowSeconds: z.number(),
  at: z.number(),
});
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;

/**
 * `last_decision` (§2.2, §9): tên trường `decision` là hợp đồng với Portal, nên
 * thắng chữ `kind` trong code mẫu cũ của §7.1. `at` là epoch ms của đồng hồ JS —
 * cùng đồng hồ với `analysis_interval` và cửa sổ đo.
 */
export const decisionSchema = z.object({
  decision: z.enum(DECISIONS),
  reason: z.string(),
  at: z.number(),
  breach: z.boolean().default(false),
  breachStreak: z.number().int().min(0).default(0),
  /**
   * Mốc của lần vượt ngưỡng ĐƯỢC ĐẾM gần nhất (epoch ms). Chuỗi "liên tiếp" nối
   * từ mốc này, không từ `at`: nhịp đo (30s) ngắn hơn cửa sổ (60s), nên nếu nối
   * từ `at` thì mọi lần đo đều "chồng lấn" với lần ngay trước và chuỗi không bao
   * giờ tới 2 — auto-rollback không bao giờ nổ (đo được bằng test 12/09/2026).
   */
  breachAt: z.number().nullable().default(null),
  metricSnapshot: metricSnapshotSchema.nullable().default(null),
});
/** Quyết định của một vòng phân tích — chính là thứ ghi vào `last_decision` */
export type Decision = z.infer<typeof decisionSchema>;

/** Bốn ý định người dùng ghi được (§7.6); ba giá trị còn lại của enum là event thực thi */
export const INTENT_ACTIONS = [
  "PAUSE",
  "RESUME",
  "PROMOTE",
  "ROLLBACK",
] as const satisfies readonly RolloutAction[];
export type IntentAction = (typeof INTENT_ACTIONS)[number];

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
  createdAt: Date;
}
