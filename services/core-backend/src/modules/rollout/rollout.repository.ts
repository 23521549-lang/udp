import { randomUUID } from "node:crypto";
import {
  ACTIVE_ROLLOUT_STATUS_SQL,
  Prisma,
  uniqueViolationIndexOf,
  type FlagLifecycleStatus,
  type RolloutAction,
  type RolloutStatus,
} from "@udp/db";
import { ROLLOUT_CREATE } from "@udp/config";
import {
  formatRolloutIntentNotice,
  ROLLOUT_INTENT_CHANNEL,
} from "@udp/shared-types";
import type { Request } from "express";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type {
  CreateFlagRolloutInput,
  IntentAction,
  ListRolloutsQuery,
  RolloutEventsQuery,
} from "./rollout.types.js";

/**
 * Đọc/ghi `rollout_sessions` và `rollout_events` từ phía Service 1 (§1.2): S1
 * TẠO hàng session và ghi INTENT; mọi chuyển trạng thái sau đó là của Service 3.
 */

// --------------------------------------------------------------- mục tiêu

interface FlagTargetRow {
  environmentId: string;
  namespace: string;
  flagKey: string;
  lifecycleStatus: FlagLifecycleStatus;
  isEnabled: boolean;
  serve: unknown;
}

/**
 * Environment, env-config, flag, rule, variant của một yêu cầu tạo rollout —
 * trong MỘT câu, và chỉ khi cả năm thuộc về nhau VÀ về project này. Thiếu một
 * mắt xích nào thì `undefined`: không phân biệt ra ngoài "rule có nhưng không
 * thuộc env của bạn" với "không có" (cùng lý do 404 của `requireMinProjectRole`).
 */
export async function flagTargetOf(
  projectId: string,
  input: Pick<
    CreateFlagRolloutInput,
    "envId" | "flagEnvConfigId" | "targetingRuleId" | "targetVariantId"
  >,
): Promise<FlagTargetRow | undefined> {
  const rows = await prisma.$queryRaw<FlagTargetRow[]>`
    SELECT e.id::text          AS "environmentId",
           e.k8s_namespace     AS "namespace",
           f.key               AS "flagKey",
           f.lifecycle_status  AS "lifecycleStatus",
           c.is_enabled        AS "isEnabled",
           r.serve             AS "serve"
      FROM environments e
      JOIN flag_env_configs c     ON c.environment_id = e.id
      JOIN feature_flags f        ON f.id = c.flag_id
      JOIN flag_targeting_rules r ON r.flag_env_config_id = c.id
      JOIN flag_variants v        ON v.flag_id = f.id
     WHERE e.id = ${input.envId}::uuid
       AND e.project_id = ${projectId}::uuid
       AND c.id = ${input.flagEnvConfigId}::uuid
       AND r.id = ${input.targetingRuleId}::uuid
       AND v.id = ${input.targetVariantId}::uuid`;
  return rows[0];
}

/** Namespace Kubernetes của environment — nhãn `namespace` mà probe lọc theo */
export async function namespaceOf(
  projectId: string,
  envId: string,
): Promise<string | undefined> {
  const env = await prisma.environment.findFirst({
    where: { id: envId, projectId },
    select: { k8sNamespace: true },
  });
  return env?.k8sNamespace;
}

// --------------------------------------------------------------- tạo & bù trừ

export interface NewSession {
  id: string;
  /** `claimed_by` của lease khai sinh — chỉ bên tạo biết, để bù trừ đúng hàng của mình */
  birthToken: string;
}

interface InsertSessionInput {
  projectId: string;
  environmentId: string;
  target: CreateFlagRolloutInput;
  baselinePercentage: number;
  metricWindowSeconds: number;
  actorUserId: string;
  request: Request;
}

/** Hai index "một rollout sống" — vi phạm cái nào cũng là "đang có rollout", không phải trùng bản ghi */
const ACTIVE_ROLLOUT_INDEXES: ReadonlySet<string> = new Set([
  "idx_one_active_rollout_per_target",
  "idx_one_active_rollout_per_flag",
]);

export class ActiveRolloutExists extends Error {
  constructor(readonly activeRolloutId: string | undefined) {
    super("target đã có rollout đang chạy");
  }
}

