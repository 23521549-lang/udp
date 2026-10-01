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
    /** [Plan #60] Quên mật khẩu, đăng nhập GitHub, đồng ý Điều khoản */
    forgotLink: "Quên mật khẩu?",
    github: "Tiếp tục với GitHub",
    or: "hoặc",
    consent: (terms: ReactNode, privacy: ReactNode) => (
      <>
        Tôi đồng ý với {terms} và {privacy} của UDP.
      </>
    ),
    termsLink: "Điều khoản sử dụng",
    privacyLink: "Chính sách quyền riêng tư",
    consentRequired: "Tích ô này để tạo tài khoản.",
    resetDone: "Đã đổi mật khẩu. Đăng nhập bằng mật khẩu mới.",
    oauth: {
      email_taken:
        "Email của tài khoản GitHub này đã có tài khoản UDP. Đăng nhập bằng mật khẩu, hoặc dùng Quên mật khẩu.",
      no_account:
        "Chưa có tài khoản UDP gắn với GitHub này. Tích ô đồng ý bên dưới rồi tiếp tục với GitHub để tạo.",
      no_email:
        "Tài khoản GitHub chưa có email chính đã xác minh. Xác minh email trên GitHub rồi thử lại.",
      denied: "Bạn đã huỷ đăng nhập bằng GitHub.",
      failed: "Không đăng nhập được bằng GitHub. Thử lại sau ít phút.",
    },
    forgot: {
      title: "Quên mật khẩu",
      lead: "Nhập email đã đăng ký. UDP gửi đường dẫn đặt lại, dùng được một lần trong 30 phút.",
      submit: "Gửi đường dẫn",
      sending: "Đang gửi…",
      sentTitle: "Kiểm tra hộp thư",
      sent: (email: ReactNode) => (
        <>
          Nếu {email} có tài khoản UDP, thư đặt lại mật khẩu đang trên đường
          tới. Không thấy thì xem cả mục thư rác.
        </>
      ),
      back: "Về trang đăng nhập",
    },
    reset: {
      title: "Đặt mật khẩu mới",
      password: "Mật khẩu mới",
      submit: "Đổi mật khẩu",
      saving: "Đang lưu…",
      missingToken:
        "Đường dẫn thiếu mã đặt lại. Mở lại đường dẫn trong thư, hoặc xin thư mới.",
      requestNew: "Xin thư mới",
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
    forgotLink: "Forgot password?",
    github: "Continue with GitHub",
    or: "or",
    consent: (terms: ReactNode, privacy: ReactNode) => (
      <>
        I agree to the UDP {terms} and {privacy}.
      </>
    ),
    termsLink: "Terms of Service",
    privacyLink: "Privacy Policy",
    consentRequired: "Tick this box to create an account.",
    resetDone: "Password changed. Sign in with your new password.",
    oauth: {
      email_taken:
        "The email of this GitHub account already has a UDP account. Sign in with your password, or use Forgot password.",
      no_account:
        "No UDP account is linked to this GitHub account yet. Tick the box below, then continue with GitHub to create one.",
      no_email:
        "This GitHub account has no verified primary email. Verify an email on GitHub and try again.",
      denied: "You cancelled signing in with GitHub.",
      failed: "Could not sign in with GitHub. Try again in a few minutes.",
    },
    forgot: {
      title: "Forgot password",
      lead: "Enter the email you signed up with. UDP sends a reset link that works once, for 30 minutes.",
      submit: "Send link",
      sending: "Sending…",
      sentTitle: "Check your inbox",
      sent: (email: ReactNode) => (
        <>
          If {email} has a UDP account, a reset email is on its way. If you do
          not see it, check your spam folder.
        </>
      ),
      back: "Back to sign in",
    },
    reset: {
      title: "Choose a new password",
      password: "New password",
      submit: "Change password",
      saving: "Saving…",
      missingToken:
        "The link is missing its reset code. Open the link from the email again, or request a new one.",
      requestNew: "Request a new email",
    },
  },
});
