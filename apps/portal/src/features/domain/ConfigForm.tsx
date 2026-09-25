import { isKeptSecret, KEPT_SECRET } from "@udp/shared-types/domain-api";
import type {
  DomainConfigFieldWire,
  DomainToolWire,
} from "@udp/shared-types/wire";
import { useState } from "react";
import { Switch } from "../../components/Switch";

/**
 * Form cấu hình một tool, dựng từ `configFields` mà catalog suy từ `configSchema` của adapter
 * (Plan #27 QĐ-3) — không một trường nào khai tay ở Portal. Kiểm thật ở máy chủ bằng CHÍNH
 * schema đó; ở đây chỉ chặn điều hiển nhiên (JSON hỏng) để không gửi một body vô nghĩa.
 */
export function ConfigForm({
  idPrefix,
  tool,
  value,
  onChange,
  disabled,
  errors,
}: {
  idPrefix: string;
  tool: DomainToolWire;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled: boolean;
  /** Lỗi của máy chủ theo khoá trường (`site`, `apiKey`…) */
  errors: Record<string, string>;
}) {
  if (tool.config.kind === "json") {
    return (
      <JsonInput
        id={`${idPrefix}-config`}
        label="Cấu hình (JSON)"
        value={value}
        onChange={(v) => onChange(v as Record<string, unknown>)}
        disabled={disabled}
        error={errors[""]}
      />
    );
  }
  if (tool.config.fields.length === 0) {
    return <p className="c3">Tool này không có gì để cấu hình.</p>;
  }
  return (
    <div className="grid-f">
      {tool.config.fields.map((field) => (
        <FieldInput
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          field={field}
          value={value[field.key]}
          disabled={disabled}
          error={errors[field.key]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[field.key];
            else next[field.key] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

function FieldInput({
  id,
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  field: DomainConfigFieldWire;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const label = field.required ? `${field.key} *` : field.key;
  const errorLine = error !== undefined && (
    <span className="field-error">{error}</span>
  );
  if (field.secret === true) {
    return (
      <div className="f">
        <label htmlFor={id}>{label}</label>
        <SecretInput
          id={id}
          name={field.key}
          value={value}
          onChange={onChange}
          disabled={disabled}
          invalid={error !== undefined}
        />
        {errorLine}
      </div>
    );
  }
  switch (field.kind) {
    case "boolean":
      return (
        <div className="f">
          <span className="lbl">{label}</span>
          <Switch
            checked={value === true}
            onChange={onChange}
            label={field.key}
            disabled={disabled}
          />
          {errorLine}
        </div>
      );
    case "enum":
      return (
        <div className="f">
          <label htmlFor={id}>{label}</label>
          <select
            id={id}
            className="sel"
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            aria-invalid={error !== undefined}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : e.target.value)
            }
          >
            <option value="">Chọn</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {errorLine}
        </div>
      );
    case "number":
      return (
        <div className="f">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            className="inp num"
            type="number"
            disabled={disabled}
            min={field.min}
            max={field.max}
            step={field.integer === true ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            aria-invalid={error !== undefined}
            onChange={(e) =>
              onChange(
                e.target.value === "" ? undefined : Number(e.target.value),
              )
            }
          />
          {errorLine}
        </div>
      );
    case "string":
      return (
        <div className="f">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            className="inp"
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            aria-invalid={error !== undefined}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : e.target.value)
            }
          />
          {errorLine}
        </div>
      );
    case "json":
      return (
        <JsonInput
          id={id}
          label={label}
          value={value}
          onChange={onChange}
          disabled={disabled}
          error={error}
        />
      );
  }
}

/**
 * Ô bí mật (Plan #31): máy chủ không bao giờ trả giá trị, chỉ `KEPT_SECRET` — "đã lưu". Không
 * đụng tới ⇒ gửi lại giữ chỗ ⇒ giữ khoá cũ; "Đổi" rồi gõ ⇒ khoá mới; "Giữ khoá cũ" ⇒ thôi đổi.
 */
function SecretInput({
  id,
  name,
  value,
  onChange,
  disabled,
  invalid,
}: {
  id: string;
  /** Khoá trường — tên riêng cho nút "Giữ khoá cũ" khi nhiều ô bí mật cùng mở */
  name: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const saved = isKeptSecret(value);
  const [editing, setEditing] = useState(false);
  const [previous, setPrevious] = useState(value);
  if (value !== previous) {
    setPrevious(value);
    // Vừa lưu xong (khoá mới thành "đã lưu") ⇒ về lại trạng thái đã lưu
    if (saved && !isKeptSecret(previous)) setEditing(false);
  }

  if (saved && !editing) {
    return (
      <div className="secret-row">
        <span className="chip soft">Đã lưu</span>
        <button
          type="button"
          id={id}
          className="btn"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Đổi
        </button>
      </div>
    );
  }
  return (
    <div className="secret-row">
      <input
        id={id}
        className="inp"
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        aria-invalid={invalid}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : e.target.value)
        }
      />
      {editing && (
        <button
          type="button"
          className="btn"
          aria-label={`Giữ khoá cũ của ${name}`}
          disabled={disabled}
          onClick={() => {
            onChange({ ...KEPT_SECRET });
            setEditing(false);
          }}
        >
          Giữ khoá cũ
        </button>
      )}
    </div>
  );
}

/** Ô JSON: giữ chữ người dùng gõ, chỉ đẩy ra ngoài khi parse được */
function JsonInput({
  id,
  label,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const shown = parseError ?? error;
  return (
    <div className="f">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="inp"
        rows={4}
        spellCheck={false}
        disabled={disabled}
        value={text}
        aria-invalid={shown !== undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setParseError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value) as unknown);
            setParseError(null);
          } catch {
            setParseError("JSON chưa hợp lệ");
          }
        }}
      />
      {shown !== undefined && <span className="field-error">{shown}</span>}
    </div>
  );
}