/**
 * INSERT session PENDING kèm audit, trong một batch.
 *
 * Hai giá trị KHỞI TẠO mà S1 đặt trên cột của S3 (§1.2 [v4.4]) — đặt lúc INSERT,
 * không bao giờ UPDATE sau đó:
 *   - `current_traffic_percentage = baseline`: traffic thật đang ở baseline, và
 *     mọi đường đọc cột này (Portal, `revert`, `warnDrift`) phải thấy đúng số đó
 *     thay vì 0.
 *   - LEASE KHAI SINH (`claimed_by`/`claimed_until`): Service 3 không claim được
 *     session trong cửa sổ `track`, nên nếu `track` thất bại thì S1 xoá chắc chắn
 *     một hàng S3 chưa chạm. Đồng hồ là của Node, không phải database: lệch đồng
 *     hồ vài giây ăn vào biên `birthLeaseSeconds − trackTimeoutMs` (15 giây), không
 *     làm sai tính đúng — hết biên thì bù trừ xoá 0 hàng và rơi sang huỷ bằng
 *     intent ROLLBACK (`compensate` ở service).
 */
export async function insertSession(
  input: InsertSessionInput,
): Promise<NewSession> {
  const id = randomUUID();
  const birthToken = `s1-create:${randomUUID()}`;
  const { target } = input;
  try {
    await prisma.$transaction([
      prisma.rolloutSession.create({
        data: {
          id,
          projectId: input.projectId,
          environmentId: input.environmentId,
          flagEnvConfigId: target.flagEnvConfigId,
          targetingRuleId: target.targetingRuleId,
          targetVariantId: target.targetVariantId,
          workloadName: target.workloadName,
          rolloutScope: "FLAG_LEVEL",
          strategy: target.strategy,
          controlMode: "UDP_DRIVEN",
          currentTrafficPercentage: input.baselinePercentage,
          baselinePercentage: input.baselinePercentage,
          thresholds: target.thresholds,
          ...(target.metricQueries === undefined
            ? {}
            : { metricQueries: target.metricQueries }),
          stepPercent: target.stepPercent,
          stepIntervalSeconds: target.stepIntervalSeconds,
          analysisIntervalSeconds: target.analysisIntervalSeconds,
          metricWindowSeconds: input.metricWindowSeconds,
          warmUpRequests: target.warmUpRequests,
          maxDurationSeconds: target.maxDurationSeconds,
          claimedBy: birthToken,
          claimedUntil: new Date(
            Date.now() + ROLLOUT_CREATE.birthLeaseSeconds * 1000,
          ),
          createdById: input.actorUserId,
        },
        select: { id: true },
      }),
      prisma.auditLog.create({
        data: {
          projectId: input.projectId,
          ...auditEntry({
            action: "rollout.create",
            targetType: "rollout_session",
            targetId: id,
            environmentId: input.environmentId,
            after: {
              scope: "FLAG_LEVEL",
              flagEnvConfigId: target.flagEnvConfigId,
              targetingRuleId: target.targetingRuleId,
              targetVariantId: target.targetVariantId,
              workloadName: target.workloadName,
              baselinePercentage: input.baselinePercentage,
              stepPercent: target.stepPercent,
            },
            request: input.request,
          }),
        },
        select: { id: true },
      }),
    ]);
  } catch (err: unknown) {
    const index = uniqueViolationIndexOf(err);
    if (index !== undefined && ACTIVE_ROLLOUT_INDEXES.has(index)) {
      throw new ActiveRolloutExists(await activeRolloutOn(target));
    }
    throw err;
  }
  return { id, birthToken };
}

/**
 * Rollout đang giữ chỗ trên cùng env-config. Khoá của CẢ HAI index đều chứa
 * `flag_env_config_id` với FLAG_LEVEL, nên một điều kiện là đủ.
 */
