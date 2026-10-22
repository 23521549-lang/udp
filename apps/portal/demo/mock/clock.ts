/** Mốc "bây giờ" của dữ liệu mẫu: lúc mở trang — mọi dấu thời gian là tương đối, nên trang luôn trông mới */
export const OPENED_AT = Date.now();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const iso = (ms: number): string => new Date(ms).toISOString();
export const minutesAgo = (m: number): string => iso(OPENED_AT - m * MINUTE);
export const hoursAgo = (h: number): string => iso(OPENED_AT - h * HOUR);
export const daysAgo = (d: number): string => iso(OPENED_AT - d * DAY);
export const hoursAhead = (h: number): string => iso(OPENED_AT + h * HOUR);

/** Ngày dạng `YYYY-MM-DD` (UTC) cách lúc mở `d` ngày */
export const dateDaysAgo = (d: number): string =>
  daysAgo(d).slice(0, "YYYY-MM-DD".length);

/** Giây đã trôi từ lúc mở trang — thứ đẩy các mô phỏng "đang chạy" đi tiếp */
export const elapsedSeconds = (): number => (Date.now() - OPENED_AT) / 1000;

export const nowIso = (): string => iso(Date.now());
