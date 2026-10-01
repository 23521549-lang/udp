import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config";
import { logger } from "@udp/http";
import {
  decisionDetailSchema,
  decisionSchema,
  metricSnapshotSchema,
  trafficMatchSchema,
  type DecisionDetail,
  type MetricSnapshot,
} from "@udp/shared-types";
import type { DetailRows, EventRow, SummaryRow } from "./rollout.repository.js";
import type {
  LastDecisionView,
  MetricSnapshotView,
  RolloutDetail,
  RolloutEventView,
  RolloutSummary,
} from "./rollout.types.js";

/**
 * Hàng database → hình dạng §9 (`RolloutDetailResponse`).
 *
 * Service 3 lưu thời điểm trong JSONB là epoch ms (cùng đồng hồ với nhịp phân
 * tích); Portal nhận ISO — đổi Ở ĐÂY, một chỗ (§9 "Service 1 chuyển"). JSONB
 * đi qua CÙNG schema S3 dùng để ghi (`@udp/shared-types`); hàng không khớp thì
 * bỏ trường đó và log, không làm hỏng cả trang chi tiết vì một ô sai hình.
 */

const iso = (epochMs: number): string => new Date(epochMs).toISOString();
const num = (value: { toNumber(): number } | number): number =>
  typeof value === "number" ? value : value.toNumber();

function snapshotView(snapshot: MetricSnapshot): MetricSnapshotView {
  return { ...snapshot, at: iso(snapshot.at) };
}

function parseSnapshot(
  raw: unknown,
  where: { sessionId: string; eventId?: string },
): MetricSnapshotView | null {
  if (raw === null || raw === undefined) return null;
  const parsed = metricSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(where, "metric_snapshot sai hình — bỏ qua khi trả Portal");
    return null;
  }
  return snapshotView(parsed.data);
}

/** `reason_detail` qua CÙNG schema S3 dùng để ghi; sai hình thì bỏ (Portal hiện `reason` chữ) và log */
function parseDetail(
  raw: unknown,
  where: { sessionId: string; eventId: string },
): DecisionDetail | null {
  if (raw === null || raw === undefined) return null;
  const parsed = decisionDetailSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(where, "reason_detail sai hình — bỏ qua khi trả Portal");
    return null;
  }
  return parsed.data;
}

export function eventView(row: EventRow, sessionId: string): RolloutEventView {
  return {
    id: row.id,
    action: row.action,
    isIntent: row.isIntent,
    processedAt: row.processedAt?.toISOString() ?? null,
    trafficPercentage: num(row.trafficPercentage),
    reason: row.reason,
    reasonDetail: parseDetail(row.reasonDetail, { sessionId, eventId: row.id }),
    triggeredBy: row.triggeredBy,
    actorUserId: row.actorUserId,
    causedByEventId: row.causedByEventId,
    metricSnapshot: parseSnapshot(row.metricSnapshot, {
      sessionId,
      eventId: row.id,
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

export function summaryView(row: SummaryRow): RolloutSummary {
  return {
    id: row.id,
    environmentId: row.environmentId,
    scope: row.rolloutScope,
    strategy: row.strategy,
    status: row.status,
    currentTrafficPercentage: num(row.currentTrafficPercentage),
    baselinePercentage:
      row.baselinePercentage === null ? null : num(row.baselinePercentage),
    flagKey: row.flagEnvConfig?.flag.key ?? null,
    workloadName: row.workloadName,
    failReason: row.failReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function detailView({
  session,
  events,
  pendingIntent,
}: DetailRows): RolloutDetail {
  const decision =
    session.lastDecision === null
      ? undefined
      : decisionSchema.safeParse(session.lastDecision);
  if (decision !== undefined && !decision.success) {
    logger.warn(
      { sessionId: session.id },
      "last_decision sai hình — bỏ qua khi trả Portal",
    );
  }
  const lastDecision: LastDecisionView | undefined = decision?.success
    ? {
        decision: decision.data.decision,
        reason: decision.data.reason,
        breach: decision.data.breach,
        breachStreak: decision.data.breachStreak,
        breachAt:
          decision.data.breachAt === null ? null : iso(decision.data.breachAt),
        at: iso(decision.data.at),
        detail: decision.data.detail,
      }
    : undefined;
  const latest =
    decision?.success === true && decision.data.metricSnapshot !== null
      ? snapshotView(decision.data.metricSnapshot)
      : undefined;
  const flag = session.flagEnvConfig?.flag;
  const match =
    session.trafficMatch === null
      ? undefined
      : trafficMatchSchema.safeParse(session.trafficMatch);

  return {
    id: session.id,
    projectId: session.projectId,
    environment: session.environment,
    scope: session.rolloutScope,
    controlMode:
      session.controlMode === "UDP_DRIVEN" ? "udp-driven" : "tool-driven",
    strategy: session.strategy,
    status: session.status,
    currentTrafficPercentage: num(session.currentTrafficPercentage),
    baselinePercentage:
      session.baselinePercentage === null
        ? null
        : num(session.baselinePercentage),
    ...(flag === undefined ||
    session.targetingRuleId === null ||
    session.targetVariant === null
      ? {}
      : {
          flag: {
            id: flag.id,
            key: flag.key,
            targetVariant: session.targetVariant.key,
            targetingRuleId: session.targetingRuleId,
          },
        }),
    workloadName: session.workloadName,
    ...(session.versionNew === null ? {} : { versionNew: session.versionNew }),
    ...(session.versionOld === null ? {} : { versionOld: session.versionOld }),
    ...(match?.success === true ? { trafficMatch: match.data } : {}),
    thresholds: session.thresholds as Record<string, unknown>,
    stepPercent: num(session.stepPercent),
    stepIntervalSeconds: session.stepIntervalSeconds,
    analysisIntervalSeconds: session.analysisIntervalSeconds,
    warmUpRequests: session.warmUpRequests,
    metricWindowSeconds: session.metricWindowSeconds,
    maxDurationSeconds: session.maxDurationSeconds,
    ...(session.failReason === null ? {} : { failReason: session.failReason }),
    ...(lastDecision === undefined ? {} : { lastDecision }),
    ...(latest === undefined ? {} : { latestMetricSnapshot: latest }),
    // Intent treo trên session đã kết thúc không bao giờ được xử lý — không hiện "đang chờ"
    ...(pendingIntent === undefined ||
    !ACTIVE_ROLLOUT_STATUSES.some((s) => s === session.status)
      ? {}
      : {
          pendingIntent: {
            id: pendingIntent.id,
            action: pendingIntent.action,
            at: pendingIntent.createdAt.toISOString(),
            byUser: pendingIntent.actorEmail ?? "",
          },
        }),
    events: events.map((e) => eventView(e, session.id)),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
