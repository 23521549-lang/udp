/**
 * Định dạng số và thời gian theo `vi-VN` — một chỗ, để mọi con số trên màn hình cùng
 * dấu phân cách và mọi mốc thời gian cùng cách nói.
 */

const nf = new Intl.NumberFormat("vi-VN");
const pf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

export const formatNumber = (n: number): string => nf.format(n);
/** Byte theo đơn vị nhị phân — trần segment là 4 MiB, không phải 4 MB */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${pf.format(n / (1024 * 1024))} MiB`;
  if (n >= 1024) return `${pf.format(n / 1024)} KiB`;
  return `${nf.format(n)} B`;
}

export const formatPercent = (n: number): string => `${pf.format(n)}%`;

/** Số theo trọng số hai chữ số lẻ (z-score, hệ số) — cùng dấu thập phân với mọi số khác */
export const formatDecimal = (n: number): string => pf.format(n);

const cf = new Intl.NumberFormat("vi-VN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
/** "12 N", "3,1 Tr" — rút gọn theo chính quy ước vi-VN của Intl, không tự ghép K/M */
export const compactNumber = (n: number): string => cf.format(n);

const usdf = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdSmall = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 3,
});
/**
 * Tiền USD (chi phí cloud luôn tính bằng USD). Dưới 1 cent — giá theo giờ của một địa chỉ IP —
 * giữ ba chữ số có nghĩa thay vì làm tròn thành "0,00 US$".
 */
export function formatUsd(n: number): string {
  return n !== 0 && Math.abs(n) < 0.01 ? usdSmall.format(n) : usdf.format(n);
}

/**
 * Thời lượng từ giây: "45 giây", "5 phút", "1 giờ 5 phút", "2 ngày 3 giờ" — hai đơn vị lớn nhất.
 * `null` (median chưa có mẫu) là "–", không bao giờ là "0 giây".
 */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return "–";
  const s = Math.max(0, Math.round(totalSeconds));
  const parts: [number, string][] = [
    [Math.floor(s / 86400), "ngày"],
    [Math.floor((s % 86400) / 3600), "giờ"],
    [Math.floor((s % 3600) / 60), "phút"],
    [s % 60, "giây"],
  ];
  const first = parts.findIndex(([v]) => v > 0);
  if (first === -1) return "0 giây";
  return parts
    .slice(first, first + 2)
    .filter(([v]) => v > 0)
    .map(([v, unit]) => `${nf.format(v)} ${unit}`)
    .join(" ");
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
