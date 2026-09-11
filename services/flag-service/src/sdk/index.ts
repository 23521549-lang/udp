import { activeKeysAmong } from "../auth/sdk-key.guard.js";
import {
  changeFeed,
  changeFeedWatcher,
  configCache,
  configChanges,
} from "../changefeed/index.js";
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
});

configChanges.subscribe((change) => {
  sseHub.onChange(change);
});
