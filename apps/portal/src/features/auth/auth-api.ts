import {
  authOptionsResponseWire,
  authSessionResponseWire,
  meResponseWire,
  passwordForgotResponseWire,
} from "@udp/shared-types/wire";
import { API_BASE, api } from "../../lib/http";

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  name: string;
  /** [Plan #60 QĐ-6] Người dùng đã TÍCH ô đồng ý Điều khoản và Chính sách quyền riêng tư */
  acceptTerms: true;
}

export const authApi = {
  me: () => api(meResponseWire, "/auth/me"),
  login: (body: LoginInput) =>
    api(authSessionResponseWire, "/auth/login", { method: "POST", body }),
  register: (body: RegisterInput) =>
    api(authSessionResponseWire, "/auth/register", { method: "POST", body }),
  logout: () => api(null, "/auth/logout", { method: "POST" }),
  /** [Plan #60] Những cách đăng nhập mà triển khai này bật (công khai) */
  options: () => api(authOptionsResponseWire, "/auth/options"),
  /** [Plan #60 QĐ-7] Xin thư đặt lại mật khẩu — luôn "đã nhận" như nhau */
  forgot: (email: string) =>
    api(passwordForgotResponseWire, "/auth/password/forgot", {
      method: "POST",
      body: { email },
    }),
  reset: (token: string, password: string) =>
    api(null, "/auth/password/reset", {
      method: "POST",
      body: { token, password },
    }),
};

/**
 * [Plan #60 QĐ-8] Đường bắt đầu đăng nhập GitHub — một ĐIỀU HƯỚNG cả trang (không phải `fetch`): máy chủ đặt cookie
 * `state` rồi chuyển sang GitHub. `acceptTerms` chỉ đi kèm từ trang đăng ký, khi ô đồng ý đã được tích.
 */
export function githubStartUrl(opts: {
  intent: "login" | "register";
  acceptTerms?: boolean;
  redirectTo?: string | undefined;
}): string {
  const q = new URLSearchParams({ intent: opts.intent });
  if (opts.acceptTerms === true) q.set("acceptTerms", "1");
  if (opts.redirectTo !== undefined) q.set("redirectTo", opts.redirectTo);
  return `${API_BASE}/auth/github/start?${q.toString()}`;
}
