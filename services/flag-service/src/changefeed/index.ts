import { env } from "@udp/config";
import { prisma } from "../core/db.js";
import { postgresChangeFeed } from "./change-feed.interface.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { createSnapshotCache, prismaEntryLoader } from "./snapshot.cache.js";
import { createVersionWatcher } from "./version.watcher.js";

/**
 * Nơi ráp change feed của tiến trình này — và là nơi DUY NHẤT.
 *
 * Cache phải là một thể duy nhất dùng chung giữa hai bên: `/sdk/config` đọc từ
 * nó, còn watcher cập nhật nó. Hai thể riêng nghĩa là watcher chăm sóc một cache
 * mà không ai đọc, còn SDK đọc một cache không ai làm mới — và triệu chứng là
 * cấu hình không bao giờ đổi, ở đúng tính năng sinh ra để làm cấu hình đổi nhanh.
 *
 * Vòng lặp KHÔNG khởi động ở đây và cũng không ở `createApp()`. `app.ts` tự nói
 * ra khuôn đó: "tách khỏi `listen()` để test tích hợp dựng được app trong bộ
 * nhớ". Một `createApp()` khởi động timer sẽ bắn truy vấn trong suốt mọi file
 * test dựng app — đo được là ~24 vòng cho một file test 13 giây, tức hàng trăm
 * truy vấn thừa trên đúng pool 5 khe mà test đang dùng. Nó không làm test đỏ, và
 * đó mới là chỗ tệ: một khoản tải chạy ngầm không ai thấy.
 */

export const configCache = createSnapshotCache(prismaEntryLoader(prisma));

export const changeFeedWatcher = createVersionWatcher({
  feed: postgresChangeFeed(prisma),
  cache: configCache,
  breaker: createCircuitBreaker(),
  deltaMode: env.CHANGEFEED_MODE === "delta",
});

export type { ConfigEntry } from "./snapshot.cache.js";
