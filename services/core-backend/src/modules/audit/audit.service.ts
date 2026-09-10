import type { Request } from "express";
import type { ActorType, Prisma } from "@udp/db";
import { redact } from "@udp/http";

/**
 * Nhật ký kiểm toán.
 *
 * §1.2 xếp `AuditLog` vào nhóm append-only nhiều writer: mỗi service INSERT
 * thẳng **trong transaction của chính mình**. Đó không phải tiện lợi mà là điều
 * kiện đúng đắn — v3 bắt Service 2 ghi audit "qua API của Service 1", tức là
 * dual-write: đổi flag thành công nhưng gọi API hỏng thì mất audit, gọi trước
 * rồi transaction rollback thì audit sai. Đúng bài toán ADR-02 tránh.
 *
 * Database cũng đang cưỡng chế điều đó: `udp_s1` chỉ có `SELECT, INSERT` trên
 * `audit_logs`, không có UPDATE hay DELETE. Một hàng đã ghi là không sửa được.
 */

/** Giới hạn của schema — §2.2. Cắt ở đây chứ không để Postgres ném 22001 */
const MAX = {
  action: 100,
  targetType: 50,
  targetId: 100,
  userAgent: 255,
} as const;

export interface AuditInput {
  /** Quy ước §2.2: `<thực_thể>.<động_từ>`, ví dụ `project.create`, `member.add` */
  action: string;
  targetType: string;
  targetId: string;
  actorType?: ActorType;
  actorUserId?: string;
  environmentId?: string;
  before?: unknown;
  after?: unknown;
  /** Ngữ cảnh HTTP, nếu hành động đến từ một request */
  request?: Request;
}

/**
 * `X-Forwarded-For` có thể mang bất cứ thứ gì, kể cả chuỗi `unknown` mà
 * `proxy-addr` trả về nguyên văn. Cột là `INET`, nên một giá trị không phải địa
 * chỉ sẽ ném `22P02` — và vì audit nằm TRONG transaction nghiệp vụ, lỗi đó
 * cuốn theo cả hành động của người dùng. Thà mất một trường hiển thị còn hơn
 * mất việc tạo project.
 */
const IP = /^[0-9a-f.:]+$/i;

const ipOf = (req: Request | undefined): string | undefined => {
  const raw = req?.ip;
  return raw !== undefined && IP.test(raw) ? raw : undefined;
};

const uaOf = (req: Request | undefined): string | undefined =>
  req?.get("user-agent")?.slice(0, MAX.userAgent);

/**
 * Dựng payload cho một hàng `AuditLog` nằm trong nested write của Prisma.
 *
 * Trả về payload thay vì tự ghi, để lời gọi ghi audit đi CÙNG một lệnh với hành
 * động nghiệp vụ. Nhờ vậy không cần `$transaction` tương tác — vốn giữ một
 * connection suốt nhiều round-trip, mà pool mặc định chỉ có 5.
 */
export function auditEntry(
  input: AuditInput,
): Prisma.AuditLogCreateWithoutProjectInput {
  const actorUserId = input.actorUserId ?? input.request?.user?.sub;
  const ip = ipOf(input.request);
  const ua = uaOf(input.request);

  /**
   * Spread có điều kiện chứ không gán `undefined`.
   *
   * `exactOptionalPropertyTypes` khiến `{ before: undefined }` là lỗi biên
   * dịch, và kiểu `Json?` của Prisma không có `undefined` trong union — bỏ hẳn
   * khoá là cách duy nhất diễn đạt "không có giá trị này".
   */
  return {
    action: input.action.slice(0, MAX.action),
    targetType: input.targetType.slice(0, MAX.targetType),
    targetId: input.targetId.slice(0, MAX.targetId),
    actorType: input.actorType ?? "USER",
    ...(actorUserId === undefined
      ? {}
      : { actor: { connect: { id: actorUserId } } }),
    ...(input.environmentId === undefined
      ? {}
      : { environment: { connect: { id: input.environmentId } } }),
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
