import { ROLLOUT_LEASE } from "@udp/config";
import { keepLease as keepLeaseCore, type LeaseKeeper } from "@udp/db";
import type { Fence } from "./fence.js";

/**
 * Giữ lease sống trong lúc một vòng đang làm việc (§7.1 `renew`) — nối lõi chung
 * `keepLease` của `@udp/db` với `Fence` của Service 3: mất lease ⇒ `fence.abort()`, fence đã
 * hủy ⇒ ngừng gia hạn. Luật "trả 0 hàng là mất thật, ném là thử lại tới hết thời gian sống
 * của lease" nằm ở lõi, một chỗ cho cả Service 1 và Service 3.
 */
export type { LeaseKeeper } from "@udp/db";

export interface LeaseKeeperOptions {
  renewIntervalMs: number;
  /** Thời gian sống của lease — quá mốc này kể từ lần gia hạn thành công cuối thì coi là mất */
  leaseMs: number;
  renew: () => Promise<boolean>;
  onLost?: (reason: string) => void;
  onRenewError?: (message: string) => void;
  errorRetryMs?: number;
  now?: () => number;
}

export function keepLease(
  fence: Fence,
  options: LeaseKeeperOptions,
): LeaseKeeper {
  return keepLeaseCore({
    renewIntervalMs: options.renewIntervalMs,
    leaseMs: options.leaseMs,
    errorRetryMs: options.errorRetryMs ?? ROLLOUT_LEASE.renewErrorRetryMs,
    renew: options.renew,
    onLost: (reason) => {
      fence.abort(reason);
      options.onLost?.(reason);
    },
    ...(options.onRenewError === undefined
      ? {}
      : { onRenewError: options.onRenewError }),
    isAbandoned: () => fence.aborted,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
