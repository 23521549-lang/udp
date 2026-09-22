import { ACTIVE_ROLLOUT_STATUS_SQL, type Prisma } from "@udp/db";

/**
 * Đọc/ghi phần "đang gắn nhãn" của một env-config (§6.6 [v4.3]).
 *
 * Hai quy tắc của file này:
 *   - `is_tracked` đổi bằng SQL THÔ. Prisma `update` trên `flag_env_configs` tự
 *     đẩy `updated_at` — mốc optimistic lock của người đang sửa rule — nên mỗi lần
 *     rollout bắt đầu hay kết thúc sẽ cho người đó một 409 giả.
 *   - Đọc `rollout_sessions` chỉ qua đúng sáu cột `udp_s2` được cấp (§1.2); câu
 *     nào cần cột thứ bảy sẽ nổ 42501 ngay ở test.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export interface TrackTarget {
  configId: string;
  environmentId: string;
  flagKey: string;
  isTracked: boolean;
  /** [v4.5] `track` chỉ gắn nhãn cho flag ACTIVE — xem `rollout.service.track` */
  flagActive: boolean;
}

export interface SessionConfig {
  /** NULL với rollout SERVICE_LEVEL — không có flag nào để gắn nhãn */
  configId: string | null;
  active: boolean;
}

export async function sessionConfigOf(
  db: Db,
  sessionId: string,
): Promise<SessionConfig | null> {
  const rows = await db.$queryRaw<SessionConfig[]>`
    SELECT flag_env_config_id::text AS "configId",
           status IN (${ACTIVE_ROLLOUT_STATUS_SQL})    AS "active"
      FROM rollout_sessions
     WHERE id = ${sessionId}::uuid`;
  return rows[0] ?? null;
}

export async function trackTargetOf(
  db: Db,
  configId: string,
): Promise<TrackTarget | null> {
  const rows = await db.$queryRaw<TrackTarget[]>`
    SELECT c.id::text             AS "configId",
           c.environment_id::text AS "environmentId",
           f.key                  AS "flagKey",
           c.is_tracked           AS "isTracked",
           f.lifecycle_status = 'ACTIVE' AS "flagActive"
      FROM flag_env_configs c
      JOIN feature_flags f ON f.id = c.flag_id
     WHERE c.id = ${configId}::uuid`;
  return rows[0] ?? null;
}

/** Số flag đang track ở environment — đếm SAU khi bước 1 đã khoá environment */
export async function trackedCountOf(
  db: Db,
  environmentId: string,
): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM flag_env_configs
     WHERE environment_id = ${environmentId}::uuid
       AND is_tracked`;
  return rows[0]?.n ?? 0;
}

/**
 * Config còn session ĐANG CHẠY không. Rollout mới cùng flag có thể bắt đầu
 * trước khi lệnh untrack của rollout cũ tới — gỡ nhãn lúc đó là tắt dữ liệu của
 * một rollout đang sống. ([v4.4] mỗi flag tối đa một rollout sống —
 * `idx_one_active_rollout_per_flag` — nên "rollout khác" ở đây luôn là rollout
 * KẾ TIẾP, không bao giờ là rollout song song.)
 */
export async function hasActiveSession(
  db: Db,
  configId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM rollout_sessions
       WHERE flag_env_config_id = ${configId}::uuid
         AND status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
    ) AS active`;
  return rows[0]?.active ?? false;
}

export async function setTracked(
  db: Db,
  configId: string,
  tracked: boolean,
): Promise<void> {
  const count = await db.$executeRaw`
    UPDATE flag_env_configs
       SET is_tracked = ${tracked}
     WHERE id = ${configId}::uuid`;
  if (count !== 1) {
    throw new Error(
      `setTracked: env-config ${configId} không còn — đã đọc lại dưới khoá mà vẫn mất`,
    );
  }
}
