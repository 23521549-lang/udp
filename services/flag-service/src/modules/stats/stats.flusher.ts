import { SDK_STATS } from "@udp/config";
import { createBatchJob } from "../../core/batch-job.js";
import type { StatsAggregator, StatsRow } from "./stats.aggregator.js";

/**
 * [v4.9] Đẩy số đếm đang gộp trong bộ nhớ xuống `flag_evaluation_stats` theo chu
 * kỳ (§6.8) — dựng trên `core/batch-job.ts`, nên nhịp, `unref` và luật không
 * chồng lượt là CÙNG một cài đặt với job dọn outbox và job gộp stats.
 *
 * At-least-once có chủ đích: một lỗi mạng SAU khi commit làm lô được cộng hai
 * lần. Đếm THỪA an toàn hơn đếm THIẾU — thiếu thì flag bị xếp UNUSED, archive
 * lọt chốt 7 ngày, và app của khách vỡ (R18, R01).
 */

export interface StatsFlusherDeps {
  aggregator: StatsAggregator;
  /** Ghi một lô ≤ `batchRows` hàng; ném nếu không ghi được */
  upsertBatch: (rows: readonly StatsRow[]) => Promise<void>;
  intervalMs: number;
  batchRows?: number;
  /** Đã ghi xong một lượt: số hàng và thời gian, cho `/metrics` */
  onFlushed?: (rows: number, seconds: number) => void;
  now?: () => number;
  random?: () => number;
}

export interface StatsFlusher {
  /** Một lượt: lấy hết số đang giữ rồi ghi theo lô. Không ném; trả số hàng đã ghi */
  runOnce(): Promise<number>;
  /**
   * Đẩy nốt trong hạn `timeoutMs` (lúc tắt máy): CHỜ lượt đang bay xong rồi lấy
   * thêm một lượt nữa. Thiếu bước chờ thì `runOnce` thứ hai nhận đúng lượt đang
   * bay và những gì `record` sau khi lượt đó `drain` sẽ mất (C-10).
   */
  flushNow(options: { timeoutMs: number }): Promise<void>;
  start(): void;
  stop(): void;
}

export function createStatsFlusher({
  aggregator,
  upsertBatch,
  intervalMs,
  batchRows = SDK_STATS.ingest.flushBatchRows,
  onFlushed,
  now = Date.now,
  random = Math.random,
}: StatsFlusherDeps): StatsFlusher {
  /**
   * Một "bước" của flusher là TRỌN một lượt: lấy hết số đang giữ rồi ghi từng
   * lô. Không chia thành nhiều bước vì `drain()` đã lấy hết — bước thứ hai trong
   * cùng lượt chỉ thấy Map rỗng.
   *
   * Lô nào ghi hỏng thì phần CHƯA ghi (gồm chính lô đó) được cộng ngược vào bộ
   * gộp rồi ném: lượt sau thử lại, và số đếm chỉ mất khi bộ gộp đã chạm trần
   * (`flush-failed`). Phần đã ghi không bị trả lại — trả lại là tự tạo ra đếm đôi.
   */
  const step = async (): Promise<{ processed: number; more: boolean }> => {
    const rows = aggregator.drain();
    if (rows.length === 0) return { processed: 0, more: false };

    const startedAt = now();
    for (let i = 0; i < rows.length; i += batchRows) {
      const batch = rows.slice(i, i + batchRows);
      try {
        await upsertBatch(batch);
      } catch (err) {
        aggregator.restore(rows.slice(i));
        throw err;
      }
    }
    onFlushed?.(rows.length, (now() - startedAt) / 1_000);
    return { processed: rows.length, more: false };
  };

  const job = createBatchJob({
    label: "stats-flush",
    step,
    intervalMs,
    maxStepsPerRun: 1,
    random,
    // Không có câu `done`: một dòng log mỗi 15 giây là tiếng ồn, số liệu đi bằng
    // `udp_flag_stats_rows_flushed_total`
    messages: {
      failed:
        "Đẩy số đếm stats xuống database hỏng — giữ lại, lượt sau thử lại",
    },
  });

  return {
    runOnce: job.runOnce,
    start: job.start,
    stop: job.stop,

    async flushNow({ timeoutMs }) {
      /**
       * Hạn là hạn của CẢ hai lượt. Hết hạn thì trả về ngay chứ không huỷ lượt
       * đang bay: một câu UPSERT đang trên đường không có cách nào rút lại, và
       * chờ thêm ở đây là ăn vào ngân sách tắt máy của `index.ts`.
       */
      let expire: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        expire = setTimeout(resolve, timeoutMs);
        expire.unref();
      });
      try {
        await Promise.race([
          (async () => {
            await job.runOnce();
            await job.runOnce();
          })(),
          deadline,
        ]);
      } finally {
        clearTimeout(expire);
      }
    },
  };
}
