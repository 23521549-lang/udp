import { env } from "@udp/config";
import { logger } from "@udp/http";
import { assertServiceIdentity, prisma } from "./core/db.js";
import { createApp } from "./app.js";

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
  logger.info({ role: "udp_s2" }, "Danh tính kết nối database đã xác nhận");
} catch (err) {
  logger.fatal({ err }, "Không khởi động: danh tính kết nối database sai");
  process.exit(1);
}

const app = createApp();
const server = app.listen(env.FLAG_SERVICE_PORT, () => {
  logger.info(
    { port: env.FLAG_SERVICE_PORT, env: env.NODE_ENV },
    "udp-feature-flag-service đã khởi động",
  );
});

/** Tắt êm — xem ghi chú cùng chỗ ở core-backend */
const shutdown = (signal: string) => {
  logger.info({ signal }, "Nhận tín hiệu dừng, đang đóng...");

  const forceExit = setTimeout(() => {
    logger.error("Không đóng kịp trong 10 giây, thoát cưỡng bức");
    process.exit(1);
  }, 10_000);

  server.close(() => {
    void prisma
      .$disconnect()
      .catch((err: unknown) => {
        logger.error({ err }, "Lỗi khi đóng kết nối database");
      })
      .finally(() => {
        clearTimeout(forceExit);
        logger.info("Đã đóng sạch");
        process.exit(0);
      });
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
