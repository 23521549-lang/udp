/**
 * Chia một khối IPv4 thành các khối con cùng cỡ — tất định, để kế hoạch dựng cùng tham số
 * cho cùng project ở mọi lần chạy (ADR-08 quy tắc 2: lookup trước create chỉ có nghĩa khi
 * tham số không đổi giữa hai lần).
 */
function parse(block: string): { base: number; prefix: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    block,
  );
  if (m === null) throw new Error(`CIDR không hợp lệ: ${block}`);
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) {
    throw new Error(`CIDR không hợp lệ: ${block}`);
  }
  const base = octets.reduce((acc, o) => acc * 256 + o, 0);
  return { base, prefix };
}

const format = (n: number, prefix: number): string =>
  `${[24, 16, 8, 0].map((s) => String(Math.floor(n / 2 ** s) % 256)).join(".")}/${String(prefix)}`;

/** Khối con thứ `index` (từ 0) cỡ `/newPrefix` bên trong `block` */
export function subnetCidr(
  block: string,
  newPrefix: number,
  index: number,
): string {
  const { base, prefix } = parse(block);
  if (newPrefix < prefix || newPrefix > 32) {
    throw new Error(`/${String(newPrefix)} không nằm trong ${block}`);
  }
  const count = 2 ** (newPrefix - prefix);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `${block} chỉ có ${String(count)} khối /${String(newPrefix)}`,
    );
  }
  const size = 2 ** (32 - newPrefix);
  const network = base - (base % 2 ** (32 - prefix));
  return format(network + index * size, newPrefix);
}

/** Hai khối IPv4 có địa chỉ chung (khối này chứa khối kia, hoặc trùng nhau) */
export function cidrsOverlap(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  const prefix = Math.min(x.prefix, y.prefix);
  const size = 2 ** (32 - prefix);
  return Math.floor(x.base / size) === Math.floor(y.base / size);
}

/** Địa chỉ thứ `offset` tính từ địa chỉ mạng của khối (không kèm độ dài tiền tố) */
export function hostAddress(block: string, offset: number): string {
  const { base, prefix } = parse(block);
  const size = 2 ** (32 - prefix);
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) {
    throw new Error(`${block} không có địa chỉ thứ ${String(offset)}`);
  }
  return format(base - (base % size) + offset, 32).replace(/\/32$/, "");
}
