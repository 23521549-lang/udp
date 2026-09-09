import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../core/db.js";

/**
 * Phiên refresh token: cấp, xoay vòng, thu hồi.
 *
 * Tách khỏi `auth.repository.ts` vì đây là một vòng đời riêng với luật riêng —
 * đặc biệt là luật phát hiện tái sử dụng, thứ dễ viết sai nếu trộn lẫn với các
 * truy vấn user thông thường.
 */

/**
 * Chỉ lưu SHA-256, không lưu token.
 *
 * Không cần salt như mật khẩu: token là
 * chuỗi ngẫu nhiên entropy cao do chính ta sinh, không phải thứ người dùng chọn,
 * nên không có từ điển để dò và bảng cầu vồng vô nghĩa. Đổi lại, tra cứu phải
 * nhanh — mỗi lần refresh là một lần tra, còn bcrypt thì cố ý chậm.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export interface SessionContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/**
 * Sinh định danh cho một họ phiên mới — dùng khi đăng nhập.
 *
 * Phải sinh id TRƯỚC khi ký token, vì token mang `sid` còn hàng lưu hash của
 * chính token đó. Không có cách nào tránh thứ tự này: hash phụ thuộc token,
 * token phụ thuộc id.
 */
export const newFamily = (): { sessionId: string; familyId: string } => ({
  sessionId: randomUUID(),
  familyId: randomUUID(),
});

/** Ghi phiên sau khi đã ký được token — token mới có thể băm */
export async function record(input: {
  sessionId: string;
  familyId: string;
  userId: string;
  token: string;
  expiresAt: Date;
  ctx: SessionContext;
}): Promise<void> {
  await prisma.refreshSession.create({
    data: {
      id: input.sessionId,
      familyId: input.familyId,
      userId: input.userId,
      tokenHash: hashToken(input.token),
      expiresAt: input.expiresAt,
      ...(input.ctx.userAgent === undefined ? {} : { userAgent: input.ctx.userAgent }),
      ...(input.ctx.ipAddress === undefined ? {} : { ipAddress: input.ctx.ipAddress }),
    },
  });
}

export interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export const findById = (sessionId: string): Promise<SessionRow | null> =>
  prisma.refreshSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, familyId: true, tokenHash: true, expiresAt: true, revokedAt: true },
  });

/**
 * Thu hồi CẢ HỌ phiên.
 *
 * Gọi khi phát hiện tái sử dụng: một token đã bị thay thế mà vẫn được trình lại
 * nghĩa là đang tồn tại HAI bản sao, và ta không biết bản nào của người dùng
 * thật. Thu hồi cả họ buộc họ đăng nhập lại — bất tiện, nhưng đó là phản ứng
 * đúng khi có bằng chứng token bị nhân bản.
 */
export const revokeFamily = async (familyId: string): Promise<void> => {
  await prisma.refreshSession.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const revokeSession = async (sessionId: string): Promise<void> => {
  await prisma.refreshSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

/** Đánh dấu phiên cũ đã bị thay bởi phiên mới — dấu vết để lần lại cả họ */
export const markRotated = async (oldId: string, newId: string): Promise<void> => {
  await prisma.refreshSession.update({
    where: { id: oldId },
    data: { revokedAt: new Date(), replacedById: newId },
  });
};