async function activeRolloutOn(
  target: CreateFlagRolloutInput,
): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM rollout_sessions
     WHERE status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
       AND flag_env_config_id = ${target.flagEnvConfigId}::uuid
     ORDER BY created_at
     LIMIT 1`;
  return rows[0]?.id;
}

/**
 * Bù trừ khi `track` thất bại: xoá ĐÚNG hàng vừa tạo, chỉ khi lease khai sinh vẫn
 * là của mình và S3 chưa chạm (`version = 0`). `true` = đã xoá (kèm audit).
 * Transaction tương tác vì audit chỉ ghi khi xoá được — cùng lý do `insertIntent`.
 */
export async function deleteUnclaimed(
  session: NewSession,
  projectId: string,
  reason: string,
  request: Request,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.rolloutSession.deleteMany({
      where: { id: session.id, claimedBy: session.birthToken, version: 0 },
    });
    if (count !== 1) return false;
    await tx.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "rollout.create.compensated",
          targetType: "rollout_session",
          targetId: session.id,
          after: { reason },
          request,
        }),
      },
      select: { id: true },
    });
    return true;
  });
}

// --------------------------------------------------------------- intent

interface InsertIntentInput {
  projectId: string;
  sessionId: string;
  action: IntentAction;
  actorUserId: string;
  request: Request;
  /** Ghi vào `reason` của hàng intent — hôm nay chỉ nhánh huỷ-khi-bù-trừ dùng */
  reason?: string;
}

/**
 * Ghi intent (§7.6) + audit + `NOTIFY rollout_intent` trong MỘT transaction.
 *
 * INSERT có điều kiện, không phải đọc-rồi-ghi: session phải thuộc project, còn
 * sống, (PENDING thì chỉ nhận ROLLBACK — nghĩa "huỷ", §7.6 dòng PENDING), và chưa
 * có intent nào chờ. Kiểm ngoài câu lệnh thì S3 đóng session giữa hai bước để lại
 * một intent mà không ai xử lý, "đang chờ" mãi trên Portal (QA Plan #18).
 *
 * "Chưa có intent nào chờ" đúng cả khi hai request tới cùng lúc: khoá advisory
 * theo session ĐẦU transaction tuần tự hoá chúng — không có nó, ở READ COMMITTED
 * cả hai cùng thấy `NOT EXISTS` đúng và cùng ghi (QA Plan #18).
 *
 * Transaction TƯƠNG TÁC chứ không mảng như `member.service.ts`, có chủ đích:
 * audit và NOTIFY chỉ được chạy khi INSERT có điều kiện ghi được đúng một hàng —
 * một mảng không rẽ nhánh theo kết quả của phần tử trước, nên sẽ ghi audit và
 * đánh thức S3 cho một intent không tồn tại.
 *
 * `pg_notify` qua `$executeRaw` chứ không `$queryRaw`: nó trả `void`, Prisma
 * không đọc được (P2010, đo ở `packages/db/src/outbox.ts`). NOTIFY chỉ được giao
 * lúc COMMIT; transaction lùi thì không ai bị đánh thức. `undefined` = điều kiện
 * không thoả — bên gọi đọc lại để nói đúng lý do.
 */
export async function insertIntent(
  input: InsertIntentInput,
): Promise<string | undefined> {
  const id = randomUUID();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.sessionId}, 0))`;
    const inserted = await tx.$executeRaw`
      INSERT INTO rollout_events
             (id, session_id, action, is_intent, traffic_percentage,
              reason, triggered_by, actor_user_id)
      SELECT ${id}::uuid, s.id, ${input.action}::"RolloutAction", true,
             CASE ${input.action}
               WHEN 'PROMOTE'  THEN 100
               WHEN 'ROLLBACK' THEN COALESCE(s.baseline_percentage, s.current_traffic_percentage)
               ELSE s.current_traffic_percentage
             END,
             ${input.reason ?? null}, 'MANUAL'::"TriggeredBy", ${input.actorUserId}::uuid
        FROM rollout_sessions s
       WHERE s.id = ${input.sessionId}::uuid
         AND s.project_id = ${input.projectId}::uuid
         AND s.status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
         AND (s.status <> 'PENDING' OR ${input.action} = 'ROLLBACK')
         AND NOT EXISTS (
               SELECT 1 FROM rollout_events i
                WHERE i.session_id = s.id
                  AND i.is_intent
                  AND i.processed_at IS NULL)`;
    if (inserted !== 1) return undefined;
    await tx.auditLog.create({
      data: {
        projectId: input.projectId,
        ...auditEntry({
          action: "rollout.intent",
          targetType: "rollout_session",
          targetId: input.sessionId,
          after: { action: input.action, intentId: id },
          actorUserId: input.actorUserId,
          request: input.request,
        }),
      },
      select: { id: true },
    });
    await tx.$executeRaw`SELECT pg_notify(${ROLLOUT_INTENT_CHANNEL}, ${formatRolloutIntentNotice({ sessionId: input.sessionId })})`;
    return id;
  });
}

/** Trạng thái đủ để nói vì sao intent không ghi được */
export async function intentBlockerOf(
  projectId: string,
  sessionId: string,
): Promise<{ status: RolloutStatus; hasPendingIntent: boolean } | undefined> {
  const session = await prisma.rolloutSession.findFirst({
    where: { id: sessionId, projectId },
    select: {
      status: true,
      events: {
        where: { isIntent: true, processedAt: null },
        select: { id: true },
        take: 1,
      },
    },
  });
  return session === null
    ? undefined
    : { status: session.status, hasPendingIntent: session.events.length > 0 };
}

// --------------------------------------------------------------- đọc

