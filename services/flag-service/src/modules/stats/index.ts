import { env, SDK_STATS } from "@udp/config";
import { prisma } from "../../core/db.js";
import { metrics } from "../../core/metrics.js";
import { createStatsAggregator } from "./stats.aggregator.js";
import { createStatsFlusher } from "./stats.flusher.js";
import { createStatsRepository } from "./stats.repository.js";
import { createStatsRollupJob } from "./stats.rollup.job.js";

/**
 * [v4.9] Nơi ráp telemetry của tiến trình này — và là nơi DUY NHẤT, cùng lý do
 * cache snapshot là một thể (`changefeed/index.ts`): bộ gộp phải là MỘT thể dùng
 * chung giữa ba bên ghi vào nó (`/sdk/stats`, OFREP) và bên đọc ra (flusher). Hai
 * thể nghĩa là một nửa số đếm nằm trong một Map không ai ghi xuống database.
 *
 * Timer KHÔNG khởi động ở đây và cũng không ở `createApp()`: `index.ts` gọi
 * `start()` sau `listen`. Một `createApp()` khởi động flusher sẽ bắn truy vấn
 * suốt mọi file test dựng app, trên đúng pool 5 khe mà test đang dùng, mà không
 * làm test đỏ — loại tải chạy ngầm không ai thấy (R13 (c)).
 */

export const statsRepository = createStatsRepository(prisma);

export const statsAggregator = createStatsAggregator({
  maxPendingEntries: SDK_STATS.ingest.maxPendingEntries,
  maxPendingEntriesPerEnvironment:
    SDK_STATS.ingest.maxPendingEntriesPerEnvironment,
  onDrop: (reason, count) => {
    metrics.statsDropped.inc({ reason }, count);
  },
});

/**
 * Chu kỳ lấy từ biến môi trường (mặc định `SDK_STATS.ingest.flushIntervalMs`):
 * test provider dựng Service 2 làm tiến trình con cần chu kỳ ngắn để không chờ
 * 15 giây mỗi ca (T5).
 */
export const statsFlusher = createStatsFlusher({
  aggregator: statsAggregator,
  upsertBatch: (rows) => statsRepository.upsertBatch(rows),
  intervalMs: env.SDK_STATS_FLUSH_INTERVAL_MS,
  onFlushed: (rows, seconds) => {
    metrics.statsRowsFlushed.inc(rows);
    metrics.statsFlushSeconds.observe(seconds);
  },
});

export const statsRollupJob = createStatsRollupJob({
  repository: statsRepository,
});
