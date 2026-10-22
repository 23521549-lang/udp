import { useCallback, useSyncExternalStore } from "react";

/**
 * Sáng/tối (DESIGN.md §7: đủ bộ token tối, chỉ đổi độ sáng). [Plan #54 QĐ-3] Ba lựa chọn: Sáng, Tối và
 * Theo hệ thống. "Theo hệ thống" là KHÔNG lưu gì — cùng luật với `public/theme-boot.js` (có lưu thì theo,
 * không thì theo hệ điều hành) — và khi đó trang đổi ngay lúc hệ điều hành đổi, không cần tải lại. Lựa chọn
 * tay lưu ở localStorage: một sở thích hiển thị, không phải dữ liệu người dùng hay token (§10.4 cấm hai thứ
 * đó, không cấm cái này).
 */
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const KEY = "udp_theme";
const QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  // jsdom và vài trình duyệt nhúng không có matchMedia dù kiểu DOM nói có
  try {
    return window.matchMedia(QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function stored(): Theme | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : undefined;
  } catch {
    return undefined;
  }
}

export const themePreference = (): ThemePreference => stored() ?? "system";

export function currentTheme(): Theme {
  return stored() ?? systemTheme();
}

/**
 * Đặt `data-theme` và cho `<meta name="theme-color">` (thanh địa chỉ trên điện thoại) đúng màu nền
 * `--bg` của giao diện vừa áp — đọc từ token, không ghi màu thô vào mã.
 */
export function applyTheme(theme: Theme = currentTheme()): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg !== "") {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", bg);
  }
}

function notify(): void {
  for (const l of listeners) l();
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // storage bị chặn: vẫn đổi cho phiên này
  }
  applyTheme(preference === "system" ? systemTheme() : preference);
  notify();
}

/**
 * Theo hệ điều hành lúc đang mở trang: gọi MỘT lần lúc khởi động. Chỉ đổi khi người dùng đang ở "Theo hệ
 * thống" — lựa chọn tay luôn thắng.
 */
export function watchSystemTheme(): void {
  try {
    window.matchMedia(QUERY).addEventListener("change", () => {
      if (stored() !== undefined) return;
      applyTheme(systemTheme());
      notify();
    });
  } catch {
    // không có matchMedia: không có gì để theo
  }
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Đổi nhanh sáng ↔ tối (bảng lệnh) — là một lựa chọn tay */
  toggle: () => void;
} {
  const theme = useSyncExternalStore(
    subscribe,
    currentTheme,
    (): Theme => "light",
  );
  const preference = useSyncExternalStore(
    subscribe,
    themePreference,
    (): ThemePreference => "system",
  );
  const toggle = useCallback(() => {
    setThemePreference(currentTheme() === "dark" ? "light" : "dark");
  }, []);
  return { theme, preference, setPreference: setThemePreference, toggle };
}
