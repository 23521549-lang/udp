import { env, SDK_STATS } from "@udp/config";
import { logger } from "@udp/http";
import { assertServiceIdentity, prisma, SERVICE_ROLE } from "./core/db.js";
import {
  changeFeedWatcher,
  notifyAccelerator,
  pruneJob,
} from "./changefeed/index.js";
import { createApp } from "./app.js";
import { statsFlusher, statsRollupJob } from "./modules/stats/index.js";
import { sseHub, statsIngest } from "./sdk/index.js";

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
 * [v4.9] Telemetry: đẩy số đếm đang gộp xuống database, và gộp hàng giờ quá hạn
 * thành hàng ngày. Cùng lý do với hai job trên, và với một lý do riêng đắt hơn:
 * một flusher khởi động trong `createApp()` sẽ bắn truy vấn trong mọi file test
 * dựng app, trên đúng pool 5 khe mà test đang dùng (R13 (c)).
 */
statsFlusher.start();
statsRollupJob.start();

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
   *   3. [v4.9] Đẩy nốt số đếm telemetry TRƯỚC khi đóng pool, sau khi đã ngừng
   *      nhận báo cáo mới (`statsIngest.close()` ⇒ `/sdk/stats` trả 503). Tổng
   *      ngân sách `SDK_STATS.ingest.shutdownFlushTimeoutMs` (5 giây) nhỏ hơn hạn
   *      thoát cưỡng bức 10 giây ở trên, nên lần flush cuối không bao giờ là thứ
   *      làm tiến trình bị cắt ngang.
   *   4. Đóng pool CUỐI CÙNG, khi cổng HTTP và kênh LISTEN đã đóng hẳn. Ngược lại
   *      thì một vòng đang bay chạm pool vừa đóng và ném — một lỗi nổi lên đúng
   *      trên đường lẽ ra phải im lặng nhất.
   */
  sseHub.closeAll();
  statsIngest.close();
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  const listenerStopped = notifyAccelerator?.stop() ?? Promise.resolve();
  changeFeedWatcher.stop();
  pruneJob.stop();
  statsFlusher.stop();
  statsRollupJob.stop();

  /** `true` nếu `promise` xong trong `ms`; không huỷ gì, chỉ thôi chờ */
  const within = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      timer.unref();
      void promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  /**
   * HAI lần flush, và lần thứ hai là lần đáng giá nhất.
   *
   * `server.close()` chỉ ngừng nhận KẾT NỐI mới; một kết nối keep-alive đang mở
   * vẫn gửi thêm request, và OFREP vẫn đếm cho tới lúc nó đóng. Nên: chờ cổng
   * đóng nhiều nhất `shutdownHttpWaitMs` rồi flush lần một (không chờ vô điều
   * kiện — stream SSE có thể giữ `close()` lâu hơn cả ngân sách), rồi nếu cổng
   * đóng xong trong phần hạn còn lại thì flush lần hai để lấy những gì tới sau
   * lần một (C-10, G20).
   */
  const flushDeadline = Date.now() + SDK_STATS.ingest.shutdownFlushTimeoutMs;
  const remainingMs = (): number => Math.max(0, flushDeadline - Date.now());

  void (async () => {
    const closedEarly = await within(
      httpClosed,
      SDK_STATS.ingest.shutdownHttpWaitMs,
    );
    await statsFlusher.flushNow({ timeoutMs: remainingMs() });
    if (!closedEarly && (await within(httpClosed, remainingMs()))) {
      await statsFlusher.flushNow({ timeoutMs: remainingMs() });
    }
    await Promise.all([httpClosed, listenerStopped]);
    await prisma.$disconnect();
  })()
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
