import { isIP } from "node:net";
import type { ActorType, Prisma } from "@udp/db";
import { redact } from "./logger.js";

/**
 * Nhật ký kiểm toán — một định nghĩa cho MỌI service ghi `audit_logs` [v4.5].
 *
 * §1.2 xếp `AuditLog` vào nhóm append-only nhiều writer: mỗi service INSERT
 * thẳng **trong transaction của chính mình**. Đó không phải tiện lợi mà là điều
 * kiện đúng đắn — ghi audit ở một service KHÁC với service làm thay đổi là
 * dual-write: đổi thành công nhưng ghi audit hỏng thì mất dấu, ghi trước rồi
 * transaction lùi thì audit sai. Vì thế Service 2 ghi audit của thao tác flag
 * trong transaction ADR-05 của chính nó, không để Service 1 ghi hộ.
 *
 * Database cưỡng chế phần còn lại: `udp_s1`, `udp_s2` chỉ có `SELECT, INSERT`
 * trên `audit_logs` (I22). Một hàng đã ghi là không sửa được.
 *
 * Trả dạng VÔ HƯỚNG (`actorUserId`, `environmentId`) chứ không `connect`: Prisma
 * 7 đọc hàng cha trước khi `connect`, và `udp_s2` không có quyền nào trên
 * `users` — `connect` biến mọi lần ghi flag có actor thành 42501 (QA Plan #19).
 * Dạng vô hướng còn bớt hai round trip trong lúc đang giữ khoá environment.
 */

/** Giới hạn của schema — §2.2. Cắt ở đây chứ không để Postgres ném 22001 */
const MAX = {
  action: 100,
  targetType: 50,
  targetId: 100,
  userAgent: 255,
} as const;

/** Ai làm và từ đâu — S1 dựng từ request của người dùng, S2 từ header S1 chuyển tiếp */
export interface AuditContext {
  actorUserId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuditInput extends AuditContext {
  /** Quy ước §2.2: `<thực_thể>.<động_từ>`, ví dụ `project.create`, `flag.env.update` */
  action: string;
  targetType: string;
  targetId: string;
  actorType?: ActorType;
  environmentId?: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Chỉ địa chỉ IP thật mới vào cột `INET`. Một chuỗi khác (`unknown` của
 * `proxy-addr`, `cafe`, `1.2.3`) sẽ ném `22P02` — và vì audit nằm TRONG
 * transaction nghiệp vụ, lỗi đó cuốn theo cả hành động của người dùng. Thà mất
 * một trường hiển thị còn hơn mất thay đổi.
 */
export function auditIp(raw: string | undefined): string | undefined {
  // `isIP` nhận IPv6 kèm zone (`fe80::1%eth0`) mà `INET` của Postgres thì không
  return raw !== undefined && isIP(raw) !== 0 && !raw.includes("%")
    ? raw
    : undefined;
}

/**
 * Payload của một hàng `AuditLog` KHÔNG gồm project — bên gọi đặt `projectId`
 * (ghi thẳng) hoặc lồng dưới `auditLogs: { create }` của project (nested write).
 */
export function auditEntry(
  input: AuditInput,
): Prisma.AuditLogUncheckedCreateWithoutProjectInput {
  const ip = auditIp(input.ip);
  const ua = input.userAgent?.slice(0, MAX.userAgent);
  return {
    action: input.action.slice(0, MAX.action),
    targetType: input.targetType.slice(0, MAX.targetType),
    targetId: input.targetId.slice(0, MAX.targetId),
    actorType: input.actorType ?? "USER",
    ...(input.actorUserId === undefined
      ? {}
      : { actorUserId: input.actorUserId }),
    ...(input.environmentId === undefined
      ? {}
      : { environmentId: input.environmentId }),
    // `redact()` là hàng rào duy nhất — schema.prisma ghi rõ before/after PHẢI
    // đi qua nó. Viết một bản khác ở đây là mở đúng lỗ mà nó bịt.
    ...(input.before === undefined
      ? {}
      : { before: redact(input.before) as Prisma.InputJsonValue }),
    ...(input.after === undefined
      ? {}
      : { after: redact(input.after) as Prisma.InputJsonValue }),
    ...(ip === undefined ? {} : { ipAddress: ip }),
    ...(ua === undefined ? {} : { userAgent: ua }),
  };
}
