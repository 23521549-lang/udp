/**
 * Định dạng số và thời gian theo `vi-VN` — một chỗ, để mọi con số trên màn hình cùng
 * dấu phân cách và mọi mốc thời gian cùng cách nói.
 */

const nf = new Intl.NumberFormat("vi-VN");
const pf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

export const formatNumber = (n: number): string => nf.format(n);
export const formatPercent = (n: number): string => `${pf.format(n)}%`;

export function compactNumber(n: number): string {
  if (n >= 1e6) return `${pf.format(n / 1e6)}M`;
  if (n >= 1e3) return `${pf.format(n / 1e3)}K`;
  return nf.format(n);
}

const rtf = new Intl.RelativeTimeFormat("vi-VN", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "2 giờ trước" — `now` truyền vào được để test không phụ thuộc đồng hồ */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return rtf.format(0, "second");
}

const dtf = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
});
export const formatDateTime = (iso: string): string =>
  dtf.format(new Date(iso));

/** Múi giờ của trình duyệt — tham số `tz` của stats (§9) */
export const browserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Đếm grapheme chứ không đếm code unit: "Tiếng Việt" gõ bằng dấu tổ hợp (NFD) dài hơn
 * bản dựng sẵn (NFC) tính theo `length`, trong khi người dùng thấy cùng một chữ.
 * `Intl.Segmenter` có sẵn từ Node 16 và mọi trình duyệt hiện hành.
 */
export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter("vi").segment(text)) n += 1;
  return n;
}
