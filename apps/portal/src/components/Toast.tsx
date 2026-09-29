import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * Thông báo kiểu "viên thuốc tối giữa đáy" (DESIGN.md §6). Thao tác đảo ngược được thì
 * kèm nút "Hoàn tác" trong 5 giây — hoàn tác thay vì hỏi lại (DESIGN.md §7).
 */
export interface ToastItem {
  id: number;
  text: string;
  tone: "info" | "error";
  undo?: () => void;
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
};

/**
 * Thời gian hiện: lỗi lâu nhất (người dùng cần đọc hết một câu lỗi dài), có Hoàn tác đúng 5 giây của
 * DESIGN.md §7, còn lại 4 giây. Rê chuột hay focus vào toast thì dừng đếm — không ai đọc kịp một
 * lỗi đang biến mất dưới tay mình.
 */
const LIFETIME_MS = { error: 8000, undo: 5000, info: 4000 } as const;

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const ms =
      item.tone === "error"
        ? LIFETIME_MS.error
        : item.undo
          ? LIFETIME_MS.undo
          : LIFETIME_MS.info;
    const timer = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(timer);
  }, [item, dismiss, paused]);
  return (
    <div
      className="toast"
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{item.text}</span>
      {item.undo !== undefined && (
        <button
          type="button"
          onClick={() => {
            item.undo?.();
            dismiss(item.id);
          }}
        >
          Hoàn tác
        </button>
      )}
    </div>
  );
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
