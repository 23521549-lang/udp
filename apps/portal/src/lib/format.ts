import { currentLocale, INTL_LOCALE, type Locale } from "../i18n";
import { formatMessages } from "./format.messages";

/**
 * Định dạng số và thời gian theo NGÔN NGỮ ĐANG CHỌN (`vi-VN` hay `en-US`, Plan #54) — một chỗ, để mọi con
 * số trên màn hình cùng dấu phân cách và mọi mốc thời gian cùng cách nói. Bộ định dạng `Intl` dựng một lần
 * cho mỗi ngôn ngữ; component vẽ lại khi đổi ngôn ngữ (qua chữ của chính nó) nên gọi lại là đúng ngôn ngữ mới.
 */

interface Formatters {
  number: Intl.NumberFormat;
  decimal: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  usd: Intl.NumberFormat;
  usdSmall: Intl.NumberFormat;
  relative: Intl.RelativeTimeFormat;
  dateTime: Intl.DateTimeFormat;
  dayShort: Intl.DateTimeFormat;
  dayFull: Intl.DateTimeFormat;
  clock: Intl.DateTimeFormat;
  dayMonth: Intl.DateTimeFormat;
  dayMonthClock: Intl.DateTimeFormat;
}

const cache = new Map<Locale, Formatters>();

function build(tag: string): Formatters {
  return {
    number: new Intl.NumberFormat(tag),
    decimal: new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }),
    compact: new Intl.NumberFormat(tag, {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    usd: new Intl.NumberFormat(tag, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    usdSmall: new Intl.NumberFormat(tag, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 3,
    }),
    relative: new Intl.RelativeTimeFormat(tag, { numeric: "auto" }),
    dateTime: new Intl.DateTimeFormat(tag, {
      dateStyle: "short",
      timeStyle: "short",
    }),
    dayShort: new Intl.DateTimeFormat(tag, {
      day: "numeric",
      month: "numeric",
      timeZone: "UTC",
    }),
    dayFull: new Intl.DateTimeFormat(tag, {
      weekday: "long",
      day: "numeric",
      month: "numeric",
      timeZone: "UTC",
    }),
    clock: new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
    dayMonth: new Intl.DateTimeFormat(tag, {
      day: "2-digit",
      month: "2-digit",
    }),
    dayMonthClock: new Intl.DateTimeFormat(tag, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

function fmt(): Formatters {
  const locale = currentLocale();
  let f = cache.get(locale);
  if (f === undefined) {
    f = build(INTL_LOCALE[locale]);
    cache.set(locale, f);
  }
  return f;
}

export const formatNumber = (n: number): string => fmt().number.format(n);
/** Byte theo đơn vị nhị phân — trần segment là 4 MiB, không phải 4 MB; ổ đĩa là GiB */
export function formatBytes(n: number): string {
  const d = fmt().decimal;
  if (n >= 1024 ** 3) return `${d.format(n / 1024 ** 3)} GiB`;
  if (n >= 1024 * 1024) return `${d.format(n / (1024 * 1024))} MiB`;
  if (n >= 1024) return `${d.format(n / 1024)} KiB`;
  return `${formatNumber(n)} B`;
}

export const formatPercent = (n: number): string =>
  `${fmt().decimal.format(n)}%`;

/** Số theo trọng số hai chữ số lẻ (z-score, hệ số) — cùng dấu thập phân với mọi số khác */
export const formatDecimal = (n: number): string => fmt().decimal.format(n);

/** "12 N" / "12K" — rút gọn theo chính quy ước của ngôn ngữ trong Intl, không tự ghép K/M */
export const compactNumber = (n: number): string => fmt().compact.format(n);

/**
 * Tiền USD (chi phí cloud luôn tính bằng USD). Dưới 1 cent — giá theo giờ của một địa chỉ IP —
 * giữ ba chữ số có nghĩa thay vì làm tròn thành "0,00 US$".
 */
export function formatUsd(n: number): string {
  return n !== 0 && Math.abs(n) < 0.01
    ? fmt().usdSmall.format(n)
    : fmt().usd.format(n);
}

/**
 * Thời lượng từ giây: "45 giây" / "45s", "1 giờ 5 phút" / "1h 5m", "2 ngày 3 giờ" / "2d 3h" — hai đơn vị
 * lớn nhất. `null` (median chưa có mẫu) là "–", không bao giờ là "0 giây".
 */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return "–";
  const unit = formatMessages[currentLocale()].unit;
  const s = Math.max(0, Math.round(totalSeconds));
  const parts: [number, (n: string) => string][] = [
    [Math.floor(s / 86400), unit.day],
    [Math.floor((s % 86400) / 3600), unit.hour],
    [Math.floor((s % 3600) / 60), unit.minute],
    [s % 60, unit.second],
  ];
  const first = parts.findIndex(([v]) => v > 0);
  if (first === -1) return unit.second(formatNumber(0));
  return parts
    .slice(first, first + 2)
    .filter(([v]) => v > 0)
    .map(([v, of]) => of(formatNumber(v)))
    .join(" ");
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "2 giờ trước" / "2 hours ago" — `now` truyền vào được để test không phụ thuộc đồng hồ */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return fmt().relative.format(Math.round(seconds / size), unit);
    }
  }
  return fmt().relative.format(0, "second");
}

export const formatDateTime = (iso: string): string =>
  fmt().dateTime.format(new Date(iso));

/** Mốc của trục thời gian biểu đồ (epoch ms): giờ:phút, ngày/tháng, và cả hai cho tooltip */
export const formatClock = (ms: number): string => fmt().clock.format(ms);
export const formatDayMonth = (ms: number): string => fmt().dayMonth.format(ms);
export const formatDayMonthClock = (ms: number): string =>
  fmt().dayMonthClock.format(ms);

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

/**
 * Nhãn của MỘT ngày lịch `YYYY-MM-DD` cho biểu đồ theo ngày: "29/9" / "9/29" dưới cột, "Thứ Hai, 29/9" /
 * "Monday, 9/29" cho tooltip và trình đọc màn hình. Ngày lịch không có giờ, nên đọc và in ở UTC: không có múi giờ nào
 * đẩy nó sang ngày bên cạnh.
 */
export function dayLabel(date: string): { short: string; full: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const f = fmt();
  return { short: f.dayShort.format(d), full: f.dayFull.format(d) };
}

/** `n` ngày lịch gần nhất theo giờ của trình duyệt, cũ nhất trước, dạng `YYYY-MM-DD` */
export function lastDays(n: number, now: Date = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (n - 1 - i));
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${String(d.getFullYear())}-${mm}-${dd}`;
  });
}
