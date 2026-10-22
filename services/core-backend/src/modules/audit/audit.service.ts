import type { Request } from "express";
import type { Prisma } from "@udp/db";
import {
  auditEntry as sharedAuditEntry,
  type AuditContext,
  type AuditInput as SharedAuditInput,
} from "@udp/http";

/**
 * Nhật ký kiểm toán phía Service 1 — vỏ mỏng quanh `auditEntry` của `@udp/http`
 * (một định nghĩa cho mọi service ghi `audit_logs`, §1.2). Vỏ này chỉ làm một
 * việc: dựng ngữ cảnh (ai, IP, UA) từ request của người dùng, để các chỗ gọi viết
 * `request: req` như trước.
 */

/**
 * Đầu vào dùng chung, trừ IP/UA — hai thứ đó dựng từ `request`. `actorUserId`
 * vẫn đặt được (mặc định: người dùng của `request`).
 */
export type AuditInput = Omit<SharedAuditInput, "ip" | "userAgent"> & {
  /** Ngữ cảnh HTTP, nếu hành động đến từ một request */
  request?: Request;
};

/** Ai và từ đâu — cũng là thứ S1 chuyển tiếp cho S2 khi nhờ nó ghi cấu hình */
export function auditContextOf(req: Request | undefined): AuditContext {
  return {
    actorUserId: req?.user?.sub,
    ip: req?.ip,
    userAgent: req?.get("user-agent"),
  };
}

/**
 * Payload cho một hàng `AuditLog`, đi CÙNG lệnh với hành động nghiệp vụ (nested
 * write hoặc `$transaction` mảng) — không cần transaction tương tác giữ một
 * connection suốt nhiều round trip. Ghi thẳng thì bên gọi thêm `projectId`.
 */
export function auditEntry(
  input: AuditInput,
): Prisma.AuditLogUncheckedCreateWithoutProjectInput {
  const { request, actorUserId, ...rest } = input;
  const context = auditContextOf(request);
  return sharedAuditEntry({
    ...rest,
    ...context,
    ...(actorUserId === undefined ? {} : { actorUserId }),
  });
}
