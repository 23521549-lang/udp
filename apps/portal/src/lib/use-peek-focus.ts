import { useEffect, useRef, type RefObject } from "react";

/**
 * [Plan #58 UX-38] Focus của một panel bên (`.peek`): trên màn hẹp panel phủ cả màn, nên khi mở thì focus VÀO panel,
 * Esc thì đóng, và khi đóng thì focus TRẢ về phần tử đã mở nó (nếu còn trên trang) thay vì rơi về `<body>`
 * (WCAG 2.4.3, 2.4.11). Một hook cho mọi panel: Kiến trúc, Segment, chi tiết flag.
 *
 * `key` đổi khi panel chuyển sang đối tượng khác (bấm công cụ khác) — focus vào lại panel mới.
 */
export function usePeekFocus(
  panel: RefObject<HTMLElement | null>,
  key: string | undefined,
  onClose: () => void,
): void {
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (key === undefined) return;
    if (opener.current === null) {
      const active = document.activeElement;
      opener.current =
        active instanceof HTMLElement && !panel.current?.contains(active)
          ? active
          : null;
    }
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, panel]);

  useEffect(() => {
    if (key !== undefined) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected === true) target.focus();
  }, [key]);
}
