import { create } from "zustand";

/**
 * [Plan #54 QĐ-1] Tầng ngôn ngữ của Portal — tự viết, kiểu chặt, không thư viện.
 *
 * Mỗi phân hệ khai chữ của nó ở một tệp `*.messages.ts` bằng `defineMessages({ vi, en })`. Bản `en` có
 * kiểu `NoInfer<V>` của bản `vi`: thiếu một khoá, thừa một khoá, hay một hàm sai tham số là LỖI BIÊN DỊCH —
 * không có chữ nào lặng lẽ rơi về tiếng Việt khi xem bằng tiếng Anh. Chữ có tham số là hàm, nên TypeScript
 * kiểm cả tham số; không có bước nội suy `{name}` lúc chạy để sai.
 */

export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Thẻ BCP 47 cho `Intl` — số, tiền, ngày theo đúng quy ước của ngôn ngữ đang chọn */
export const INTL_LOCALE: Record<Locale, string> = {
  vi: "vi-VN",
  en: "en-US",
};

/** Tên của mỗi ngôn ngữ bằng CHÍNH ngôn ngữ đó — bộ chọn không dịch tên ngôn ngữ */
export const LOCALE_NAME: Record<Locale, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

const KEY = "udp_locale";

const asLocale = (value: string | null | undefined): Locale | undefined =>
  LOCALES.find((l) => l === value);

function storedLocale(): Locale | undefined {
  try {
    return asLocale(localStorage.getItem(KEY));
  } catch {
    return undefined;
  }
}

/** Ngôn ngữ đầu tiên của trình duyệt mà Portal có (`vi-VN` ⇒ vi, `en-GB` ⇒ en) */
function browserLocale(): Locale | undefined {
  try {
    const tags =
      navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
    for (const tag of tags) {
      const hit = asLocale(tag.toLowerCase().split("-")[0]);
      if (hit !== undefined) return hit;
    }
  } catch {
    // môi trường không có navigator: dùng mặc định
  }
  return undefined;
}

/** Lựa chọn tay › ngôn ngữ của trình duyệt › tiếng Việt */
export const initialLocale = (): Locale =>
  storedLocale() ?? browserLocale() ?? "vi";

/** `<html lang>`: trình đọc màn hình đọc đúng giọng, trình duyệt gạch chính tả đúng từ điển */
export function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>()((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      // storage bị chặn: vẫn đổi cho phiên này
    }
    applyLocale(locale);
    set({ locale });
  },
}));

/** Ngôn ngữ đang chọn — cho mã ngoài React (định dạng, câu lỗi) */
export const currentLocale = (): Locale => useLocaleStore.getState().locale;

export const useLocale = (): Locale => useLocaleStore((s) => s.locale);

export interface MessageBundle<V> {
  readonly vi: V;
  readonly en: V;
}

export function defineMessages<V>(bundle: {
  vi: V;
  en: NoInfer<V>;
}): MessageBundle<V> {
  return bundle;
}

/** Chữ của một bundle theo ngôn ngữ đang chọn; component vẽ lại khi đổi ngôn ngữ */
export function useMessages<V>(bundle: MessageBundle<V>): V {
  return bundle[useLocale()];
}

/**
 * Chữ của một bundle ngoài React (câu lỗi, định dạng). Gọi trong lúc render thì component gọi nó phải tự
 * theo dõi ngôn ngữ (`useLocale`/`useMessages`) — mọi màn đều làm vậy qua chữ của chính nó.
 */
export function messagesOf<V>(bundle: MessageBundle<V>): V {
  return bundle[currentLocale()];
}

const enPlural = new Intl.PluralRules("en-US");
const enNumber = new Intl.NumberFormat("en-US");

/** Số kèm danh từ tiếng Anh đúng số ít/số nhiều: `count(1, "project", "projects")` ⇒ "1 project" */
export const count = (n: number, one: string, other: string): string =>
  `${enNumber.format(n)} ${enPlural.select(n) === "one" ? one : other}`;

/** Chỉ danh từ, không kèm số: "project" hay "projects" */
export const plural = (n: number, one: string, other: string): string =>
  enPlural.select(n) === "one" ? one : other;
