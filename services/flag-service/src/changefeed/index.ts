import { env } from "@udp/config";
import { createSessionConnector } from "@udp/db";
import { prisma, SERVICE_ROLE } from "../core/db.js";
import { postgresChangeFeed } from "./change-feed.interface.js";
import { createConfigChangeEvents } from "./change-events.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { createNotifyAccelerator } from "./notify.accelerator.js";
import { createPruneJob } from "./prune.job.js";
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

/**
 * Sự kiện "cấu hình đổi" của tiến trình này — MỘT kênh, cùng lý do cache là một
 * thể: watcher phát vào đây, còn `sdk/` (hub SSE) tự đăng ký nghe. Changefeed không
 * import `sdk/`.
 */
export const configChanges = createConfigChangeEvents();

/**
 * Hai phép đọc của ADR-05 trên Postgres — MỘT thể, dùng chung cho watcher và cho
 * hub SSE (hỏi version thật khi con trỏ của SDK đi trước replica này).
 */
export const changeFeed = postgresChangeFeed(prisma);

export const changeFeedWatcher = createVersionWatcher({
  feed: changeFeed,
  cache: configCache,
  breaker: createCircuitBreaker(),
  deltaMode: env.CHANGEFEED_MODE === "delta",
  events: configChanges,
});

/**
 * Dọn `ConfigChangeLog` quá hạn (§2.2) qua hàm SQL — `udp_s2` không có DELETE.
 *
 * `$queryRaw` chứ không `$executeRaw`: cần đọc số dòng hàm trả về. Hàm khai
 * `RETURNS integer` nên về tới đây là `number` (đã đo), không phải `bigint`.
 */
export const pruneJob = createPruneJob({
  prune: async (batchSize) => {
    const rows = await prisma.$queryRaw<{ deleted: number }[]>`
      SELECT udp_prune_config_change_log(${batchSize}::int) AS deleted`;
    return rows[0]?.deleted ?? 0;
  },
});

/**
 * Tầng 3 (ADR-05) — CHỈ dựng khi `CHANGEFEED_NOTIFY_ENABLED`. Tắt cờ là tắt cả hai
 * phía: writer thôi `NOTIFY` (`core/outbox.ts`), replica thôi nghe — nên cấu hình
 * "không NOTIFY" của phép đo E4 là đối chứng sạch.
 *
 * Dựng ở đây KHÔNG mở kết nối nào: `connect` chỉ chạy khi `index.ts` gọi
 * `verifyIdentity()` hay `start()`, nên test dựng app không mở kênh. Chuỗi kết nối
 * thì được kiểm NGAY (`createSessionConnector`), cùng lúc với chuỗi của pool.
 * `@udp/config` đã bắt buộc `DATABASE_URL_S2_DIRECT` khi cờ bật; nhánh `undefined`
 * chỉ để TypeScript thấy điều mà `superRefine` đã bảo đảm.
 */
const listenUrl = env.CHANGEFEED_NOTIFY_ENABLED
  ? env.DATABASE_URL_S2_DIRECT
  : undefined;

export const notifyAccelerator =
  listenUrl === undefined
    ? undefined
    : createNotifyAccelerator({
        connect: createSessionConnector(listenUrl),
        expectedRole: SERVICE_ROLE,
        holds: (environmentId) => configCache.holds(environmentId),
        wake: () => {
          changeFeedWatcher.wake();
        },
      });

export type { ConfigEntry } from "./snapshot.cache.js";
export type { ConfigChange, ConfigChangeEvents } from "./change-events.js";
