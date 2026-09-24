import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Hộp thoại (DESIGN.md §6): Esc để đóng, focus vào hộp khi mở và trả về chỗ cũ khi
 * đóng, Tab không thoát ra khỏi hộp. Dùng `<dialog>` gốc thì jsdom chưa hỗ trợ
 * `showModal`, nên dựng bằng `div role="dialog"` với các hành vi đó tự làm.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([data-close])",
    );
    (first ?? box)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || box === null) return;
      const nodes = [
        ...box.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
        ),
      ];
      const head = nodes[0];
      const tail = nodes[nodes.length - 1];
      if (head === undefined || tail === undefined) return;
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <>
      <div className="scrim on" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className="modal on"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={wide ? { width: "min(640px, calc(100% - 32px))" } : undefined}
      >
        <div className="mh">
          <h2 id={titleId}>{title}</h2>
          {description !== undefined && <p>{description}</p>}
        </div>
        {children !== undefined && <div className="mb">{children}</div>}
        {footer !== undefined && <div className="mf">{footer}</div>}
      </div>
    </>
  );
}
