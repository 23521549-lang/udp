import { defineMessages } from "../i18n";

/**
 * [Plan #58] Chữ của phần khung chung được thêm khi tối ưu UX: nhóm menu project (UX-25), trợ giúp (UX-21), tiêu đề
 * thẻ trình duyệt (UX-31), công tắc phím tắt (UX-40), menu điện thoại (UX-38).
 */
export const shellUxMessages = defineMessages({
  vi: {
    navGroup: {
      release: "Phát hành",
      platform: "Hạ tầng",
    },
    help: {
      open: "Trợ giúp",
      title: "Trợ giúp",
      close: "Đóng trợ giúp",
      lead: "Giải thích các từ hay gặp và các bước để bắt đầu. Mở lại bất cứ lúc nào từ nút Trợ giúp.",
      searchLabel: "Tìm thuật ngữ",
      searchPlaceholder: "Ví dụ: rollout, drift, khoá SDK…",
      noMatch: "Không có thuật ngữ nào khớp.",
      guidesTitle: "Bắt đầu nhanh",
      guides: [
        {
          title: "Bật một tính năng cho một nhóm người dùng",
          steps: [
            "Vào Flag, bấm Tạo flag và đặt key.",
            "Tạo khoá SDK ở Cài đặt, cài SDK vào ứng dụng.",
            "Thêm luật: ai nhận giá trị nào. Bấm Kích hoạt để SDK thấy flag.",
          ],
        },
        {
          title: "Phát hành dần và tự lùi lại khi lỗi",
          steps: [
            "Bật Monitoring ở trang Domain để UDP đọc được số đo.",
            "Ở một flag, bấm Phát hành dần: chọn các bậc phần trăm và ngưỡng lỗi.",
            "UDP lên từng bậc khi số đo trong ngưỡng, tự lùi lại khi vượt.",
          ],
        },
        {
          title: "Dựng hạ tầng trên cloud của bạn",
          steps: [
            "Ở Cài đặt › Cloud, kết nối tài khoản cloud theo các bước có sẵn.",
            "Chọn domain (công cụ hạ tầng) cần dùng; gói Khuyến nghị cho người mới là điểm bắt đầu tốt.",
            "Xem trước chi phí rồi bấm Bắt đầu dựng; theo dõi từng bước ở trang Hạ tầng.",
          ],
        },
      ],
    },
    title: {
      suffix: "UDP",
    },
    shortcuts: {
      label: "Phím tắt một phím",
      on: "Bật",
      off: "Tắt",
      hint: "C tạo flag, J/K di chuyển, 1–9 đổi environment. Tắt nếu bạn dùng nhập bằng giọng nói.",
    },
    closeMenu: "Đóng menu",
  },
  en: {
    navGroup: {
      release: "Release",
      platform: "Infrastructure",
    },
    help: {
      open: "Help",
      title: "Help",
      close: "Close help",
      lead: "Plain explanations of common terms and the steps to get started. Open it again any time from the Help button.",
      searchLabel: "Find a term",
      searchPlaceholder: "For example: rollout, drift, SDK key…",
      noMatch: "No term matches.",
      guidesTitle: "Quick start",
      guides: [
        {
          title: "Turn a feature on for a group of users",
          steps: [
            "Open Flags, click Create flag and choose a key.",
            "Create an SDK key in Settings and install the SDK in your app.",
            "Add rules for who gets which value. Click Activate so the SDK sees the flag.",
          ],
        },
        {
          title: "Roll out gradually and roll back on errors",
          steps: [
            "Enable Monitoring on the Domains page so UDP can read metrics.",
            "On a flag, click Roll out gradually: choose percentage steps and an error threshold.",
            "UDP moves up a step while metrics stay within the threshold and rolls back when they don't.",
          ],
        },
        {
          title: "Provision infrastructure on your cloud",
          steps: [
            "In Settings › Cloud, connect your cloud account with the guided steps.",
            "Choose the domains (infrastructure tools) you need; the starter set is a good default.",
            "Review the cost preview, click Start and follow each step on the Infrastructure page.",
          ],
        },
      ],
    },
    title: {
      suffix: "UDP",
    },
    shortcuts: {
      label: "Single-key shortcuts",
      on: "On",
      off: "Off",
      hint: "C creates a flag, J/K move, 1–9 switch environments. Turn off if you use voice input.",
    },
    closeMenu: "Close menu",
  },
});
