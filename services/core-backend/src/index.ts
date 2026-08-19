import { env } from "@udp/config";
import { prisma } from "@udp/db";
import { createApp } from "./app.js";
import { logger } from "./core/logger.js";

const app = createApp();
const server = app.listen(env.CORE_BACKEND_PORT, () => {
  logger.info(
    { port: env.CORE_BACKEND_PORT, env: env.NODE_ENV },
    "udp-core-backend đã khởi động",
  );
});

/**
 * Tắt êm.
 *
 * Không có phần này, khi Kubernetes gửi SIGTERM lúc rollout, tiến trình chết
 * ngay và những request đang xử lý dở bị đứt giữa chừng — với UDP thì đó có
 * thể là một job provisioning vừa tạo VPC nhưng chưa kịp ghi vào sổ tài nguyên.
 */
const shutdown = (signal: string) => {
  logger.info({ signal }, "Nhận tín hiệu dừng, đang đóng...");

  const forceExit = setTimeout(() => {
    logger.error("Không đóng kịp trong 10 giây, thoát cưỡng bức");
    process.exit(1);
  }, 10_000);

  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(forceExit);
    logger.info("Đã đóng sạch");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
