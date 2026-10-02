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
 * **Thứ tự có hai khoá, không phải một.** `audit_logs.occurred_at` là
 * `TIMESTAMPTZ(3)` và do **đồng hồ của máy writer** điền: đo 02/10/2026, Prisma
 * sinh giá trị của `@default(now())` ở client chứ không ở database (lệch 13 ms
 * so với `Date.now()`, 1 567 ms so với `now()` của database). Bảng lại có nhiều
 * tiến trình ghi — Service 1 và Service 2 (`flag-service/src/core/audit.ts`),
 * thiết kế cho phép cả Service 3 — nên hai hàng trùng `occurred_at` là có thật,
 * và chỉ sắp theo cột đó thì thứ tự giữa các hàng bằng nhau không xác định,
 * làm phân trang OFFSET lặp hoặc bỏ sót hàng. `id` (`uuid(7)`) là khoá phụ ổn
 * định để khoá sắp bất biến.
 *
 * Nó **không** đảm bảo đúng chiều thời gian giữa hai tiến trình, vì `uuid(7)`
 * cũng sinh ở máy của writer. Chấp nhận được ở đây vì không quyết định nghiệp
 * vụ nào đọc thứ tự của nhật ký — nó chỉ để hiển thị. Cột có một quyết định đọc
 * thứ tự thì phải để database cấp mốc, như `deployment_events.occurred_at` đã
 * làm ở Plan #61 61d-1.
 *
 * (Bản trước của chú thích này nói `CURRENT_TIMESTAMP` điền cột và `uuid(7)`
 * "giữ đúng chiều thời gian" — phép đo 02/10/2026 bác cả hai; kết luận "hai
 * khoá sắp" thì vẫn đúng, chỉ lý do là sai.)
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
