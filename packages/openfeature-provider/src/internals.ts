import type { StatsOptions } from "./stats.js";
import type { ConfigStore } from "./store.js";
import type { SyncOptions } from "./sync.js";
import type { Transport } from "./transport.js";

/**
 * Chỗ tiêm cho test và phép đo (§6.8) [v4.8] — NẰM NGOÀI chữ ký công khai của
 * provider: tham số thứ hai của constructor từng kéo kiểu nội bộ (và qua chúng
 * `@udp/flag-evaluator`) vào `.d.ts` phát hành, khách ngoài monorepo nhận kiểu
 * không phân giải được. Ở đây chỉ `src/testing.ts` đặt khe; constructor đọc và
 * XOÁ khe ở lệnh đầu tiên — provider dựng sau không bao giờ nhặt nhầm, kể cả khi
 * constructor trước ném giữa chừng.
 */
export interface ProviderInternals {
  transport?: Transport;
  sync?: Partial<SyncOptions>;
  /** Chu kỳ báo cáo và các trần của `reportStats` (§6.8) */
  stats?: Partial<StatsOptions>;
  /** Cache do test giữ để so với `/sdk/config` (I15c) */
  store?: ConfigStore;
}

let pending: ProviderInternals | undefined;

/** Constructor gọi đúng một lần, trước mọi việc khác */
export function takeInternals(): ProviderInternals {
  const internals = pending ?? {};
  pending = undefined;
  return internals;
}

/** Dựng một đối tượng với khe đã đặt; khe luôn bị xoá khi `build` xong hoặc ném */
export function withInternals<T>(
  internals: ProviderInternals,
  build: () => T,
): T {
  pending = internals;
  try {
    return build();
  } finally {
    pending = undefined;
  }
}
