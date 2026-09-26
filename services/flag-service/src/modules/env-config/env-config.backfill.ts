import type { Prisma } from "@udp/db";
import { recomputedStateOf } from "@udp/flag-snapshot";
import { NotFoundError } from "@udp/http";
import { prisma } from "../../core/db.js";
import { writeConfigChange } from "../../core/outbox.js";

/**
 * [v4.11, Plan #40] Environment mới của project nhận một `FlagEnvConfig` TẮT cho mọi flag còn
 * thiếu (§4, §9 `POST /internal/environments/:id/backfill`) — cùng luật "một hàng cho MỌI
 * environment, tắt sẵn" của lúc tạo flag (§8.4). Thiếu hàng thì flag "không tồn tại" ở
 * environment đó theo cách khó hiểu nhất: Portal hiện flag, SDK trả `FLAG_NOT_FOUND`.
 *
 * Qua ADR-05 như mọi lần ghi cấu hình: một version, `config_hash` tính trên snapshot SAU thay đổi,
 * một dòng `environment.backfilled` (replica áp bằng snapshot — một dòng mang nhiều flag).
 * Idempotent: không thiếu gì thì không ghi gì, version không tăng. Danh sách thiếu đọc lại DƯỚI
 * khoá environment (bước 1) nên hai lời gọi đồng thời không tạo hàng thừa.
 *
 * Không ghi `audit_logs`: người làm đã có ở dòng change log (`actor_user_id`), còn hành động của
 * người dùng — tạo environment — do Service 1 ghi. Một hàng audit mang `environment_id` ở đây sẽ
 * biến environment vừa tạo thành environment "có lịch sử", không xoá được nữa.
 */

export interface BackfillResult {
  /** Số `FlagEnvConfig` vừa tạo — 0 khi không thiếu gì */
  created: number;
}

const missingFlagsOf = (
  db: Prisma.TransactionClient,
  projectId: string,
  environmentId: string,
) =>
  db.featureFlag.findMany({
    where: { projectId, envConfigs: { none: { environmentId } } },
    select: { id: true, key: true },
    orderBy: { key: "asc" },
  });

export async function backfill(
  environmentId: string,
  actorUserId: string,
): Promise<BackfillResult> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { projectId: true },
  });
  if (environment === null) {
    throw new NotFoundError("Không tìm thấy environment");
  }
  const { projectId } = environment;
  if ((await missingFlagsOf(prisma, projectId, environmentId)).length === 0) {
    return { created: 0 };
  }

  let addedFlagKeys: string[] = [];
  await writeConfigChange({
    environmentIds: [environmentId],
    changeType: "environment.backfilled",
    actorUserId,
    mutate: async (tx) => {
      const missing = await missingFlagsOf(tx, projectId, environmentId);
      await tx.flagEnvConfig.createMany({
        data: missing.map((flag) => ({
          flagId: flag.id,
          environmentId,
          isEnabled: false,
        })),
      });
      addedFlagKeys = missing.map((flag) => flag.key);
    },
    // Chạy SAU `mutate` trong cùng transaction — danh sách đã có
    stateOf: (tx, id) => recomputedStateOf({ addedFlagKeys })(tx, id),
  });
  return { created: addedFlagKeys.length };
}
