import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";
import { useMessages } from "../i18n";
import { componentsMessages } from "./components.messages";
import type { FieldControlProps } from "./Field";
import { Icon } from "./Icon";

/**
 * [Plan #59] Ô mật khẩu có nút hiện/ẩn: gõ trên điện thoại hay mật khẩu dài thì người dùng kiểm được mình gõ gì
 * trước khi gửi (WCAG 3.3.7 không buộc, nhưng giảm lỗi gõ). Nút là nút bật (`aria-pressed`) với tên cố định, nằm
 * NGOÀI thứ tự gửi form (`type="button"`). Nhận thuộc tính của `Field` để nhãn, gợi ý và lỗi vẫn gắn vào ô.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  minLength,
  ...field
}: FieldControlProps & {
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: InputHTMLAttributes<HTMLInputElement>["minLength"];
}) {
  const m = useMessages(componentsMessages);
  const [shown, setShown] = useState(false);
  return (
    <div className="pw">
      <input
        {...field}
        className="inp"
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        required
        {...(minLength === undefined ? {} : { minLength })}
        spellCheck={false}
        autoCapitalize="none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="ib pw-eye"
        aria-label={m.showPassword}
        aria-pressed={shown}
        aria-controls={field.id}
        onClick={() => setShown((s) => !s)}
      >
        <Icon of={shown ? EyeOff : Eye} />
      </button>
    </div>
  );
}
