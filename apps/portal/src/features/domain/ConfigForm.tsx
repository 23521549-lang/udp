import { isKeptSecret, KEPT_SECRET } from "@udp/shared-types/domain-api";
import type {
  DomainConfigFieldWire,
  DomainToolWire,
} from "@udp/shared-types/wire";
import { useState, type ReactNode } from "react";
import { Switch } from "../../components/Switch";
import { useMessages } from "../../i18n";
import { configLabel } from "./config-labels";
import { domainMessages } from "./domain.messages";

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
  const m = useMessages(domainMessages).config;
  if (tool.config.kind === "json") {
    return (
      <JsonInput
        id={`${idPrefix}-config`}
        label={m.json}
        value={value}
        onChange={(v) => onChange(v as Record<string, unknown>)}
        disabled={disabled}
        error={errors[""]}
      />
    );
  }
  if (tool.config.fields.length === 0) {
    return <p className="c3">{m.nothing}</p>;
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
  // Theo dõi ngôn ngữ: `configLabel` đọc ngôn ngữ lúc gọi
  const m = useMessages(domainMessages).config;
  const text = configLabel(field.key);
  const label = field.required ? `${text} *` : text;
  /** Khoá gốc cạnh nhãn: thứ người dùng gặp trong tài liệu của tool */
  const keyTag = (
    <span className="f-key mono c3" translate="no">
      {field.key}
    </span>
  );
  const errId = `${id}-err`;
  const described = error === undefined ? undefined : errId;
  const errorLine = error !== undefined && (
    <span id={errId} className="field-error">
      {error}
    </span>
  );
  if (field.secret === true) {
    return (
      <div className="f">
        <div className="f-top">
          <label htmlFor={id}>{label}</label>
          {keyTag}
        </div>
        <SecretInput
          id={id}
          name={field.key}
          label={text}
          value={value}
          onChange={onChange}
          disabled={disabled}
          invalid={error !== undefined}
          describedBy={described}
          required={field.required}
        />
        {errorLine}
      </div>
    );
  }
  switch (field.kind) {
    case "boolean":
      return (
        <div className="f">
          <div className="f-top" aria-hidden="true">
            <span className="lbl">{label}</span>
            {keyTag}
          </div>
          <Switch
            checked={value === true}
            onChange={onChange}
            label={text}
            disabled={disabled}
          />
          {errorLine}
        </div>
      );
    case "enum":
      return (
        <div className="f">
          <div className="f-top">
            <label htmlFor={id}>{label}</label>
            {keyTag}
          </div>
          <select
            id={id}
            name={field.key}
            className="sel"
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            aria-invalid={error !== undefined}
            aria-describedby={described}
            aria-required={field.required}
            onChange={(e) =>
              onChange(e.target.value === "" ? undefined : e.target.value)
            }
          >
            <option value="">{m.choose}</option>
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
          <div className="f-top">
            <label htmlFor={id}>{label}</label>
            {keyTag}
          </div>
          <input
            id={id}
            name={field.key}
            className="inp num"
            type="number"
            inputMode={field.integer === true ? "numeric" : "decimal"}
            autoComplete="off"
            disabled={disabled}
            min={field.min}
            max={field.max}
            step={field.integer === true ? 1 : "any"}
            value={typeof value === "number" ? value : ""}
            aria-invalid={error !== undefined}
            aria-describedby={described}
            aria-required={field.required}
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
          <div className="f-top">
            <label htmlFor={id}>{label}</label>
            {keyTag}
          </div>
          <input
            id={id}
            name={field.key}
            className="inp"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            aria-invalid={error !== undefined}
            aria-describedby={described}
            aria-required={field.required}
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
          keyTag={keyTag}
          required={field.required}
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
  label,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  required,
}: {
  id: string;
  /** Khoá trường — `name` của ô */
  name: string;
  /** Nhãn đọc được của trường — tên riêng cho nút "Giữ khoá cũ" khi nhiều ô bí mật cùng mở */
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  required: boolean;
}) {
  const m = useMessages(domainMessages).config;
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
        <span className="chip soft">{m.savedSecret}</span>
        <button
          type="button"
          id={id}
          className="btn"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          {m.change}
        </button>
      </div>
    );
  }
  return (
    <div className="secret-row">
      <input
        id={id}
        name={name}
        className="inp"
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        value={typeof value === "string" ? value : ""}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-required={required}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : e.target.value)
        }
      />
      {editing && (
        <button
          type="button"
          className="btn"
          aria-label={m.keepOldOf(label)}
          disabled={disabled}
          onClick={() => {
            onChange({ ...KEPT_SECRET });
            setEditing(false);
          }}
        >
          {m.keepOld}
        </button>
      )}
    </div>
  );
}

/** Ô JSON: giữ chữ người dùng gõ, chỉ đẩy ra ngoài khi parse được */
function JsonInput({
  id,
  label,
  keyTag,
  required = false,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  label: string;
  keyTag?: ReactNode;
  required?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const m = useMessages(domainMessages).config;
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  // Cờ chứ không phải câu: đổi ngôn ngữ lúc đang báo lỗi thì câu đổi theo
  const [parseError, setParseError] = useState(false);
  const shown = parseError ? m.invalidJson : error;
  return (
    <div className="f">
      <div className="f-top">
        <label htmlFor={id}>{label}</label>
        {keyTag}
      </div>
      <textarea
        id={id}
        className="inp"
        rows={4}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        value={text}
        aria-invalid={shown !== undefined}
        aria-describedby={shown === undefined ? undefined : `${id}-err`}
        aria-required={required}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setParseError(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value) as unknown);
            setParseError(false);
          } catch {
            setParseError(true);
          }
        }}
      />
      {shown !== undefined && (
        <span id={`${id}-err`} className="field-error">
          {shown}
        </span>
      )}
    </div>
  );
}
