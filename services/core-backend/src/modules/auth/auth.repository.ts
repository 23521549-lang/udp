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
 */
export const findWithPasswordHash = (
  email: string,
): Promise<(PublicUser & { passwordHash: string }) | null> =>
  prisma.user.findUnique({
    where: { email },
    select: { ...PUBLIC_FIELDS, passwordHash: true },
  });

export const create = (data: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<PublicUser> =>
  prisma.user.create({
    data: { ...data, platformRole: "USER" },
    select: PUBLIC_FIELDS,
  });
