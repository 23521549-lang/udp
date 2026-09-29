import { useId } from "react";
import { LOCALE_NAME, LOCALES, useLocaleStore, useMessages } from "../i18n";
import { appMessages } from "./app.messages";
import { useTheme, type ThemePreference } from "./theme";

const THEMES: readonly ThemePreference[] = ["light", "dark", "system"];

/**
 * [Plan #54 QĐ-3] Sáng · Tối · Theo hệ thống — một nhóm nút bật (`aria-pressed`), cùng khuôn `.seg` với
 * mọi bộ chọn khoảng khác của Portal.
 */
export function ThemeSwitch() {
  const m = useMessages(appMessages);
  const { preference, setPreference } = useTheme();
  const label = useId();
  return (
    <div className="pref">
      <span className="pref-l" id={label}>
        {m.appearance}
      </span>
      <div className="seg" role="group" aria-labelledby={label}>
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={preference === t}
            onClick={() => setPreference(t)}
          >
            {m.theme[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * [Plan #54 QĐ-1] Tên mỗi ngôn ngữ viết bằng CHÍNH ngôn ngữ đó và mang `lang` của nó — người không đọc được
 * ngôn ngữ đang hiện vẫn tìm ra tên ngôn ngữ của mình, trình đọc màn hình đọc đúng giọng.
 */
export function LanguageSwitch() {
  const m = useMessages(appMessages);
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const label = useId();
  return (
    <div className="pref">
      <span className="pref-l" id={label}>
        {m.language}
      </span>
      <div className="seg" role="group" aria-labelledby={label}>
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={locale === l}
            onClick={() => setLocale(l)}
          >
            {LOCALE_NAME[l]}
          </button>
        ))}
      </div>
    </div>
  );
}
