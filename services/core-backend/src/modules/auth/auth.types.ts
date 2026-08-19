import { z } from "zod";
import { AUTH } from "@udp/config";
import type { PlatformRole } from "@udp/db";

export const registerSchema = z.object({
  email: z.string().email("Email không hợp lệ").trim().toLowerCase(),
  password: z
    .string()
    .min(
      AUTH.passwordMinLength,
      `Mật khẩu tối thiểu ${AUTH.passwordMinLength} ký tự`,
    )
    .max(
      AUTH.passwordMaxLength,
      `Mật khẩu tối đa ${AUTH.passwordMaxLength} ký tự`,
    ),
  name: z.string().trim().min(1, "Tên không được để trống").max(255),
});

export const loginSchema = z.object({
  email: z.string().email("Email không hợp lệ").trim().toLowerCase(),
  password: z.string().min(1, "Chưa nhập mật khẩu"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Hình dạng user trả ra ngoài.
 *
 * Khai báo tường minh thay vì trả thẳng bản ghi Prisma: nếu sau này schema thêm
 * cột nhạy cảm, nó sẽ KHÔNG tự động lọt ra API. Đây là khác biệt giữa "quên
 * loại bỏ" và "phải chủ động thêm vào".
 */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  platformRole: PlatformRole;
}

export interface AuthResult {
  user: PublicUser;
  tokens: { accessToken: string; refreshToken: string };
}
