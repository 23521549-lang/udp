import { CHANGE_FEED } from "@udp/config";
import { createBatchJob, type BatchJob } from "../core/batch-job.js";

/**
 * Dọn `ConfigChangeLog` quá hạn (§2.2) — qua hàm `udp_prune_config_change_log`,
 * vì `udp_s2` không có DELETE trên bảng (§1.2). Retention nằm trong thân hàm, nên
 * job này chỉ quyết NHỊP và KÍCH THƯỚC LÔ, không quyết được xoá cái gì.
 *
 * Mỗi replica tự chạy, không bầu leader: hàm xoá theo lô và idempotent, hai replica
 * chạy song song chỉ làm lô sau xoá ít hơn (khoá hàng rời nhau, không chặn INSERT
 * mới). ADR-05 đã bỏ advisory lock khỏi đường đúng đắn; ở đây còn không cần tới.
 *
 * [v4.9] Nhịp, trần số lô mỗi lượt, `unref`, luật không chồng lượt và luật "không
 * ném ra vòng lặp" nay nằm ở `core/batch-job.ts`, dùng chung với job gộp stats.
 * Phần RIÊNG của việc dọn chỉ còn điều kiện dừng: lô trả về ít hơn `batchSize`
 * nghĩa là đã hết dòng quá hạn. Dọn là việc nền: hỏng thì ghi log và để lượt sau
 * thử lại, KHÔNG ném — bảng dài thêm một giờ không hại gì, còn một tiến trình
 * chết vì việc dọn thì hại.
 */

export interface PruneJobDeps {
  /** Xoá tối đa `batchSize` dòng quá hạn, trả số dòng đã xoá */
  prune: (batchSize: number) => Promise<number>;
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerRun?: number;
  random?: () => number;
}

/** Một lượt: lặp lô tới khi lô thiếu hoặc chạm trần. Không ném; trả tổng đã xoá */
export type PruneJob = BatchJob;

export function createPruneJob({
  prune,
  intervalMs = CHANGE_FEED.prune.intervalMs,
  batchSize = CHANGE_FEED.prune.batchSize,
  maxBatchesPerRun = CHANGE_FEED.prune.maxBatchesPerRun,
  random = Math.random,
}: PruneJobDeps): PruneJob {
  return createBatchJob({
    label: "config-change-log-prune",
    intervalMs,
    maxStepsPerRun: maxBatchesPerRun,
    random,
    messages: {
      done: "Đã dọn ConfigChangeLog quá hạn",
      failed: "Dọn ConfigChangeLog hỏng — lượt sau thử lại",
    },
    step: async () => {
      const deleted = await prune(batchSize);
      return { processed: deleted, more: deleted >= batchSize };
    },
  });
}
