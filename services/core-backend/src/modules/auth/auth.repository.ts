import type { IdentityProvider, Prisma } from "@udp/db";
import { prisma } from "../../core/db.js";
import type { PublicUser } from "./auth.types.js";

/**
 * Tầng truy cập dữ liệu cho auth.
 *
 * Vì sao tách khỏi service dù chỉ có bốn hàm: `select` được khai báo MỘT chỗ.
 * Nếu mỗi hàm trong service tự viết `select` riêng, sớm muộn sẽ có chỗ quên và
 * `passwordHash` lọt ra API. Ở đây `PUBLIC_FIELDS` là hàng rào duy nhất, và bất
 * kỳ ai sửa nó đều thấy ngay hậu quả.
 */
const PUBLIC_FIELDS = {
  id: true,
  email: true,
  name: true,
  platformRole: true,
} as const;

export const findPublicById = (id: string): Promise<PublicUser | null> =>
  prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });

export const findPublicByEmail = (email: string): Promise<PublicUser | null> =>
  prisma.user.findUnique({ where: { email }, select: PUBLIC_FIELDS });

/**
 * Hàm DUY NHẤT trả về `passwordHash`. Tên hàm nói rõ điều đó để việc dùng nhầm
 * trở nên khó, và để tìm mọi nơi chạm vào hash chỉ cần grep một chuỗi.
 * [v4.12] `null` = tài khoản tạo bằng GitHub, chưa đặt mật khẩu.
 */
export const findWithPasswordHash = (
  email: string,
): Promise<(PublicUser & { passwordHash: string | null }) | null> =>
  prisma.user.findUnique({
    where: { email },
    select: { ...PUBLIC_FIELDS, passwordHash: true },
  });

/** [v4.12, Plan #60 QĐ-6] Đồng ý Điều khoản đi cùng lúc tạo: phiên bản hiện hành và thời điểm */
export interface TermsConsent {
  termsVersion: string;
  termsAcceptedAt: Date;
}

export const create = (
  data: { email: string; name: string; passwordHash: string } & TermsConsent,
): Promise<PublicUser> =>
  prisma.user.create({
    data: { ...data, platformRole: "USER" },
    select: PUBLIC_FIELDS,
  });

// --------------------------------------------------------------- danh tính ngoài

/** [v4.12, Plan #60 QĐ-8] Người đã liên kết danh tính này (khoá theo id bất biến của nhà cung cấp) */
export const findByIdentity = async (
  provider: IdentityProvider,
  providerUserId: string,
): Promise<PublicUser | null> =>
  (
    await prisma.userIdentity.findUnique({
      where: { provider_providerUserId: { provider, providerUserId } },
      select: { user: { select: PUBLIC_FIELDS } },
    })
  )?.user ?? null;

/** Tài khoản mới tạo bằng danh tính ngoài: chưa có mật khẩu, liên kết ghi cùng transaction */
export const createWithIdentity = (
  data: { email: string; name: string } & TermsConsent,
  identity: { provider: IdentityProvider; providerUserId: string },
): Promise<PublicUser> =>
  prisma.user.create({
    data: {
      ...data,
      passwordHash: null,
      platformRole: "USER",
      identities: { create: identity },
    },
    select: PUBLIC_FIELDS,
  });

// --------------------------------------------------------------- đặt lại mật khẩu

/**
 * [v4.12, Plan #60 QĐ-7] Token mới thay MỌI token chưa dùng của người đó (đánh dấu đã dùng) trong cùng transaction:
 * chỉ thư mới nhất mở được, thư cũ nằm trong hộp thư không còn là chìa khoá.
 */
export const issueResetToken = (
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<unknown> =>
  prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash, expiresAt },
      select: { id: true },
    }),
  ]);

/**
 * Dùng token MỘT lần: đánh dấu đã dùng bằng một `UPDATE … WHERE used_at IS NULL AND expires_at > now`, rồi đặt mật
 * khẩu mới và ghi nhật ký — cùng một transaction. Hai lần bấm cùng lúc thì chỉ một lần thấy 1 hàng. Trả id người dùng, hay
 * `null` khi token không còn dùng được (sai, đã dùng, hết hạn — không phân biệt cho người gọi).
 */
export const consumeResetToken = (
  tokenHash: string,
  passwordHash: string,
  audit: (userId: string) => Prisma.AuditLogUncheckedCreateInput,
): Promise<string | null> =>
  prisma.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count === 0) return null;
    const { userId } = await tx.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { userId: true },
    });
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    // Sự kiện an ninh của tài khoản, không của project nào (`project_id` NULL như đổi vai nền tảng)
    await tx.auditLog.create({ data: audit(userId), select: { id: true } });
    return userId;
  });
