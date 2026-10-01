import { defineMessages } from "../../i18n";

/**
 * [Plan #60 QĐ-10] Nhật ký thay đổi trên trang giới thiệu: chỉ việc ĐÃ có trong mã, ngày lấy từ lịch sử commit của
 * plan tương ứng (ghi ở chú thích từng mục). Mới nhất trước; trang hiện bốn mục đầu. Thêm mục khi một plan có thay
 * đổi người dùng thấy được — không thêm mục cho việc chưa làm.
 */
export interface ChangelogEntry {
  /** YYYY-MM-DD, ngày commit cuối của đợt */
  date: string;
  title: string;
  body: string;
}

export const changelogMessages = defineMessages({
  vi: {
    title: "Mới cập nhật",
    lead: "Những gì vừa có trong UDP, mới nhất trước.",
    entries: [
      // Plan #59, #60
      {
        date: "2026-10-01",
        title: "Trang giới thiệu, đăng nhập GitHub, quên mật khẩu",
        body: "Đăng ký có ô đồng ý Điều khoản; đặt lại mật khẩu qua email; đăng nhập bằng GitHub khi triển khai bật.",
      },
      // Plan #60 H3 (UX-23)
      {
        date: "2026-10-01",
        title: "Lý do rollout bằng ngôn ngữ của bạn",
        body: "Bộ điều phối trả mã và số đo; Portal nói vì sao giữ bậc, lên bậc hay tự lùi bằng tiếng Việt hoặc tiếng Anh.",
      },
      // Plan #58
      {
        date: "2026-10-01",
        title: "Dễ dùng hơn ở mọi màn",
        body: "Giải thích thuật ngữ tại chỗ, trợ giúp ở thanh bên, thẻ Bắt đầu cho project mới, bảng lệnh Ctrl K ở cả hai khung, đạt WCAG 2.2 AA.",
      },
      // Plan #57
      {
        date: "2026-09-30",
        title: "Sơ đồ kiến trúc của project",
        body: "Giao hàng, lưu lượng, environment, dữ liệu và quan sát trên một sơ đồ, kèm số deploy 14 ngày.",
      },
      // Plan #55
      {
        date: "2026-09-30",
        title: "Nhóm và lời mời bằng đường dẫn",
        body: "Mời đồng nghiệp bằng một đường dẫn, trao quyền cho cả nhóm trên nhiều project.",
      },
      // Plan #54
      {
        date: "2026-09-30",
        title: "Tiếng Anh và giao diện tối",
        body: "Portal có tiếng Việt và tiếng Anh; giao diện sáng, tối hoặc theo hệ thống.",
      },
    ] satisfies readonly ChangelogEntry[],
  },
  en: {
    title: "Recently shipped",
    lead: "What just landed in UDP, newest first.",
    entries: [
      {
        date: "2026-10-01",
        title: "Home page, GitHub sign-in, password reset",
        body: "Sign-up asks you to accept the Terms; reset your password by email; sign in with GitHub when the deployment enables it.",
      },
      {
        date: "2026-10-01",
        title: "Rollout reasons in your language",
        body: "The controller returns codes and numbers; the Portal explains why a step held, advanced or rolled back, in Vietnamese or English.",
      },
      {
        date: "2026-10-01",
        title: "Easier on every screen",
        body: "Inline term explanations, help in the sidebar, a Getting started card for new projects, Ctrl K in both shells, WCAG 2.2 AA.",
      },
      {
        date: "2026-09-30",
        title: "Project architecture diagram",
        body: "Delivery, traffic, environments, data and observability on one diagram, with 14 days of deploys.",
      },
      {
        date: "2026-09-30",
        title: "Teams and invite links",
        body: "Invite teammates with a link, and grant a whole team access across projects.",
      },
      {
        date: "2026-09-30",
        title: "English and dark mode",
        body: "The Portal speaks Vietnamese and English; light, dark or follow the system.",
      },
    ],
  },
});
