import { activeKeysAmong } from "../auth/sdk-key.guard.js";
import {
  changeFeed,
  changeFeedWatcher,
  configCache,
  configChanges,
} from "../changefeed/index.js";
import { metrics } from "../core/metrics.js";
import { statsAggregator } from "../modules/stats/index.js";
import { createStatsIngest } from "../modules/stats/stats.ingest.js";
import { createSseHub } from "./sse.manager.js";

/**
 * Nơi ráp bề mặt SDK — MỘT hub SSE cho cả tiến trình, cùng lý do cache là một
 * thể: hub nghe `configChanges`, và hai hub nghĩa là một nửa số stream không
 * nhận được sự kiện nào.
 *
 * Hướng phụ thuộc là `sdk → changefeed`: hub tự đăng ký nghe, watcher không biết
 * có ai nghe. Hub không có timer nào khi không có stream, nên test dựng app mà
 * không mở stream không tốn một truy vấn nền nào.
 */
export const sseHub = createSseHub({
  cache: configCache,
  statesOf: (environmentIds) => changeFeed.statesOf(environmentIds),
  wake: () => {
    changeFeedWatcher.wake();
  },
  activeKeysAmong,
  recordWrite: (kind, bytes) => {
    metrics.sseBytes.inc({ event: kind }, bytes);
  },
});

configChanges.subscribe((change) => {
  sseHub.onChange(change);
});

/**
 * [v4.9] Cửa vào của telemetry — ráp Ở ĐÂY chứ không ở `modules/stats/index.ts`,
 * vì nó là chỗ duy nhất cần biết cả bộ gộp lẫn cache snapshot. Nhờ vậy
 * `modules/stats` không phụ thuộc `changefeed/` (V18) và cửa vào vẫn đi cùng bề
 * mặt SDK — nơi duy nhất gọi nó.
 */
export const statsIngest = createStatsIngest({
  cache: configCache,
  aggregator: statsAggregator,
});
