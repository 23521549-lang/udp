import { Search, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useMessages } from "../i18n";
import { componentsMessages } from "./components.messages";
import { Icon } from "./Icon";

/**
 * [Plan #60 H4] Khuôn bảng lệnh Ctrl K DÙNG CHUNG cho hai khung (Portal: flag, rollout, lệnh của project; Bảng điều
 * khiển: trang, project, người dùng). Mỗi khung chỉ khai NGUỒN mục; hộp thoại, bàn phím và trợ năng ở một chỗ
 * (DESIGN.md §6, §7): ô gõ giữ focus (combobox + `aria-activedescendant`), mũi tên chọn, Enter chạy, Esc đóng, Tab không
 * lọt ra trang phía sau, đóng thì trả focus về chỗ đã mở.
 *
 * Ctrl K không phải đường DUY NHẤT: nút "Tìm nhanh" của thanh bên mở cùng bảng, nên người mà trình duyệt hay trình đọc
 * màn hình giữ Ctrl K vẫn tới được mọi lệnh.
 */

export interface PaletteItem {
  /** Tên nhóm đã dịch — các mục liền nhau cùng tên gộp thành một nhóm của listbox */
  group: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Phím tắt một phím của lệnh ("C", "1"), hiện trong `kbd` */
  shortcut?: string | undefined;
  /** Nhãn là DỮ LIỆU (key flag, tên project, email): không để trình duyệt dịch */
  literal?: boolean | undefined;
  run: () => void;
}

/** Lọc không phân biệt hoa thường và dấu — gõ "thanh toan" tìm được "Thanh toán" */
export function matchItems(items: PaletteItem[], query: string): PaletteItem[] {
  const fold = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
  const q = fold(query.trim());
  return q === ""
    ? items
    : items.filter((i) => fold(`${i.label} ${i.hint}`).includes(q));
}

/** Mở/đóng dùng chung của hai khung: phím Ctrl K và nút "Tìm nhanh" (thanh bên); hai khung không bao giờ cùng mở */
export const usePaletteStore = create<{
  open: boolean;
  setOpen: (v: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

export function useCtrlK(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        const s = usePaletteStore.getState();
        s.setOpen(!s.open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

export function CommandPaletteView({
  idPrefix,
  items,
  query,
  onQuery,
  onClose,
  searchLabel,
  placeholder,
}: {
  /** Tiền tố id của các lựa chọn — hai khung khác nhau để id không trùng khi chuyển khung */
  idPrefix: string;
  items: PaletteItem[];
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
  searchLabel: string;
  placeholder: string;
}) {
  const m = useMessages(componentsMessages).palette;
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const current = Math.min(sel, Math.max(0, items.length - 1));
  const listId = `${idPrefix}-list`;
  /** Các đoạn liên tiếp cùng nhóm — mỗi đoạn là một `role="group"` có tên trong listbox */
  const sections = items.reduce<
    { group: string; start: number; items: PaletteItem[] }[]
  >((acc, item, i) => {
    const last = acc[acc.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else acc.push({ group: item.group, start: i, items: [item] });
    return acc;
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    try {
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    } catch {
      // jsdom không có scrollIntoView dù kiểu DOM nói có; trình duyệt thật thì có
    }
  }, [current]);

  const runAt = (i: number): void => {
    const item = items[i];
    if (item === undefined) return;
    onClose();
    item.run();
  };

  return (
    <>
      <div className="scrim on" onClick={onClose} aria-hidden="true" />
      <div
        className="pal on"
        role="dialog"
        aria-modal="true"
        aria-label={m.title}
        onKeyDown={(e) => {
          if (e.key === "Tab") e.preventDefault();
        }}
      >
        <div className="in">
          <Icon of={Search} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              items.length > 0 ? `${idPrefix}-${String(current)}` : undefined
            }
            aria-label={searchLabel}
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              onQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel(Math.min(items.length - 1, current + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel(Math.max(0, current - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(current);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd>{m.esc}</kbd>
        </div>
        <div
          className="ls"
          id={listId}
          role="listbox"
          aria-label={m.results}
          ref={listRef}
        >
          {items.length === 0 && (
            <div className="gl" role="status">
              {m.noResults}
            </div>
          )}
          {sections.map((section) => {
            const headId = `${idPrefix}-g-${String(section.start)}`;
            return (
              <div key={headId} role="group" aria-labelledby={headId}>
                <div className="gl" id={headId} aria-hidden="true">
                  {section.group}
                </div>
                {section.items.map((item, k) => {
                  const i = section.start + k;
                  return (
                    /*
                     * Lựa chọn của combobox: focus ở lại ô gõ (aria-activedescendant), bàn phím đi bằng mũi tên và
                     * Enter ở ô gõ — lựa chọn không là nút riêng để Tab dừng lại.
                     */
                    <div
                      key={`${item.group}-${item.label}-${String(i)}`}
                      id={`${idPrefix}-${String(i)}`}
                      className="op"
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => setSel(i)}
                      onClick={() => runAt(i)}
                    >
                      <Icon of={item.icon} />
                      <span
                        translate={item.literal === true ? "no" : undefined}
                      >
                        {item.label}
                      </span>
                      <span className="h">
                        {item.shortcut !== undefined && item.shortcut !== "" ? (
                          <kbd>{item.shortcut}</kbd>
                        ) : (
                          item.hint
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="ft">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {m.select}
          </span>
          <span>
            <kbd>{m.enter}</kbd> {m.open}
          </span>
        </div>
      </div>
    </>
  );
}
