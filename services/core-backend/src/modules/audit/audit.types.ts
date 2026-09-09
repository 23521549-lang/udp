import { z } from "zod";
import type { ActorType } from "@udp/db";

/**
 * Bộ lọc của `GET /projects/:id/audit` — §9: `?action=&actor=&from=&to=&limit=`.
 *
 * Mỗi ràng buộc dưới đây chặn một cách hỏng đã đo được trên chính stack này:
 *
 *  - `limit` **phải** có trần. `z.coerce.number()` trần cho `?limit=1000000000`
 *    đi lọt, thành `take: 1e9`, và mỗi hàng còn kéo theo hai cột JSONB.
 *  - `limit` **phải** có sàn. `?limit=-5` cũng lọt, mà Prisma hiểu `take` âm là
 *    "lấy từ cuối, đảo chiều" — người dùng nhận 5 bản ghi CŨ NHẤT thay vì mới
 *    nhất, không kèm lỗi nào.
 *  - `?limit=` rỗng bị `coerce` biến thành `0`, tức `take: 0`, tức mảng rỗng:
 *    giao diện báo "không có audit nào" cho một project đầy log.
 *  - `from`/`to` **phải** có offset múi giờ. `new Date("2026-09-09")` là 00:00
 *    UTC = 07:00 giờ Việt Nam, nên lọc "cả ngày 9/9" mất bảy giờ đầu; còn chuỗi
 *    không offset lại được diễn giải theo `TZ` của container.
 *  - `actor` **phải** là UUID: cột `actor_user_id` kiểu `uuid`, một email
 *    truyền thẳng vào `where` cho `22P02` và rơi xuống nhánh 500.
 */
export const auditQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  actor: z.string().uuid("actor phải là UUID của người dùng").optional(),
  from: z
    .string()
    .datetime({ offset: true, message: "from phải là ISO-8601 kèm offset" })
    .optional(),
  to: z
    .string()
    .datetime({ offset: true, message: "to phải là ISO-8601 kèm offset" })
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface PublicAuditEntry {
  id: string;
  action: string;
  actorType: ActorType;
  actorUserId: string | null;
  targetType: string;
  targetId: string;
  environmentId: string | null;
  before: unknown;
  after: unknown;
  occurredAt: Date;
}
