import type { ReactNode } from "react";
import { defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/** Chữ của trang đăng nhập và đăng ký */
export const authMessages = defineMessages({
  vi: {
    signIn: "Đăng nhập",
    signingIn: "Đang đăng nhập…",
    register: "Tạo tài khoản",
    registering: "Đang tạo…",
    registerLink: "Đăng ký",
    email: "Email",
    password: "Mật khẩu",
    name: "Tên",
    /** [Plan #58 UX-24] Luật nói trước; lỗi nói cách sửa */
    passwordHint: (min: number) => `Ít nhất ${formatNumber(min)} ký tự.`,
    passwordShort: (min: number) =>
      `Mật khẩu cần ít nhất ${formatNumber(min)} ký tự. Thêm ký tự rồi thử lại.`,
    nameRequired: "Nhập tên để đồng nghiệp nhận ra bạn.",
    emailInvalid: "Nhập email đầy đủ, ví dụ ten@congty.vn.",
    noAccount: (link: ReactNode) => <>Chưa có tài khoản? {link}</>,
    haveAccount: (link: ReactNode) => <>Đã có tài khoản? {link}</>,
  },
  en: {
    signIn: "Sign in",
    signingIn: "Signing in…",
    register: "Create account",
    registering: "Creating…",
    registerLink: "Sign up",
    email: "Email",
    password: "Password",
    name: "Name",
    passwordHint: (min: number) => `At least ${formatNumber(min)} characters.`,
    passwordShort: (min: number) =>
      `Your password needs at least ${formatNumber(min)} characters. Add more and try again.`,
    nameRequired: "Enter your name so teammates can recognize you.",
    emailInvalid: "Enter a full email address, for example name@company.com.",
    noAccount: (link: ReactNode) => <>No account yet? {link}</>,
    haveAccount: (link: ReactNode) => <>Already have an account? {link}</>,
  },
});
