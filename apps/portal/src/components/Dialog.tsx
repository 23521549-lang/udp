import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Hộp thoại (DESIGN.md §6): Esc để đóng, focus vào hộp khi mở và trả về chỗ cũ khi
 * đóng, Tab không thoát ra khỏi hộp. Dùng `<dialog>` gốc thì jsdom chưa hỗ trợ
 * `showModal`, nên dựng bằng `div role="dialog"` với các hành vi đó tự làm.
 *
 * [Plan #58 UX-37] Thiết lập focus chạy MỘT lần lúc mở: `onClose` giữ trong ref, nên trang cha vẽ lại (danh sách tự
 * làm mới, nút bận) không kéo con trỏ về ô đầu nữa. `initialFocus="cancel"` cho hộp nguy hiểm: Enter lặp lại không
 * xác nhận nhầm. Mô tả nối vào hộp bằng `aria-describedby` để trình đọc màn hình đọc hậu quả.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
  drawer = false,
  initialFocus = "first",
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Ngăn kéo bên phải, cao hết màn — nội dung dài như trang Trợ giúp */
  drawer?: boolean;
  /** Ô đầu tiên (mặc định) hay nút Huỷ (`[data-close]`) nhận focus khi mở */
  initialFocus?: "first" | "cancel";
}) {
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const focusMode = useRef(initialFocus);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first =
      focusMode.current === "cancel"
        ? box?.querySelector<HTMLElement>("[data-close]")
        : box?.querySelector<HTMLElement>(
            "input, select, textarea, button:not([data-close])",
          );
    (first ?? box)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
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
      if (previous?.isConnected === true) previous.focus();
    };
  }, []);

  return (
    <>
      <div className="scrim on" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className={drawer ? "modal drawer on" : "modal on"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descId}
        tabIndex={-1}
        style={
          wide && !drawer
            ? { width: "min(640px, calc(100% - 32px))" }
            : undefined
        }
      >
        <div className="mh">
          <h2 id={titleId}>{title}</h2>
          {description !== undefined && <p id={descId}>{description}</p>}
        </div>
        {children !== undefined && <div className="mb">{children}</div>}
        {footer !== undefined && <div className="mf">{footer}</div>}
      </div>
    </>
  );
}
