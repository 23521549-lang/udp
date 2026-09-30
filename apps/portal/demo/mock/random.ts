/**
 * Ngẫu nhiên TẤT ĐỊNH cho dữ liệu mẫu: mở lại bản xem thử là cùng id, cùng số — một liên kết sâu tới một flag
 * hay một rollout vẫn trỏ đúng chỗ.
 */
export type Rng = () => number;

/** mulberry32 — đủ đều cho dữ liệu minh hoạ, không dùng cho gì cần an toàn */
export function prng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";

export function hex(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += HEX[Math.floor(rng() * 16)];
  return out;
}

/** UUID dạng v4 hợp lệ với `z.string().uuid()` */
export function uuid(rng: Rng): string {
  const variant = "89ab"[Math.floor(rng() * 4)] ?? "8";
  return `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${variant}${hex(rng, 3)}-${hex(rng, 12)}`;
}

/** FNV-1a 32 bit — hạt giống tất định từ một chuỗi */
export function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** UUID ổn định theo một chuỗi: cùng tài nguyên, cùng id qua mọi lần gọi (khoá React không nhảy) */
export const uuidOf = (text: string): string => uuid(prng(fnv(text)));

export const between = (rng: Rng, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick từ danh sách rỗng");
  return item;
}
