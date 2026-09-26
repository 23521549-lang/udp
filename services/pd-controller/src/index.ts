import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env, ROLLOUT_POOL_HEADROOM } from "@udp/config";
import { createSessionConnector } from "@udp/db";
import { logger } from "@udp/http";
import { createApp } from "./app.js";
import { assertServiceIdentity, prisma, SERVICE_ROLE } from "./core/db.js";
import { createFlagLevelExecutor } from "./executors/flag-level.executor.js";
import { createKillSwitch } from "./executors/kill-switch.js";
import { createIntentListener } from "./intent/listener.js";
import { createMetricsProviders } from "./metrics/provider.js";
import { createCoreMetricsClient } from "./metrics/remote.js";
import { createReconciler } from "./reconciler/reconciler.js";
import { createUntracker } from "./tracking/untracker.js";

/**
 * Khẳng định danh tính kết nối TRƯỚC khi mở cổng — cùng chữ với hai service kia
 * (boot-identity test của cả ba khẳng định đúng chuỗi này).
 *
 * Với Service 3 chốt này canh ngoại lệ hẹp nhất của §1.2: `udp_s3` chỉ được ghi
 * `serve` của rule cho kill-switch. Rơi về owner là reconciler ghi được toàn bộ
 * cấu hình flag — và một bug của nó sẽ sửa flag của người dùng trong im lặng.
 */
try {
  await assertServiceIdentity();
  logger.info({ role: SERVICE_ROLE }, "Danh tính kết nối database đã xác nhận");
} catch (err) {
  logger.fatal({ err }, "Không khởi động: danh tính kết nối database sai");
  process.exit(1);
}

/**
 * Lệch đồng hồ giữa máy này và database — chỉ để LOG. Lease tính bằng `now()` của
 * database nên không phụ thuộc; nhưng dwell/analysis tính bằng đồng hồ JS so với
 * `last_step_at` cũng ghi bằng đồng hồ JS, nên một máy lệch nhiều là điều người
 * vận hành cần thấy sớm.
 */
try {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const skewMs = row === undefined ? 0 : row.now.getTime() - Date.now();
  logger.info({ skewMs }, "Lệch đồng hồ so với database");
} catch (err) {
  logger.warn({ err }, "Không đọc được đồng hồ database");
}

/** `<host>:<pid>:<random>` — thấy được trong `claimed_by`, khác nhau giữa các replica */
const workerId = `${hostname()}:${String(process.pid)}:${randomUUID().slice(0, 8)}`;

/**
 * [v4.11, Plan #39] Metrics theo environment của session, qua Service 1 (D-P30): S1 chọn nguồn
 * theo binding `metrics.query`, giữ khoá SaaS và đường tới Prometheus trong cluster.
 */
const providers = createMetricsProviders({
  client: createCoreMetricsClient({
    baseUrl: env.CORE_BACKEND_URL,
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
});

const executor = createFlagLevelExecutor({
  baseUrl: env.FLAG_SERVICE_URL,
  secret: env.INTERNAL_SERVICE_SECRET,
});

const untracker = createUntracker({ db: prisma, executor });

const reconciler = createReconciler({
  db: prisma,
  workerId,
  executor,
  providerFor: providers.forSession,
  onTerminal: (configId) => {
    untracker.afterTerminal(configId);
  },
  killSwitch: createKillSwitch({
    db: prisma,
    notify: env.CHANGEFEED_NOTIFY_ENABLED,
  }),
  // Mỗi session đang chạy giữ một khe transaction; chừa khe cho gia hạn lease và /readyz
  maxInFlight: Math.max(1, env.DATABASE_POOL_MAX - ROLLOUT_POOL_HEADROOM),
});

/**
 * Kênh `LISTEN rollout_intent` là kết nối THỨ HAI, mang chuỗi riêng
 * (`DATABASE_URL_S3_DIRECT`), nên chốt danh tính ở trên KHÔNG phủ nó — chốt riêng,
 * trước khi mở cổng, cùng hai kết cục như tầng 3 của S2: sai role ⇒ không khởi
 * động; không nối được ⇒ chỉ cảnh báo, vì vòng quét vẫn xử lý intent.
 */
const listenUrl = env.ROLLOUT_INTENT_LISTEN_ENABLED
  ? env.DATABASE_URL_S3_DIRECT
  : undefined;

const intentListener =
  listenUrl === undefined
    ? undefined
    : createIntentListener({
        connect: createSessionConnector(listenUrl),
        onIntent: (sessionId) => {
          reconciler.wake(sessionId);
        },
        onListening: () => {
          reconciler.nudge();
        },
      });

if (intentListener !== undefined) {
  const identity = await intentListener.verifyIdentity();
  if (identity.kind === "wrong-role") {
    logger.fatal(
      { actual: identity.actual, expected: SERVICE_ROLE },
      "Không khởi động: danh tính kết nối database sai ở kênh LISTEN rollout_intent (DATABASE_URL_S3_DIRECT)",
    );
    process.exit(1);
  }
  if (identity.kind === "unreachable") {
    logger.warn(
      { err: identity.error },
      "Chưa nối được kênh LISTEN rollout_intent — vẫn khởi động: vòng quét xử lý intent, kênh sẽ tự nối lại",
    );
  }
}

let shuttingDown = false;
const app = createApp({ isShuttingDown: () => shuttingDown });
const server = app.listen(env.PD_CONTROLLER_PORT, () => {
  logger.info(
    { port: env.PD_CONTROLLER_PORT, env: env.NODE_ENV, workerId },
    "udp-progressive-delivery-controller đã khởi động",
  );
});

/** Vòng quét và lưới gỡ nhãn bắt đầu SAU `listen`, không trong `createApp()` — cùng lý do với S2 */
reconciler.start();
untracker.start();
intentListener?.start();

const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Nhận tín hiệu dừng, đang đóng...");
  const forceExit = setTimeout(() => {
    logger.error("Không đóng kịp trong 10 giây, thoát cưỡng bức");
    process.exit(1);
  }, 10_000);

  /**
   * Thứ tự: vòng quét dừng và NHẢ lease của các session đang giữ (fence đóng với
   * lý do shutdown, side effect kế tiếp không chạy, `finally` nhả lease), rồi cổng
   * HTTP đóng, pool đóng CUỐI CÙNG. Replica khác nhận lại session ngay ở vòng kế,
   * không phải chờ 60 giây lease hết hạn.
   */
  providers.stop();
  const listenerStopped = intentListener?.stop() ?? Promise.resolve();
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  void Promise.all([
    listenerStopped,
    reconciler.stop(),
    untracker.stop(),
    httpClosed,
  ])
    .then(() => prisma.$disconnect())
    .catch((err: unknown) => {
      logger.error({ err }, "Lỗi khi đóng");
    })
    .finally(() => {
      clearTimeout(forceExit);
      logger.info("Đã đóng sạch");
      process.exit(0);
    });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
