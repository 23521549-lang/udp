import type { Prisma } from "@udp/db";
import { prisma } from "../../core/db.js";
import type { AuditQuery, PublicAuditEntry } from "./audit.types.js";

const AUDIT_FIELDS = {
  id: true,
  action: true,
  actorType: true,
  actorUserId: true,
  targetType: true,
  targetId: true,
  environmentId: true,
  before: true,
  after: true,
  occurredAt: true,
} as const;

/**
 * Đọc nhật ký của một project.
 *
 * **Thứ tự có hai khoá, không phải một.** Nhiều hàng audit ghi trong CÙNG một
 * transaction chia sẻ đúng một `occurred_at` — `CURRENT_TIMESTAMP` là thời điểm
 * bắt đầu transaction, không phải lúc ghi. Chỉ sắp theo `occurred_at` thì thứ
 * tự giữa các hàng bằng nhau là không xác định, và phân trang sẽ lặp hoặc bỏ
 * sót hàng. `id` là `uuid(7)` — sinh theo thời gian — nên nó vừa là khoá phụ
 * ổn định vừa giữ đúng chiều thời gian.
 *
 * **`to` là mốc loại trừ.** Với `lte`, một khoảng `[from, to]` của hai lần gọi
 * liên tiếp sẽ chồng lấn đúng một mốc và trả trùng bản ghi biên.
 */
function whereOf(
  projectId: string,
  query: AuditQuery,
): Prisma.AuditLogWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {
    ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
    ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
  };
  return {
    projectId,
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.actor === undefined ? {} : { actorUserId: query.actor }),
    ...(query.from === undefined && query.to === undefined
      ? {}
      : { occurredAt }),
  };
}

export const list = (
  projectId: string,
  query: AuditQuery,
): Promise<PublicAuditEntry[]> =>
  prisma.auditLog.findMany({
    where: whereOf(projectId, query),
    select: AUDIT_FIELDS,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: query.limit,
    skip: query.offset,
  });

/** [v4.11, Plan #53] Số dòng khớp CÙNG bộ lọc với `list` — `total` của trang */
export const count = (projectId: string, query: AuditQuery): Promise<number> =>
  prisma.auditLog.count({ where: whereOf(projectId, query) });
