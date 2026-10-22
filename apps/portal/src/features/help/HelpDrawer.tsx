import { useState } from "react";
import { create } from "zustand";
import { shellUxMessages } from "../../app/shell-ux.messages";
import { Dialog } from "../../components/Dialog";
import { useMessages } from "../../i18n";
import { glossaryMessages, TERMS } from "./glossary.messages";

/**
 * [Plan #58 UX-21] Trợ giúp ở CÙNG một chỗ trên mọi trang của cả hai portal (WCAG 3.2.6): bắt đầu nhanh theo việc,
 * rồi bảng thuật ngữ tìm được. Nội dung đọc từ cùng bảng thuật ngữ với `InfoTip` — không hai lời giải thích.
 * Trợ giúp "kéo" (người dùng tự mở), không tour bắt buộc (NN/g: tutorial không làm người dùng giỏi hơn).
 */
export const useHelpStore = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Bỏ dấu để "khoa" tìm được "khoá" — người gõ không dấu vẫn tìm ra */
const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

export function HelpDrawer() {
  const open = useHelpStore((s) => s.open);
  const setOpen = useHelpStore((s) => s.setOpen);
  if (!open) return null;
  return <HelpBody onClose={() => setOpen(false)} />;
}

function HelpBody({ onClose }: { onClose: () => void }) {
  const m = useMessages(shellUxMessages).help;
  const g = useMessages(glossaryMessages);
  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const terms = TERMS.map((k) => g.term[k]).filter(
    (t) =>
      needle === "" ||
      fold(t.name).includes(needle) ||
      fold(t.def).includes(needle),
  );
  return (
    <Dialog title={m.title} description={m.lead} onClose={onClose} drawer>
      <section className="help-sec" aria-labelledby="help-guides">
        <h3 id="help-guides">{m.guidesTitle}</h3>
        {m.guides.map((guide) => (
          <details key={guide.title} className="help-guide">
            <summary>{guide.title}</summary>
            <ol>
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ))}
      </section>
      <section className="help-sec" aria-labelledby="help-terms">
        <h3 id="help-terms">{g.title}</h3>
        <div className="f">
          <label htmlFor="help-q">{m.searchLabel}</label>
          <input
            id="help-q"
            className="inp"
            type="search"
            autoComplete="off"
            placeholder={m.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {terms.length === 0 ? (
          <p className="c3">{m.noMatch}</p>
        ) : (
          <dl className="help-terms">
            {terms.map((t) => (
              <div key={t.name}>
                <dt>{t.name}</dt>
                <dd>{t.def}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </Dialog>
  );
}
