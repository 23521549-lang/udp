import {
  ACTIVE_ROLLOUT_STATUS_SQL,
  Prisma,
  type FailReason,
  type RolloutStatus,
} from "@udp/db";
import { ZodError } from "zod";
import type { DbClient } from "../core/db.js";
import { sessionRowSchema, type Decision, type SessionRow } from "./types.js";

/**
 * Đường đọc/ghi `rollout_sessions` của Service 3 — toàn bộ bằng SQL thô.
 *
 * Vì sao không dùng Prisma `update`: `@updatedAt` tự thêm `SET updated_at` vào
 * mọi lệnh, mà cột đó là của Service 1; dưới `udp_s3` mọi `update()` bị 42501
 * (đo 12/09/2026). SQL thô với danh sách SET tường minh là cách duy nhất ghi
 * đúng tám cột §1.2 cho phép. `RETURNING` thì tự do: `udp_s3` có SELECT toàn bảng.
 *
 * Hệ quả cần biết ở nơi khác: `updated_at` của session KHÔNG đổi khi S3 ghi.
 * Portal/S1 muốn "lần cập nhật cuối của rollout" thì đọc `last_decision.at`
 * hoặc `last_step_at`.
 *
 * Mọi mốc thời gian của lease dùng `now()` của DATABASE (claim, renew, hết
 * hạn) — nhiều replica trên nhiều máy chỉ có một đồng hồ chung là đồng hồ
 * đó. Mọi mốc của nhịp phân tích (dwell, analysis, cửa sổ) dùng đồng hồ JS tiêm
 * vào reconciler, và `last_step_at` ghi bằng tham số JS để cùng đồng hồ.
 */

type Db = DbClient;

/**
 * Hàng đã CLAIM nhưng không đọc được — reconciler phải nhả lease và ghi lý do,
 * vì `UPDATE ... RETURNING` đã commit trước khi zod chạy.
 */
export class InvalidSessionRowError extends Error {
  constructor(
    readonly sessionId: string,
    detail: string,
  ) {
    super(detail);
    this.name = "InvalidSessionRowError";
  }
}

const COLUMNS = Prisma.sql`
  id::text                          AS "id",
  project_id::text                  AS "projectId",
  environment_id::text              AS "environmentId",
  flag_env_config_id::text          AS "flagEnvConfigId",
  targeting_rule_id::text           AS "targetingRuleId",
  target_variant_id::text           AS "targetVariantId",
  workload_name                     AS "workloadName",
  rollout_scope::text               AS "rolloutScope",
  strategy::text                    AS "strategy",
  control_mode::text                AS "controlMode",
  status::text                      AS "status",
  current_traffic_percentage::float8 AS "currentTrafficPercentage",
  baseline_percentage::float8       AS "baselinePercentage",
  thresholds                        AS "thresholds",
  metric_queries                    AS "metricQueries",
  step_percent::float8              AS "stepPercent",
  step_interval_seconds             AS "stepIntervalSeconds",
  analysis_interval_seconds         AS "analysisIntervalSeconds",
  metric_window_seconds             AS "metricWindowSeconds",
  warm_up_requests                  AS "warmUpRequests",
  max_duration_seconds              AS "maxDurationSeconds",
  last_step_at                      AS "lastStepAt",
  last_decision                     AS "lastDecision",
  version                           AS "version",
  claimed_by                        AS "claimedBy",
  claimed_until                     AS "claimedUntil",
  fail_reason::text                 AS "failReason",
  created_at                        AS "createdAt"
`;

const ACTIVE = Prisma.sql`status IN (${ACTIVE_ROLLOUT_STATUS_SQL})`;

function parseRows(rows: unknown[]): SessionRow[] {
  return rows.map((row) => sessionRowSchema.parse(row));
}

/** Session chưa ai giữ hoặc lease đã hết — hàng đợi của vòng quét (§7.1) */
export async function findReconcilable(db: Db): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM rollout_sessions
     WHERE ${ACTIVE}
       AND (claimed_until IS NULL OR claimed_until < now())
     ORDER BY created_at ASC`;
  return rows.map((r) => r.id);
}

export async function loadSession(
  db: Db,
  sessionId: string,
): Promise<SessionRow | undefined> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT ${COLUMNS} FROM rollout_sessions WHERE id = ${sessionId}::uuid`;
  return parseRows(rows)[0];
}

