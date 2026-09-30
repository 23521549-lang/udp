import { useId, type ReactNode } from "react";

/**
 * [Plan #58 UX-39] Một ô của form với nhãn, gợi ý và lỗi GẮN VÀO ô: `aria-describedby` trỏ tới cả gợi ý lẫn lỗi,
 * `aria-invalid` khi có lỗi — trình đọc màn hình đọc đủ, và lỗi nằm ngay dưới ô (WCAG 3.3.1, 1.3.1). Tổng quát hoá
 * `Field` của trang đăng nhập.
 *
 * `children` nhận thuộc tính của ô qua render-prop, nên dùng được cho `input`, `select`, `textarea` hay ô số tự dựng:
 *
 *     <Field label="Tên" hint="3–40 ký tự" error={err}>
 *       {(p) => <input className="inp" {...p} value={v} onChange={…} />}
 *     </Field>
 */
export interface FieldControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string | undefined;
}

export function Field({
  label,
  hint,
  error,
  id,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  /** Id cố định khi nơi khác cần trỏ tới ô (focus ô lỗi đầu tiên); mặc định tự sinh */
  id?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const auto = useId();
  const controlId = id ?? auto;
  const hintId = `${controlId}-hint`;
  const errId = `${controlId}-err`;
  const described =
    [hint === undefined ? "" : hintId, error === undefined ? "" : errId]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="f">
      <label htmlFor={controlId}>{label}</label>
      {children({
        id: controlId,
        "aria-invalid": error !== undefined,
        "aria-describedby": described,
      })}
      {hint !== undefined && (
        <span id={hintId} className="c3 field-hint">
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span id={errId} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** Sau một lần gửi hỏng: đưa focus tới ô lỗi ĐẦU TIÊN trong `root` (thứ tự của tài liệu) */
export function focusFirstInvalid(root: HTMLElement | null): void {
  root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
