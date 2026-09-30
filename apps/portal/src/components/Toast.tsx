import { X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { create } from "zustand";
import { useMessages } from "../i18n";
import { componentsMessages } from "./components.messages";
import { Icon } from "./Icon";

/**
 * Thông báo kiểu "viên thuốc tối giữa đáy" (DESIGN.md §6). Thao tác đảo ngược được thì
 * kèm nút "Hoàn tác" — hoàn tác thay vì hỏi lại (DESIGN.md §7).
 */
export interface ToastItem {
  id: number;
  text: string;
  tone: "info" | "error";
  undo?: () => void;
  action?: ToastAction;
}

/** [Plan #58 UX-9] Nút hành động của một thông báo, ví dụ "Xem kết quả" mở đúng chỗ vừa xảy ra việc */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastState {
  items: ToastItem[];
  push: (item: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastState>()((set) => ({
  items: [],
  push: (item) =>
    set((s) => ({ items: [...s.items.slice(-2), { ...item, id: ++seq }] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (text: string, undo?: () => void) =>
    useToasts
      .getState()
      .push(
        undo === undefined
          ? { text, tone: "info" }
          : { text, tone: "info", undo },
      ),
  error: (text: string) => useToasts.getState().push({ text, tone: "error" }),
  /** [Plan #58 UX-9] Thông báo kèm một nút hành động */
  action: (text: string, action: ToastAction) =>
    useToasts.getState().push({ text, tone: "info", action }),
};

/**
 * Thời gian hiện: lỗi 8 giây (một câu lỗi dài cần đọc hết), thông báo thường 4 giây. [Plan #58 UX-9] Thông báo có
 * nút (Hoàn tác, Xem) ở lại 20 giây — người đọc chậm hay dùng bàn phím vẫn bấm kịp (WCAG 2.2.1). Rê chuột hay focus
 * vào toast thì dừng đếm; toast ở lâu có nút đóng.
 */
export const LIFETIME_MS = { error: 8000, action: 20_000, info: 4000 } as const;

export function lifetimeOf(item: Pick<ToastItem, "tone" | "undo" | "action">) {
  if (item.undo !== undefined || item.action !== undefined) {
    return LIFETIME_MS.action;
  }
  return item.tone === "error" ? LIFETIME_MS.error : LIFETIME_MS.info;
}

function ToastView({ item }: { item: ToastItem }) {
  const m = useMessages(componentsMessages);
  const dismiss = useToasts((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(item.id), lifetimeOf(item));
    return () => clearTimeout(timer);
  }, [item, dismiss, paused]);
  const action =
    item.action ??
    (item.undo === undefined ? undefined : { label: m.undo, run: item.undo });
  return (
    <div
      className="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{item.text}</span>
      {action !== undefined && (
        <button
          type="button"
          onClick={() => {
            action.run();
            dismiss(item.id);
          }}
        >
          {action.label}
        </button>
      )}
      {lifetimeOf(item) > LIFETIME_MS.info && (
        <button
          type="button"
          className="toast-x"
          aria-label={m.dismissToast}
          onClick={() => dismiss(item.id)}
        >
          <Icon of={X} size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * [Plan #58 UX-9] Toast không che nội dung: chiều cao của chồng toast ghi vào `--toasts-h` trên `<html>`, và vùng
 * cuộn chừa đúng khoảng đó ở đáy (`ux-flag.css`) — dòng cuối và ô đang focus cuộn lên được phía trên toast.
 */
function useToastSpace(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      const h = el.offsetHeight;
      root.style.setProperty("--toasts-h", h === 0 ? "0px" : `${h + 28}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--toasts-h");
    };
  }, [ref]);
}

/**
 * [Plan #58 UX-9] Hai vùng đọc lên CỐ ĐỊNH (có sẵn trước khi toast xuất hiện, trình đọc màn hình mới bắt được): lỗi
 * đọc ngay, còn lại đọc khi rảnh. Mỗi toast không mang `role` riêng — trước đây vùng cha `aria-live` cộng `role` của
 * từng toast làm một câu bị đọc hai lần.
 */
export function Toaster() {
  const items = useToasts((s) => s.items);
  const ref = useRef<HTMLDivElement>(null);
  useToastSpace(ref);
  return (
    <div className="toasts" ref={ref}>
      <div className="toasts-live" aria-live="assertive">
        {items
          .filter((t) => t.tone === "error")
          .map((t) => (
            <ToastView key={t.id} item={t} />
          ))}
      </div>
      <div className="toasts-live" aria-live="polite">
        {items
          .filter((t) => t.tone !== "error")
          .map((t) => (
            <ToastView key={t.id} item={t} />
          ))}
      </div>
    </div>
  );
}
