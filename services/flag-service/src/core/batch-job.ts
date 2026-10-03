import { logger } from "@udp/http";

/**
 * [v4.9] Đồng hồ định kỳ của MỌI việc nền chạy theo lô trong Service 2 — nguồn
 * duy nhất (R8): dọn `ConfigChangeLog` (`changefeed/prune.job.ts`), gộp stats
 * hàng giờ thành hàng ngày (`modules/stats/stats.rollup.job.ts`), và đẩy số đếm
 * telemetry xuống database (`modules/stats/stats.flusher.ts`).
 *
 * Thứ job nào cũng cần và không job nào nên tự viết lại:
 *
 *   - **Không chồng lượt.** Người gọi thứ hai nhận đúng lượt đang bay, không mở
 *     lượt thứ hai trên cùng dữ liệu.
 *   - **Lần đầu trễ ngẫu nhiên trong một chu kỳ.** N replica khởi động cùng lúc
 *     (một lần deploy) thì không cùng chạm database một lúc.
 *   - **`unref`.** Một job nền không được giữ tiến trình sống.
 *   - **Không ném ra vòng lặp.** Việc nền hỏng thì ghi log và để lượt sau thử
 *     lại: bảng dài thêm một giờ không hại gì, còn một tiến trình chết vì việc
 *     dọn thì hại.
 *
 * Phần KHÁC nhau giữa các job nằm hết trong `step`: nó tự quyết một "bước" là
 * gì (một lô 1 000 dòng, một ngày stats, một lượt flush) và tự nói còn việc hay
 * không. Nhờ vậy `createPruneJob` dừng khi lô thiếu, còn rollup dừng khi không
 * còn ngày nào — hai điều kiện dừng khác nhau mà không cần hai vòng lặp.
 */

export interface BatchStepResult {
  /** Số đơn vị đã xử lý ở bước này — chỉ để log và cho người gọi cộng dồn */
  processed: number;
  /** Còn việc nên chạy tiếp bước nữa trong CÙNG lượt này không */
  more: boolean;
}

export interface BatchJobMessages {
  /**
   * Câu log mức `info` khi một lượt xử lý được ít nhất một đơn vị. Vắng nghĩa là
   * không log — đúng cho job chạy mỗi 15 giây, thứ mà một dòng log mỗi lượt chỉ
   * là tiếng ồn; số liệu của nó đi bằng `/metrics`.
   */
  done?: string;
  /** Câu log mức `error` khi một bước ném */
  failed: string;
}

export interface BatchJobDeps {
  /** Nhãn đi cùng mọi dòng log của job này */
  label: string;
  step: () => Promise<BatchStepResult>;
  intervalMs: number;
  maxStepsPerRun: number;
  messages: BatchJobMessages;
  random?: () => number;
}

export interface BatchJob {
  /** Một lượt: lặp bước tới khi hết việc hoặc chạm trần. Không ném; trả tổng đã xử lý */
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createBatchJob({
  label,
  step,
  intervalMs,
  maxStepsPerRun,
  messages,
  random = Math.random,
}: BatchJobDeps): BatchJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;
  let started = false;

  const runOnce = (): Promise<number> => {
    // Không chồng lượt: một lượt đang bay thì người gọi thứ hai nhận đúng lượt đó
    if (running !== undefined) return running;

    running = (async () => {
      let total = 0;
      try {
        for (let i = 0; i < maxStepsPerRun; i += 1) {
          const result = await step();
          total += result.processed;
          if (!result.more) break;
        }
        if (total > 0 && messages.done !== undefined) {
          logger.info({ label, processed: total }, messages.done);
        }
      } catch (err) {
        logger.error({ err, label, processed: total }, messages.failed);
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
      schedule(Math.floor(random() * intervalMs));
    },

    stop() {
      started = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
