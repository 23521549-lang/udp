import type { AuditEntryWire } from "@udp/shared-types/wire";
import type { PublicAuditEntry } from "./audit.types.js";

/**
 * [v4.11] Dòng audit trên dây: `occurredAt` là chuỗi ISO, không phải `Date`.
 *
 * `PublicAuditEntry` khai `Date` vì nó là phép chiếu database; `res.json()` đổi nó
 * thành chuỗi một cách âm thầm. Đổi tường minh ở đây để `sendJson` kiểm được đúng
 * thứ đi lên dây.
 */
export const auditEntryWireOf = (entry: PublicAuditEntry): AuditEntryWire => ({
  id: entry.id,
  action: entry.action,
  actorType: entry.actorType,
  actorUserId: entry.actorUserId,
  targetType: entry.targetType,
  targetId: entry.targetId,
  environmentId: entry.environmentId,
  before: entry.before,
  after: entry.after,
  occurredAt: entry.occurredAt.toISOString(),
});
