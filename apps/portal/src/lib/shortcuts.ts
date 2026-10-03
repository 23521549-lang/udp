import { create } from "zustand";

/**
 * [Plan #58 UX-40] Phím tắt MỘT phím (`c` tạo flag, `j`/`k` di chuyển, `1`–`9` đổi environment) tắt được — WCAG
 * 2.1.4: người dùng nhập bằng giọng nói có thể vô tình kích hoạt chúng, kể cả đổi sang production. Mặc định BẬT (hành
 * vi cũ); lựa chọn lưu ở localStorage như giao diện và ngôn ngữ — một sở thích hiển thị, không phải dữ liệu người dùng.
 * Ctrl K không thuộc diện này (có phím bổ trợ).
 */

const KEY = "udp_shortcuts";

function initial(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

interface ShortcutState {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

export const useShortcutStore = create<ShortcutState>()((set) => ({
  enabled: initial(),
  setEnabled: (on) => {
    try {
      if (on) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "off");
    } catch {
      // localStorage bị chặn: lựa chọn chỉ sống trong phiên này
    }
    set({ enabled: on });
  },
}));

/** Phím tắt một phím có đang bật không — trình nghe phím đọc giá trị này trước khi xử lý */
export const useShortcutsEnabled = (): boolean =>
  useShortcutStore((s) => s.enabled);
