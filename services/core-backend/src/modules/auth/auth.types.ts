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
    /**
      * Đếm BYTE, không đếm ký tự.
      *
      * bcrypt cắt âm thầm mọi thứ sau byte thứ 72, còn `String.length` đếm code
      * unit UTF-16. Đã đo: 72 ký tự tiếng Việt = 114 byte, nên bcrypt chỉ thấy
      * 46 ký tự đầu — hai mật khẩu khác nhau từ ký tự 47 sẽ đăng nhập được cho
      * nhau. Đúng kịch bản mà chú thích của `AUTH.passwordMaxLength` nói nó đã
      * chặn, nhưng `.max()` trên chuỗi thì không chặn được.
      */
     .refine(
       (value) => Buffer.byteLength(value, "utf8") <= AUTH.passwordMaxLength,
       `Mật khẩu tối đa ${AUTH.passwordMaxLength} byte (chữ có dấu tính nhiều hơn một byte)`,
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
  /** Họ phiên — controller cần để dẫn xuất token CSRF ổn định suốt phiên */
  familyId: string;
}
