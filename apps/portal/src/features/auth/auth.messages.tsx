import type { ReactNode } from "react";
import { defineMessages } from "../../i18n";

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
    noAccount: (link: ReactNode) => <>No account yet? {link}</>,
    haveAccount: (link: ReactNode) => <>Already have an account? {link}</>,
  },
});
