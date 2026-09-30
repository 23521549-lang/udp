import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  glossaryMessages,
  type TermKey,
} from "../features/help/glossary.messages";
import { useMessages } from "../i18n";
import { Icon } from "./Icon";

/**
 * [Plan #58 UX-19] Giải thích một thuật ngữ ngay tại chỗ. Mở bằng BẤM (không phải rê chuột), nên dùng được trên điện
 * thoại và bằng bàn phím; Esc hay bấm ra ngoài thì đóng và trả focus về nút. Không thay nhãn: nhãn vẫn là chữ thường,
 * nút này chỉ là lối "tôi chưa hiểu từ này" (NN/g: tooltip chỉ chứa thông tin phụ, không chứa lỗi hay điều bắt buộc).
 *
 * Mặc định đọc từ bảng thuật ngữ (`term`); `title` + `children` cho lời giải thích riêng của một màn.
 */
export function InfoTip({
  term,
  title,
  children,
}: {
  term?: TermKey;
  title?: string;
  children?: ReactNode;
}) {
  const m = useMessages(glossaryMessages);
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const entry = term === undefined ? undefined : m.term[term];
  const name = title ?? entry?.name ?? "";
  const body = children ?? entry?.def;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: PointerEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <span className="infotip" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="infotip-btn"
        aria-label={m.explain(name)}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          // Nút nằm trong nhãn hay trong link: mở giải thích không được bấm luôn cái bọc ngoài
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon of={Info} size={14} />
      </button>
      {open && (
        <span id={id} className="infotip-pop" role="note">
          <b>{name}</b>
          <span>{body}</span>
        </span>
      )}
    </span>
  );
}
