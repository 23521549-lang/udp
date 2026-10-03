import { z } from "zod";
import { AUTH } from "@udp/config";
import type { PlatformRole } from "@udp/db";

/** Luật mật khẩu dùng chung cho đăng ký và đặt lại (Plan #60 QĐ-7) */
const passwordRule = z
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
  );

const emailRule = z.string().email("Email không hợp lệ").trim().toLowerCase();

export const registerSchema = z.object({
  email: emailRule,
  password: passwordRule,
  name: z.string().trim().min(1, "Tên không được để trống").max(255),
  /**
   * [v4.12, Plan #60 QĐ-6] Người đăng ký TÍCH ô đồng ý Điều khoản và Chính sách quyền riêng tư. Nghị định 13/2023/NĐ-CP:
   * im lặng không phải đồng ý, nên thiếu trường là 400, không mặc định. Máy chủ ghi phiên bản hiện hành (`LEGAL`),
   * không tin phiên bản do client gửi.
   */
  acceptTerms: z.literal(true, {
    errorMap: () => ({
      message:
        "Cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản",
    }),
  }),
});

export const loginSchema = z.object({
  email: emailRule,
  password: z.string().min(1, "Chưa nhập mật khẩu"),
});

/** [v4.12, Plan #60 QĐ-7] Xin thư đặt lại mật khẩu */
export const forgotPasswordSchema = z.object({ email: emailRule });

/** [v4.12, Plan #60 QĐ-7] Đặt mật khẩu mới bằng token trong thư */
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordRule,
});

/**
 * [v4.12, Plan #60 QĐ-8] Bắt đầu đăng nhập GitHub. `intent=register` kèm `acceptTerms=1` là người dùng đã tích ô đồng ý
 * ở trang đăng ký: chỉ khi đó lần quay về mới được TẠO tài khoản. `redirectTo` đi qua `safeRedirect` lúc quay về.
 */
export const githubStartQuerySchema = z.object({
  intent: z.enum(["login", "register"]).default("login"),
  acceptTerms: z.literal("1").optional(),
  redirectTo: z.string().max(500).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type GithubStartQuery = z.infer<typeof githubStartQuerySchema>;

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
