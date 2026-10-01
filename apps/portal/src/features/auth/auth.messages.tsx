import type { ReactNode } from "react";
import { defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

const n = formatNumber;

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
    /** [Plan #59] Logo ở góc trên dẫn về trang giới thiệu */
    home: "UDP, về trang giới thiệu",
    registerLead:
      "Miễn phí trong giai đoạn thử nghiệm. Không cần thẻ thanh toán.",
    aside: {
      title: "Khi đăng ký, bạn có",
      items: (domains: number, tools: number) => [
        `Đủ ${n(domains)} domain và ${n(tools)} công cụ DevOps, miễn phí trong giai đoạn thử nghiệm.`,
        "Hạ tầng dựng trong tài khoản AWS, Google Cloud hoặc Azure của chính bạn.",
        "Feature flag theo chuẩn OpenFeature, phát hành từng bậc và tự lùi khi số đo xấu.",
      ],
      shotAlt:
        "Sơ đồ Kiến trúc của một project trong Portal UDP: CI/CD, registry, GitOps và Progressive Delivery nối với nhau.",
    },
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
    home: "UDP, back to the home page",
    registerLead: "Free during the beta. No credit card needed.",
    aside: {
      title: "What you get",
      items: (domains: number, tools: number) => [
        `All ${n(domains)} domains and ${n(tools)} DevOps tools, free during the beta.`,
        "Infrastructure built in your own AWS, Google Cloud or Azure account.",
        "Feature flags on the OpenFeature standard, stepped rollouts with automatic rollback.",
      ],
      shotAlt:
        "The Architecture diagram of a project in the UDP Portal: CI/CD, registry, GitOps and Progressive Delivery connected.",
    },
  },
});
