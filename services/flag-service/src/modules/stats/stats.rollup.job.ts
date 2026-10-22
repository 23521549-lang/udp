import { SDK_STATS } from "@udp/config";
import { createBatchJob, type BatchJob } from "../../core/batch-job.js";
import type { StatsRepository } from "./stats.repository.js";

/**
 * [v4.9] Retention của `flag_evaluation_stats` (§2.2, D8): hàng giờ cũ hơn
 * `SDK_STATS.retention.hourlyDays` được gộp thành MỘT hàng 00:00 UTC của ngày
 * đó; hàng ngày giữ vô hạn (365 hàng/năm cho mỗi (flag, env, variant) là không
 * đáng kể).
 *
 * Vì sao có job này ngay ở #23 chứ không hoãn: bảng không có trần nào khác
 * (~13 triệu hàng/năm ở 500 flag × 3 env × 3 variant), và hoãn là để lại đúng
 * loại nợ "tăng vô hạn" mà §2.2 sinh ra để tránh (R35).
 *
 * MỘT bước = MỘT ngày, tối đa `rollupMaxDaysPerRun` bước mỗi lượt — đây là lý do
 * job này không dùng được `createPruneJob`: vòng lặp của prune dừng khi lô trả về
 * ít hơn `batchSize`, nên một ngày ít hàng sẽ làm nó dừng sớm và những ngày cũ
 * hơn không bao giờ được gộp (B-07, C-14).
 */

export function createStatsRollupJob({
  repository,
  intervalMs = SDK_STATS.retention.rollupIntervalMs,
  maxDaysPerRun = SDK_STATS.retention.rollupMaxDaysPerRun,
  hourlyDays = SDK_STATS.retention.hourlyDays,
  random = Math.random,
}: {
  repository: StatsRepository;
  intervalMs?: number;
  maxDaysPerRun?: number;
  hourlyDays?: number;
  random?: () => number;
}): BatchJob {
  return createBatchJob({
    label: "stats-rollup",
    intervalMs,
    maxStepsPerRun: maxDaysPerRun,
    random,
    messages: {
      done: "Đã gộp stats hàng giờ quá hạn thành hàng ngày",
      failed: "Gộp stats quá hạn hỏng — lượt sau thử lại",
    },
    step: async () => {
      const deleted = await repository.rollupOldestDay(hourlyDays);
      return { processed: deleted, more: deleted > 0 };
    },
  });
}