/**
 * Giành lease — ĐÚNG câu SQL của §7.1: `FOR UPDATE SKIP LOCKED` để replica khác
 * đang giữ thì bỏ qua ngay không chờ (đo: 3 client đồng thời, một nhận hàng,
 * hai nhận 0 hàng, không ai chờ), gồm cả `PAUSED` (I27), và `version + 1` ngay
 * lúc claim: version chính là fencing token cho mọi side effect sau đó (I17, I23).
 */
export async function claim(
  db: Db,
  sessionId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<SessionRow | undefined> {
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE rollout_sessions
       SET claimed_by    = ${workerId},
           claimed_until = now() + make_interval(secs => ${leaseSeconds}),
           version       = version + 1
     WHERE id = (
       SELECT id FROM rollout_sessions
        WHERE id = ${sessionId}::uuid
          AND ${ACTIVE}
          AND (claimed_until IS NULL OR claimed_until < now())
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING ${COLUMNS}`;
  if (rows.length === 0) return undefined;
  try {
    return parseRows(rows)[0];
  } catch (err: unknown) {
    const detail =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : String(err);
    throw new InvalidSessionRowError(sessionId, detail);
  }
}

/** 0 hàng nghĩa là đã mất lease — bên gọi phải `fence.abort()` (§7.1) */
export async function renewLease(
  db: Db,
  sessionId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE rollout_sessions
       SET claimed_until = now() + make_interval(secs => ${leaseSeconds})
     WHERE id = ${sessionId}::uuid
       AND claimed_by = ${workerId}
       AND claimed_until > now()`;
  return count === 1;
}

/** Chỉ nhả lease của CHÍNH mình — worker khác đã claim thì không đụng */
export async function releaseLease(
  db: Db,
  sessionId: string,
  workerId: string,
): Promise<void> {
  await db.$executeRaw`
    UPDATE rollout_sessions
       SET claimed_by = NULL, claimed_until = NULL
     WHERE id = ${sessionId}::uuid AND claimed_by = ${workerId}`;
}

export interface SessionPatch {
  status?: RolloutStatus;
  currentTrafficPercentage?: number;
  failReason?: FailReason;
  /** Đồng hồ JS của reconciler */
  lastStepAt?: Date;
}

/**
 * Optimistic lock của ADR-05: ghi CHỈ KHI `version` vẫn là con số đã claim, và
 * đẩy nó lên một. 0 hàng ⇒ worker khác đã claim trong lúc mình ngủ (I17); bên
 * gọi không được coi là thành công.
 */
export async function updateIfVersion(
  db: Db,
  sessionId: string,
  expectedVersion: number,
  patch: SessionPatch,
): Promise<boolean> {
  const sets: Prisma.Sql[] = [Prisma.sql`version = version + 1`];
  if (patch.status !== undefined) {
    sets.push(Prisma.sql`status = ${patch.status}::"RolloutStatus"`);
  }
  if (patch.currentTrafficPercentage !== undefined) {
    sets.push(
      Prisma.sql`current_traffic_percentage = ${patch.currentTrafficPercentage}`,
    );
  }
  if (patch.failReason !== undefined) {
    sets.push(Prisma.sql`fail_reason = ${patch.failReason}::"FailReason"`);
  }
  if (patch.lastStepAt !== undefined) {
    sets.push(Prisma.sql`last_step_at = ${patch.lastStepAt}`);
  }
  const count = await db.$executeRaw`
    UPDATE rollout_sessions
       SET ${Prisma.join(sets, ", ")}
     WHERE id = ${sessionId}::uuid AND version = ${expectedVersion}`;
  return count === 1;
}

/**
 * Ghi `last_decision` MỖI vòng phân tích — cột JSONB, không phải event (§2.2).
 * Không đẩy `version`: quyết định HOLD không phải side effect, và version là
 * token cho S2 — đẩy nó mỗi 30 giây là bắt S2 từ chối một PATCH đang bay. Điều
 * kiện là lease còn của mình, cùng nghĩa với `fence.assert()`.
 */
export async function setLastDecision(
  db: Db,
  sessionId: string,
  workerId: string,
  decision: Decision,
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE rollout_sessions
       SET last_decision = ${JSON.stringify(decision)}::jsonb
     WHERE id = ${sessionId}::uuid
       AND claimed_by = ${workerId}
       AND claimed_until > now()`;
  return count === 1;
}
