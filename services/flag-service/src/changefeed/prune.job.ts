import { CHANGE_FEED } from "@udp/config";
import { logger } from "@udp/http";

/**
 * Dọn `ConfigChangeLog` quá hạn (§2.2) — qua hàm `udp_prune_config_change_log`,
 * vì `udp_s2` không có DELETE trên bảng (§1.2). Retention nằm trong thân hàm, nên
 * job này chỉ quyết NHỊP và KÍCH THƯỚC LÔ, không quyết được xoá cái gì.
 *
 * Mỗi replica tự chạy, không bầu leader: hàm xoá theo lô và idempotent, hai replica
 * chạy song song chỉ làm lô sau xoá ít hơn (khoá hàng rời nhau, không chặn INSERT
 * mới). ADR-05 đã bỏ advisory lock khỏi đường đúng đắn; ở đây còn không cần tới.
 *
 * Dọn là việc nền: hỏng thì ghi log và để lượt sau thử lại, KHÔNG ném ra vòng lặp —
 * bảng dài thêm một giờ không hại gì, còn một tiến trình chết vì việc dọn thì hại.
 */

export interface PruneJobDeps {
  /** Xoá tối đa `batchSize` dòng quá hạn, trả số dòng đã xoá */
  prune: (batchSize: number) => Promise<number>;
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerRun?: number;
  random?: () => number;
}

export interface PruneJob {
  /** Một lượt: lặp lô tới khi lô thiếu hoặc chạm trần. Không ném; trả tổng đã xoá */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createPruneJob({
  prune,
  intervalMs = CHANGE_FEED.prune.intervalMs,
  batchSize = CHANGE_FEED.prune.batchSize,
  maxBatchesPerRun = CHANGE_FEED.prune.maxBatchesPerRun,
  random = Math.random,
}: PruneJobDeps): PruneJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;
  let started = false;

  const runOnce = (): Promise<number> => {
    // Không chồng lượt: một lượt đang bay thì người gọi thứ hai nhận đúng lượt đó
    if (running !== undefined) return running;

    running = (async () => {
      let total = 0;
      try {
        for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
          const deleted = await prune(batchSize);
          total += deleted;
          if (deleted < batchSize) break;
        }
        if (total > 0) {
          logger.info({ deleted: total }, "Đã dọn ConfigChangeLog quá hạn");
        }
      } catch (err) {
        logger.error(
          { err, deleted: total },
          "Dọn ConfigChangeLog hỏng — lượt sau thử lại",
        );
      }
      return total;
    })().finally(() => {
      running = undefined;
    });

    return running;
  };

  const schedule = (delayMs: number): void => {
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        schedule(intervalMs);
      });
    }, delayMs);
    timer.unref();
  };

  return {
    runOnce,

    start() {
      if (started) return;
      started = true;
      // Lần đầu trễ NGẪU NHIÊN trong một chu kỳ: các replica khởi động cùng lúc
      // (một lần deploy) không cùng dọn một lúc.
      schedule(Math.floor(random() * intervalMs));
    },

    stop() {
      started = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
