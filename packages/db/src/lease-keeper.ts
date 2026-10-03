/**
 * Giữ một lease sống trong lúc worker đang làm việc — MỘT hiện thực cho Service 3 (§7.1,
 * rollout) và worker job của Service 1 (ADR-02, provisioning).
 *
 * Hai cách "gia hạn không thành" mang hai nghĩa khác nhau, và chúng được xử lý khác nhau có
 * chủ đích:
 *
 *   - `renew` trả `false` (0 hàng): worker khác đã giành, hoặc lease đã hết theo đồng hồ
 *     database. Mất lease THẬT ⇒ `onLost` ngay.
 *   - `renew` NÉM (database chập chờn, pool đầy): không biết gì cả. Lease vừa được gia hạn
 *     và còn sống, nên bỏ việc đang chạy vì một round trip hỏng là cái giá không đáng. Thử
 *     lại sớm (`errorRetryMs`), và chỉ khi đã quá `leaseMs` kể từ lần gia hạn thành công
 *     cuối — lease chắc chắn hết — mới coi là mất. Hành động sai vẫn không lọt: fencing theo
 *     `version` là lưới cứng phía sau.
 *
 * `stop()` luôn được gọi trong `finally` của người dùng; `unref()` chỉ là lưới phụ để một
 * keeper bị bỏ quên không giữ tiến trình sống mãi.
 */
export interface LeaseKeeper {
  stop(): void;
}

export interface LeaseKeeperOptions {
  renewIntervalMs: number;
  /** Thời gian sống của lease — quá mốc này kể từ lần gia hạn thành công cuối thì coi là mất */
  leaseMs: number;
  errorRetryMs: number;
  renew: () => Promise<boolean>;
  onLost: (reason: string) => void;
  onRenewError?: (message: string) => void;
  /** Người dùng đã tự bỏ (fence của họ đã hủy) — keeper dừng gia hạn */
  isAbandoned?: () => boolean;
  now?: () => number;
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function keepLease(options: LeaseKeeperOptions): LeaseKeeper {
  const now = options.now ?? Date.now;
  const abandoned = options.isAbandoned ?? (() => false);
  // Claim vừa xong là một lần "gia hạn thành công"
  let lastRenewedAt = now();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (ms: number): void => {
    if (stopped || abandoned()) return;
    timer = setTimeout(() => {
      void attempt();
    }, ms);
    timer.unref();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || abandoned()) return;
    try {
      const kept = await options.renew();
      if (!kept) {
        options.onLost("lease lost: renew trả 0 hàng");
        return;
      }
      lastRenewedAt = now();
      schedule(options.renewIntervalMs);
    } catch (err: unknown) {
      const message = messageOf(err);
      if (now() - lastRenewedAt >= options.leaseMs) {
        options.onLost(
          `lease lost: renew ném liên tục quá thời gian sống của lease — ${message}`,
        );
        return;
      }
      options.onRenewError?.(message);
      schedule(options.errorRetryMs);
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
