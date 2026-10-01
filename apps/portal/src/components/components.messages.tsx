import type { ReactNode } from "react";
import { defineMessages } from "../i18n";

/** Chữ của các component dùng chung */
export const componentsMessages = defineMessages({
  vi: {
    loading: "Đang tải…",
    retry: "Thử lại",
    cancel: "Huỷ",
    working: "Đang thực hiện…",
    typeToConfirm: (value: ReactNode) => <>Gõ {value} để xác nhận</>,
    undo: "Hoàn tác",
    dismissToast: "Đóng thông báo",
    copy: "Sao chép",
    copied: "Đã sao chép",
    copyFailed: "Không sao chép được, hãy chọn và chép tay",
    showPassword: "Hiện mật khẩu",
    prevPage: "Trang trước",
    nextPage: "Trang sau",
    unsaved: {
      title: "Bỏ thay đổi chưa lưu?",
      description: (what: string) => `${what} chưa lưu sẽ mất nếu rời chỗ này.`,
      confirm: "Bỏ thay đổi",
    },
    chart: {
      role: "biểu đồ",
      keyboardHint: (title: string) =>
        `${title}. Dùng phím mũi tên để đọc từng thời điểm.`,
      noData: "không có dữ liệu",
      empty: "Chưa có dữ liệu",
      aboveFrame: ", cao hơn khung",
      table: "Bảng số liệu",
      time: "Thời điểm",
      logScale: "thang log",
      csv: "Tải CSV",
    },
    diagram: {
      asTable: "Xem dạng bảng",
      asDiagram: "Xem dạng sơ đồ",
    },
  },
  en: {
    loading: "Loading…",
    retry: "Retry",
    cancel: "Cancel",
    working: "Working…",
    typeToConfirm: (value: ReactNode) => <>Type {value} to confirm</>,
    undo: "Undo",
    dismissToast: "Dismiss notification",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Could not copy. Select the text and copy it manually",
    showPassword: "Show password",
    prevPage: "Previous page",
    nextPage: "Next page",
    unsaved: {
      title: "Discard unsaved changes?",
      description: (what: string) =>
        `Unsaved ${what} will be lost if you leave.`,
      confirm: "Discard changes",
    },
    chart: {
      role: "chart",
      keyboardHint: (title: string) =>
        `${title}. Use the arrow keys to read each point in time.`,
      noData: "no data",
      empty: "No data yet",
      aboveFrame: ", above the frame",
      table: "Data table",
      time: "Time",
      logScale: "log scale",
      csv: "Download CSV",
    },
    diagram: {
      asTable: "View as table",
      asDiagram: "View as diagram",
    },
  },
});