const DETAIL_EVENTS = 50;

const sessionDetailSelect = {
  id: true,
  projectId: true,
  rolloutScope: true,
  controlMode: true,
  strategy: true,
  status: true,
  currentTrafficPercentage: true,
  baselinePercentage: true,
  workloadName: true,
  versionNew: true,
  versionOld: true,
  thresholds: true,
  stepPercent: true,
  stepIntervalSeconds: true,
  analysisIntervalSeconds: true,
  warmUpRequests: true,
  metricWindowSeconds: true,
  maxDurationSeconds: true,
  failReason: true,
  lastDecision: true,
  targetingRuleId: true,
  createdAt: true,
  updatedAt: true,
  environment: { select: { id: true, name: true, isProduction: true } },
  flagEnvConfig: { select: { flag: { select: { id: true, key: true } } } },
  targetVariant: { select: { key: true } },
} satisfies Prisma.RolloutSessionSelect;

const eventSelect = {
  id: true,
  action: true,
  isIntent: true,
  processedAt: true,
  trafficPercentage: true,
  reason: true,
  triggeredBy: true,
  actorUserId: true,
  causedByEventId: true,
  metricSnapshot: true,
  createdAt: true,
} satisfies Prisma.RolloutEventSelect;

export type SessionDetailRow = Prisma.RolloutSessionGetPayload<{
  select: typeof sessionDetailSelect;
}>;
export type EventRow = Prisma.RolloutEventGetPayload<{
  select: typeof eventSelect;
}>;

export interface DetailRows {
  session: SessionDetailRow;
  events: EventRow[];
  pendingIntent:
    | {
        id: string;
        action: RolloutAction;
        createdAt: Date;
        actorEmail: string | null;
      }
    | undefined;
}

export async function detailOf(
  projectId: string,
  sessionId: string,
): Promise<DetailRows | undefined> {
  const session = await prisma.rolloutSession.findFirst({
    where: { id: sessionId, projectId },
    select: sessionDetailSelect,
  });
  if (session === null) return undefined;
  const [events, pending] = await Promise.all([
    prisma.rolloutEvent.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DETAIL_EVENTS,
      select: eventSelect,
    }),
    prisma.rolloutEvent.findFirst({
      where: { sessionId, isIntent: true, processedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        action: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    }),
  ]);
  return {
    session,
    events,
    pendingIntent:
      pending === null
        ? undefined
        : {
            id: pending.id,
            action: pending.action,
            createdAt: pending.createdAt,
            actorEmail: pending.actor?.email ?? null,
          },
  };
}

const summarySelect = {
  id: true,
  environmentId: true,
  rolloutScope: true,
  strategy: true,
  status: true,
  currentTrafficPercentage: true,
  baselinePercentage: true,
  workloadName: true,
  failReason: true,
  createdAt: true,
  updatedAt: true,
  flagEnvConfig: { select: { flag: { select: { key: true } } } },
} satisfies Prisma.RolloutSessionSelect;

export type SummaryRow = Prisma.RolloutSessionGetPayload<{
  select: typeof summarySelect;
}>;

export function list(
  projectId: string,
  query: ListRolloutsQuery,
): Promise<SummaryRow[]> {
  return prisma.rolloutSession.findMany({
    where: {
      projectId,
      ...(query.envId === undefined ? {} : { environmentId: query.envId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit,
    skip: query.offset,
    select: summarySelect,
  });
}

/**
 * Nhật ký đầy đủ, mới trước, keyset theo `(created_at, id)` — không theo `id`
 * một mình: event của S1 mang uuid v4, của S3 mang uuid v7, nên thứ tự id không
 * phải thứ tự thời gian.
 */
export async function events(
  projectId: string,
  sessionId: string,
  query: RolloutEventsQuery,
): Promise<EventRow[] | "no-session" | "bad-cursor"> {
  const owned = await prisma.rolloutSession.findFirst({
    where: { id: sessionId, projectId },
    select: { id: true },
  });
  if (owned === null) return "no-session";
  const cursor =
    query.before === undefined
      ? null
      : await prisma.rolloutEvent.findFirst({
          where: { id: query.before, sessionId },
          select: { id: true, createdAt: true },
        });
  // Con trỏ không thuộc session này: trả trang đầu là để client lặp "trang kế"
  // nhận lại trang đầu mãi — nói thẳng là con trỏ sai
  if (query.before !== undefined && cursor === null) return "bad-cursor";
  return prisma.rolloutEvent.findMany({
    where: {
      sessionId,
      ...(cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit,
    select: eventSelect,
  });
}
