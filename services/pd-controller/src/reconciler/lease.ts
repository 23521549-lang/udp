import { ROLLOUT_LEASE } from "@udp/config";
import { errorMessage } from "../core/errors.js";
import type { Fence } from "./fence.js";

/**
 * Giữ lease sống trong lúc một vòng đang làm việc (§7.1 `renew`).
 *
 * Hai cách "gia hạn không thành" mang hai nghĩa khác nhau, và chúng được xử lý
 * khác nhau có chủ đích:
 *
 *   - `renew` trả `false` (0 hàng): worker khác đã claim, hoặc lease đã hết theo
 *     đồng hồ database. Đây là mất lease THẬT ⇒ `fence.abort()` ngay.
 *   - `renew` NÉM (database chập chờn, pool đầy): không biết gì cả. Lease vừa
 *     được gia hạn ≤ 20 giây trước và sống 60 giây, nên gần như chắc chắn còn;
 *     bỏ một rollback đang chạy vì một round trip hỏng là cái giá không đáng.
 *     Thử lại sớm (`renewErrorRetryMs`), và chỉ khi đã quá `leaseMs` kể từ lần
 *     gia hạn thành công cuối — lease chắc chắn hết — mới abort. Hành động sai
 *     vẫn không lọt: `If-Match` ở S2 và `updateIfVersion` là hai lưới cứng phía
 *     sau (I17, I23).
 *
 * `stop()` luôn được gọi trong `finally` của vòng; `unref()` chỉ là lưới phụ để
 * một vòng bị bỏ quên không giữ tiến trình sống mãi.
 */
export interface LeaseKeeper {
  stop(): void;
}

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
  const now = options.now ?? Date.now;
  const errorRetryMs = options.errorRetryMs ?? ROLLOUT_LEASE.renewErrorRetryMs;
  // Claim vừa xong là một lần "gia hạn thành công"
  let lastRenewedAt = now();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const lose = (reason: string): void => {
    fence.abort(reason);
    options.onLost?.(reason);
  };

  const schedule = (ms: number): void => {
    if (stopped || fence.aborted) return;
    timer = setTimeout(() => {
      void attempt();
    }, ms);
    timer.unref();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || fence.aborted) return;
    try {
      const kept = await options.renew();
      if (!kept) {
        lose("lease lost: renew trả 0 hàng");
        return;
      }
      lastRenewedAt = now();
      schedule(options.renewIntervalMs);
    } catch (err: unknown) {
      const message = errorMessage(err);
      if (now() - lastRenewedAt >= options.leaseMs) {
        lose(
          `lease lost: renew ném liên tục quá thời gian sống của lease — ${message}`,
        );
        return;
      }
      options.onRenewError?.(message);
      schedule(errorRetryMs);
    }
  };

  schedule(options.renewIntervalMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
