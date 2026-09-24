import { DNS_1123_SUBDOMAIN, ROLLOUT_TIMING } from "@udp/config";
import {
  RolloutScope,
  RolloutStatus,
  RolloutStrategy,
  type RolloutAction,
} from "@udp/db";
import type { ScrapeIntervalSource } from "@udp/metrics-provider";
import {
  INTENT_ACTIONS,
  metricQueriesSchema,
  rolloutThresholdsSchema,
  type Decision,
  type IntentAction,
  type MetricSnapshot,
} from "@udp/shared-types";
import { z } from "zod";

/**
 * Hợp đồng HTTP của Luồng 5 ở Service 1 (§8.5, §9 "Progressive Delivery").
 *
 * Tên trường theo §9 (`envId`), mặc định theo `ROLLOUT_TIMING` — CÙNG hằng mà
 * `@default` của cột đang dùng (test so với `information_schema`), không phải một
 * bản thứ hai.
 */

const uuid = z.string().uuid();
const positiveInt = z.number().int().positive();

/** Tối đa 2 chữ số thập phân — đúng `NUMERIC(5,2)`; không để database làm tròn ngầm */
const percent = z
  .number()
  .min(0.01)
  .max(100)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, {
    message: "tối đa 2 chữ số thập phân",
  });

const flagLevelSchema = z
  .object({
    scope: z.literal("FLAG_LEVEL"),
    envId: uuid,
    /**
     * Chỉ CANARY chạy được ở lát cắt này — S3 chưa có executor cho hai chiến lược
     * kia (§7.2). Nhận cả enum để câu trả lời là "chưa hỗ trợ", không phải "sai kiểu".
     */
    strategy: z.nativeEnum(RolloutStrategy).default(RolloutStrategy.CANARY),
    flagEnvConfigId: uuid,
    targetingRuleId: uuid,
    targetVariantId: uuid,
    /**
     * `service_name` mà mọi truy vấn §7.4 lọc theo — thiếu nó thì phép đo gộp mọi
     * service trong namespace và mất nhân quả. Tên Deployment Kubernetes: DNS-1123
     * subdomain, tối đa 253 (cùng độ dài cột).
     */
    workloadName: z.string().regex(DNS_1123_SUBDOMAIN),
    thresholds: rolloutThresholdsSchema.default({}),
    metricQueries: metricQueriesSchema.optional(),
    stepPercent: percent,
    stepIntervalSeconds: positiveInt.default(
      ROLLOUT_TIMING.stepIntervalSeconds,
    ),
    analysisIntervalSeconds: positiveInt.default(
      ROLLOUT_TIMING.analysisIntervalSeconds,
    ),
    /** Vắng ⇒ `max(mặc định, 4 × scrape interval)` — tính ở service từ probe */
    metricWindowSeconds: positiveInt.optional(),
    warmUpRequests: positiveInt.default(ROLLOUT_TIMING.warmUpRequests),
    maxDurationSeconds: positiveInt.default(ROLLOUT_TIMING.maxDurationSeconds),
  })
  .strict();

/**
 * SERVICE_LEVEL được NHẬN ở biên để service trả 422 "chưa hỗ trợ" kèm lý do,
 * thay vì 400 liệt kê các trường FLAG_LEVEL mà người dùng không định gửi.
 */
const serviceLevelSchema = z
  .object({ scope: z.literal("SERVICE_LEVEL"), envId: uuid })
  .passthrough();

export const createRolloutSchema = z.discriminatedUnion("scope", [
  flagLevelSchema,
  serviceLevelSchema,
]);
export type CreateRolloutInput = z.infer<typeof createRolloutSchema>;
export type CreateFlagRolloutInput = z.infer<typeof flagLevelSchema>;

export type { IntentAction };

export const rolloutActionSchema = z
  .object({ action: z.enum(INTENT_ACTIONS) })
  .strict();
export type RolloutActionInput = z.infer<typeof rolloutActionSchema>;

export const listRolloutsQuerySchema = z
  .object({
    envId: uuid.optional(),
    status: z.nativeEnum(RolloutStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListRolloutsQuery = z.infer<typeof listRolloutsQuerySchema>;

export const rolloutEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Id của event cuối trang trước; keyset thật là `(created_at, id)` — xem repository */
    before: uuid.optional(),
  })
  .strict();
export type RolloutEventsQuery = z.infer<typeof rolloutEventsQuerySchema>;

export const probeRolloutSchema = z
  .object({
    envId: uuid,
    workloadName: z.string().regex(DNS_1123_SUBDOMAIN),
    metricQueries: metricQueriesSchema.optional(),
  })
  .strict();
export type ProbeRolloutInput = z.infer<typeof probeRolloutSchema>;

// ------------------------------------------------------------- response (§9)

export interface RolloutEventView {
  id: string;
  action: RolloutAction;
  isIntent: boolean;
  processedAt: string | null;
  trafficPercentage: number;
  reason: string | null;
  triggeredBy: string;
  actorUserId: string | null;
  causedByEventId: string | null;
  metricSnapshot: MetricSnapshotView | null;
  createdAt: string;
}

/** `metric_snapshot` với `at` đã đổi epoch ms → ISO (§9 "Service 1 chuyển") */
export type MetricSnapshotView = Omit<MetricSnapshot, "at"> & { at: string };

export interface LastDecisionView {
  decision: Decision["decision"];
  reason: string;
  breach: boolean;
  breachStreak: number;
  breachAt: string | null;
  at: string;
}

/** Hàng danh sách — đủ để vẽ bảng, không kèm lịch sử */
export interface RolloutSummary {
  id: string;
  environmentId: string;
  scope: RolloutScope;
  strategy: RolloutStrategy;
  status: RolloutStatus;
  currentTrafficPercentage: number;
  baselinePercentage: number | null;
  flagKey: string | null;
  workloadName: string | null;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §9 `RolloutDetailResponse` */
export interface RolloutDetail {
  id: string;
  projectId: string;
  environment: { id: string; name: string; isProduction: boolean };
  scope: RolloutScope;
  controlMode: "udp-driven" | "tool-driven";
  strategy: RolloutStrategy;
  status: RolloutStatus;
  currentTrafficPercentage: number;
  baselinePercentage: number | null;
  flag?: {
    id: string;
    key: string;
    targetVariant: string;
    targetingRuleId: string;
  };
  workloadName: string | null;
  versionNew?: string;
  versionOld?: string;
  /** [v4.11] Object JSONB — `sendJson` kiểm nó là object trước khi lên dây */
  thresholds: Record<string, unknown>;
  stepPercent: number;
  stepIntervalSeconds: number;
  analysisIntervalSeconds: number;
  warmUpRequests: number;
  metricWindowSeconds: number;
  maxDurationSeconds: number;
  failReason?: string;
  lastDecision?: LastDecisionView;
  latestMetricSnapshot?: MetricSnapshotView;
  pendingIntent?: {
    id: string;
    action: RolloutAction;
    at: string;
    byUser: string;
  };
  events: RolloutEventView[];
  createdAt: string;
  updatedAt: string;
}

export interface ProbeResult {
  /** Luôn `true`: không tới được là 503, không phải 200 `reachable: false` */
  reachable: true;
  hasSeries: boolean;
  scrapeIntervalSec: number;
  scrapeIntervalSource: ScrapeIntervalSource;
  /** 4 × scrape interval — cửa sổ nhỏ nhất validator nhận (§7.4) */
  minMetricWindowSeconds: number;
}
