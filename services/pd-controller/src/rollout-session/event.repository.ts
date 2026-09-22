import { randomUUID } from "node:crypto";
import { ROLLOUT_EVENT } from "@udp/config";
import { Prisma, type RolloutAction } from "@udp/db";
import type { DbClient } from "../core/db.js";
import type { MetricSnapshot } from "@udp/shared-types";
import { INTENT_ACTIONS, type IntentRow } from "./types.js";

/**
 * `rollout_events` và `deployment_events` từ phía Service 3.
 *
 * Event thực thi ghi qua Prisma `create` — INSERT có `RETURNING` toàn cột và
 * `udp_s3` có SELECT nên chạy được (đo 12/09/2026); trigger writer chặn
 * `is_intent = true` từ S3 (UDP03), đúng luật §1.2. Đánh dấu intent thì bằng SQL
 * thô: `udp_s3` chỉ có UPDATE trên đúng cột `processed_at`, và trigger chỉ cho
 * đặt MỘT lần trên hàng intent (migration `rollout_intent_processed`).
 */

/**
 * Intent cũ nhất chưa xử lý — người dùng bấm trước thì được làm trước (§7.6).
 * Chỉ bốn action của người dùng; một hàng `is_intent` mang action khác là dữ
 * liệu hỏng từ phía ghi, không phải việc của reconciler.
 */
export async function findUnprocessedIntent(
  db: DbClient,
  sessionId: string,
): Promise<IntentRow | undefined> {
  const rows = await db.$queryRaw<IntentRow[]>`
    SELECT id::text     AS "id",
           action::text AS "action",
           created_at   AS "createdAt"
      FROM rollout_events
     WHERE session_id = ${sessionId}::uuid
       AND is_intent
       AND processed_at IS NULL
       AND action::text IN (${Prisma.join([...INTENT_ACTIONS])})
     ORDER BY created_at ASC
     LIMIT 1`;
  return rows[0];
}

/**
 * Đánh dấu đã xử lý — 0 hàng nghĩa là ai đó đã đánh dấu rồi: bên gọi trong
 * transaction phải coi đó là lỗi để không commit một event thực thi thứ hai.
 */
export async function markProcessed(
  db: DbClient,
  intentId: string,
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE rollout_events
       SET processed_at = now()
     WHERE id = ${intentId}::uuid AND processed_at IS NULL`;
  return count === 1;
}

/** `markProcessed` trong transaction — ném để transaction lùi thay vì ghi trùng */
export async function markProcessedOrThrow(
  db: DbClient,
  intentId: string,
): Promise<void> {
  if (!(await markProcessed(db, intentId))) {
    throw new Error(`Intent ${intentId} đã được xử lý bởi vòng khác`);
  }
}

export interface ExecutionEvent {
  sessionId: string;
  action: RolloutAction;
  /** NOT NULL trong schema — mọi event, kể cả PAUSE, mang phần trăm hiện hành */
  trafficPercentage: number;
  triggeredBy: "AUTO" | "MANUAL";
  reason?: string;
  metricSnapshot?: MetricSnapshot | null;
  /** Intent mà event này thi hành — `triggered_by` suy ra từ đây (§2.2) */
  causedByEventId?: string;
}

/** Event thực thi (`is_intent = false`) — nhật ký chuyển trạng thái, không ghi mỗi tick */
export async function recordExecution(
  db: DbClient,
  event: ExecutionEvent,
): Promise<void> {
  await db.rolloutEvent.create({
    data: {
      sessionId: event.sessionId,
      action: event.action,
      isIntent: false,
      trafficPercentage: event.trafficPercentage,
      triggeredBy: event.triggeredBy,
      ...(event.reason === undefined
        ? {}
        : { reason: event.reason.slice(0, ROLLOUT_EVENT.reasonMaxLength) }),
      ...(event.metricSnapshot === undefined || event.metricSnapshot === null
        ? {}
        : { metricSnapshot: event.metricSnapshot }),
      ...(event.causedByEventId === undefined
        ? {}
        : { causedByEventId: event.causedByEventId }),
    },
    select: { id: true },
  });
}

export interface RollbackDeployment {
  projectId: string;
  environmentId: string;
  sessionId: string;
  workloadName: string | null;
  triggeredBy: "AUTO" | "MANUAL";
  metadata: Prisma.InputJsonObject;
}

/**
 * `DeploymentEvent(ROLLBACK)` cho Event Store (E10, §8.5) — ghi cho cả rollback
 * lẫn EXPIRE vì cả hai đều đưa traffic về baseline; `metadata.failReason` phân
 * biệt hai ca.
 *
 * `deployment_id` là NOT NULL nhưng một rollback FLAG_LEVEL không gắn với lần
 * deploy nào — cột chỉ để gom sự kiện của cùng một lần triển khai. S3 sinh id
 * mới; `rollout_session_id` mới là khoá nối cho E5.
 */
export async function recordRollbackDeployment(
  db: DbClient,
  rollback: RollbackDeployment,
): Promise<void> {
  await db.deploymentEvent.create({
    data: {
      projectId: rollback.projectId,
      environmentId: rollback.environmentId,
      deploymentId: randomUUID(),
      eventType: "ROLLBACK",
      ...(rollback.workloadName === null
        ? {}
        : { workloadName: rollback.workloadName }),
      rolloutSessionId: rollback.sessionId,
      triggeredBy: rollback.triggeredBy,
      metadata: rollback.metadata,
    },
    select: { id: true },
  });
}
