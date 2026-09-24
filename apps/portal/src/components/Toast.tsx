import { useEffect } from "react";
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

function ToastView({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.undo ? 5000 : 4000);
    return () => clearTimeout(timer);
  }, [item, dismiss]);
  return (
    <div className="toast" role={item.tone === "error" ? "alert" : "status"}>
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
