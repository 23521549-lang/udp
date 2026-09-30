import { useRef, type KeyboardEvent } from "react";

/**
 * [Plan #58 UX-40, WCAG 4.1.2] Nhóm tab đúng mẫu ARIA: chỉ tab đang chọn nằm trong thứ tự Tab (roving tabindex),
 * mũi tên trái/phải và Home/End chuyển tab và chọn luôn (kích hoạt tự động — nội dung đổi nhẹ, không tải nặng).
 * Cùng khuôn `.envtabs` với các nhóm tab cũ. Đổi trang (URL khác hẳn) thì dùng link điều hướng, không dùng tab.
 */
export interface TabOption<V extends string> {
  value: V;
  label: string;
}

export function Tabs<V extends string>({
  label,
  value,
  options,
  onChange,
  controls,
}: {
  label: string;
  value: V;
  options: readonly TabOption<V>[];
  onChange: (value: V) => void;
  /** Id của vùng nội dung (`role="tabpanel"`) mà nhóm tab điều khiển */
  controls?: string;
}) {
  const list = useRef<HTMLDivElement>(null);

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = options.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : undefined;
    const option = next === undefined ? undefined : options[next];
    if (option === undefined || next === undefined) return;
    e.preventDefault();
    onChange(option.value);
    list.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  return (
    <div className="envtabs" role="tablist" aria-label={label} ref={list}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          aria-controls={controls}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
