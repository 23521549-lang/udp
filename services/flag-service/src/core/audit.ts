import type { Prisma } from "@udp/db";
import { auditEntry, type AuditInput } from "@udp/http";

/**
 * Ghi một hàng `audit_logs` TRONG transaction ghi cấu hình của Service 2 [v4.5].
 *
 * Cùng transaction với thay đổi và outbox (bước `mutate` của `writeConfigChange`):
 * thay đổi lùi thì audit lùi theo, thay đổi commit thì audit chắc chắn có — không
 * có cửa sổ nào mà một bên đã ghi còn bên kia chưa (§1.2, bất biến I40). Service 1
 * không ghi audit hộ nữa: đó là dual-write.
 */
export async function recordAudit(
  tx: Prisma.TransactionClient,
  projectId: string,
  input: AuditInput,
): Promise<void> {
  await tx.auditLog.create({
    data: { projectId, ...auditEntry(input) },
    select: { id: true },
  });
}
