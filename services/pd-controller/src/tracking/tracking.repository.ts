import { ACTIVE_ROLLOUT_STATUS_SQL } from "@udp/db";
import type { DbClient } from "../core/db.js";

/**
 * Env-config còn gắn nhãn `ff` mà không còn rollout nào chạy (§6.6 [v4.3]) —
 * hàng đợi của lưới gỡ nhãn.
 *
 * Theo CONFIG, không theo session: hàng session có thể đã bị xoá (Service 1 có
 * quyền xoá; xoá rule cuốn session đã kết thúc) trước khi lệnh gỡ thành công, và
 * khi đó flag giữ một chỗ trong trần `MAX_TRACKED_FLAGS_PER_ENV` mãi mãi nếu lưới
 * đi theo session. Dùng index partial `flag_env_configs_tracked_idx`.
 */
export async function findUntrackPending(
  db: DbClient,
  limit: number,
  /** Con trỏ keyset — chỉ lấy config có id LỚN HƠN; vắng = từ đầu */
  after?: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id
      FROM flag_env_configs c
     WHERE c.is_tracked
       AND (${after ?? null}::uuid IS NULL OR c.id > ${after ?? null}::uuid)
       AND NOT EXISTS (
         SELECT 1
           FROM rollout_sessions s
          WHERE s.flag_env_config_id = c.id
            AND s.status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
       )
     ORDER BY c.id
     LIMIT ${limit}`;
  return rows.map((r) => r.id);
}
