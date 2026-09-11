import { env } from "@udp/config";
import { logger } from "@udp/http";
import { assertServiceIdentity, prisma, SERVICE_ROLE } from "./core/db.js";
import {
  changeFeedWatcher,
  notifyAccelerator,
  pruneJob,
} from "./changefeed/index.js";
import { createApp } from "./app.js";
import { sseHub } from "./sdk/index.js";

/**
 * Khẳng định danh tính kết nối TRƯỚC khi mở cổng.
 *
 * Với Service 2 thì chốt này còn đáng giá hơn với Service 1. §1.2 chỉ cho
 * `udp_s2` UPDATE đúng hai cột của `environments`; nếu chuỗi kết nối rơi về
 * owner, giới hạn đó biến mất mà mọi thứ vẫn chạy đúng — cho tới ngày một lỗi
 * lập trình ghi đè `k8s_namespace` của một environment đang phục vụ thật.
 *
 * Thông điệp giữ nguyên chữ như Service 1 có chủ đích: `boot-identity.test.ts`
 * của cả hai service khẳng định đúng chuỗi này, nên đổi một bên là làm test bên
 * đó xanh vì lý do sai.
 */
try {
  await assertServiceIdentity();
  logger.info({ role: SERVICE_ROLE }, "Danh tính kết nối database đã xác nhận");
} catch (err) {
  logger.fatal({ err }, "Không khởi động: danh tính kết nối database sai");
  process.exit(1);
}

/**
 * Kênh LISTEN của tầng 3 là kết nối THỨ HAI, mang chuỗi riêng
 * (`DATABASE_URL_S2_DIRECT`), nên chốt ở trên KHÔNG phủ nó — phải chốt riêng,
 * cùng lý do và cùng chỗ: trước khi mở cổng.
 *
 * Hai kết cục, hai phản ứng ngược nhau, có chủ đích:
 *   - Sai role ⇒ KHÔNG khởi động. Chuỗi thứ hai rơi về owner là lỗi cấu hình cùng
 *     loại với chuỗi thứ nhất rơi về owner.
 *   - Không nối được ⇒ CHỈ cảnh báo. Tầng 3 là tuỳ chọn (ADR-05): thiếu nó thì
 *     cấu hình vẫn đúng nhờ tầng 1, chỉ chậm hơn, và kênh sẽ tự nối lại. Chặn
 *     khởi động vì nó là biến một bộ tăng tốc thành điểm chết của cả service.
 */
if (notifyAccelerator !== undefined) {
  const identity = await notifyAccelerator.verifyIdentity();
  if (identity.kind === "wrong-role") {
    logger.fatal(
      { actual: identity.actual, expected: SERVICE_ROLE },
      "Không khởi động: danh tính kết nối database sai ở kênh LISTEN của tầng 3 (DATABASE_URL_S2_DIRECT)",
    );
    process.exit(1);
  }
  if (identity.kind === "unreachable") {
    logger.warn(
      { err: identity.error },
      "Chưa nối được kênh LISTEN của tầng 3 — vẫn khởi động: tầng 1 giữ cấu hình đúng, kênh sẽ tự nối lại",
    );
  }
}

const app = createApp();
const server = app.listen(env.FLAG_SERVICE_PORT, () => {
  logger.info(
    { port: env.FLAG_SERVICE_PORT, env: env.NODE_ENV },
    "udp-feature-flag-service đã khởi động",
  );
});

/**
 * Vòng poll của change feed bắt đầu Ở ĐÂY, không phải trong `createApp()`.
 *
 * `app.ts` đã tự nói ra khuôn: `createApp()` tách khỏi `listen()` để test tích hợp
 * dựng được app trong bộ nhớ. Một `createApp()` khởi động timer sẽ bắn truy vấn
 * suốt mọi file test — đo được là ~24 vòng cho một file test 13 giây — trên đúng
 * pool 5 khe mà test đang dùng, mà không làm test đỏ. Tải chạy ngầm không ai thấy
 * là loại tệ hơn một test treo.
 *
 * Sau `listen` chứ không trước: vòng poll chỉ phục vụ những environment đang có
 * SDK đọc, mà chưa mở cổng thì chưa có ai đọc.
 */
changeFeedWatcher.start();

/** Dọn outbox quá hạn — cùng lý do với vòng poll: bắt đầu sau `listen`, không trong `createApp()` */
pruneJob.start();

/**
 * Tầng 3 nghe sau `listen`, cùng lý do với vòng poll: nó chỉ đánh thức vòng poll,
 * mà vòng poll chỉ phục vụ environment đang có SDK đọc.
 */
notifyAccelerator?.start();

/** Tắt êm — xem ghi chú cùng chỗ ở core-backend */
const shutdown = (signal: string) => {
  logger.info({ signal }, "Nhận tín hiệu dừng, đang đóng...");

  const forceExit = setTimeout(() => {
    logger.error("Không đóng kịp trong 10 giây, thoát cưỡng bức");
    process.exit(1);
  }, 10_000);

  /**
   * Thứ tự có chủ đích:
   *
   *   1. Đóng mọi stream SSE (kèm `retry:`) rồi ngừng nhận request — hai lời gọi
   *      LIỀN nhau: `server.close()` chờ mọi kết nối đóng, mà stream SSE không bao
   *      giờ tự đóng; thiếu `closeAll()` thì tắt máy luôn mất trọn 10 giây rồi
   *      thoát cưỡng bức. Từ đây mở stream mới nhận 503, nên không request nào
   *      chạm tới những thứ sắp dừng dưới đây.
   *   2. Tầng 3 → watcher → dọn outbox: thứ đánh thức dừng trước thứ bị đánh thức.
   *      (Đảo lại vẫn an toàn — `wake()` sau `stop()` là no-op — nhưng sự an toàn
   *      không nên phụ thuộc vào một chi tiết cài đặt.)
   *   3. Đóng pool CUỐI CÙNG, khi cổng HTTP và kênh LISTEN đã đóng hẳn. Ngược lại
   *      thì một vòng đang bay chạm pool vừa đóng và ném — một lỗi nổi lên đúng
   *      trên đường lẽ ra phải im lặng nhất.
   */
  sseHub.closeAll();
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  const listenerStopped = notifyAccelerator?.stop() ?? Promise.resolve();
  changeFeedWatcher.stop();
  pruneJob.stop();

  void Promise.all([httpClosed, listenerStopped])
    .then(() => prisma.$disconnect())
    .catch((err: unknown) => {
      logger.error({ err }, "Lỗi khi đóng kết nối database");
    })
    .finally(() => {
      clearTimeout(forceExit);
      logger.info("Đã đóng sạch");
      process.exit(0);
    });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
