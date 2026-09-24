import { useCallback, useSyncExternalStore } from "react";

/**
 * Sáng/tối (DESIGN.md §7: đủ bộ token tối, chỉ đổi độ sáng). Mặc định theo hệ điều hành;
 * lựa chọn tay lưu ở localStorage — một sở thích hiển thị, không phải dữ liệu người dùng
 * hay token (§10.4 cấm hai thứ đó, không cấm cái này).
 */
type Theme = "light" | "dark";
const KEY = "udp_theme";
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  // jsdom và vài trình duyệt nhúng không có matchMedia dù kiểu DOM nói có
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
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

export function currentTheme(): Theme {
  return stored() ?? systemTheme();
}

export function applyTheme(theme: Theme = currentTheme()): void {
  document.documentElement.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
    (): Theme => "light",
  );
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage bị chặn: vẫn đổi cho phiên này
    }
    applyTheme(next);
    for (const l of listeners) l();
  }, []);
  return { theme, toggle };
}
