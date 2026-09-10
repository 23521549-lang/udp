import { env } from "@udp/config";
import { assertServiceIdentity, prisma } from "./core/db.js";
import { createApp } from "./app.js";
import { logger } from "@udp/http";

/**
 * Khẳng định danh tính kết nối TRƯỚC khi mở cổng.
 *
 * Nếu chuỗi kết nối rơi về user owner — quên đặt `DATABASE_URL_S1`, hoặc copy
 * nhầm — thì ma trận writer §1.2 mất hiệu lực hoàn toàn mà không có gì báo:
 * owner có toàn quyền nên mọi GRANT theo cột trở nên vô nghĩa, ứng dụng chạy
 * bình thường, và test vẫn xanh vì chúng dùng `SET ROLE` riêng. Sập lúc boot
 * với một câu rõ ràng là cách duy nhất để chuyện đó không im lặng.
 */
try {
  await assertServiceIdentity();
  logger.info({ role: "udp_s1" }, "Danh tính kết nối database đã xác nhận");
} catch (err) {
  // Bắt để ra MỘT dòng log đọc được, thay vì một unhandled rejection kèm stack
  // mà người trực đêm phải tự dịch.
  logger.fatal({ err }, "Không khởi động: danh tính kết nối database sai");
  process.exit(1);
}

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

  /**
   * Callback của `server.close` khai kiểu `(err?) => void`. Truyền một hàm
   * `async` vào đó là gửi một Promise cho bên KHÔNG await nó: nếu
   * `$disconnect()` ném lúc tắt máy, đó là một unhandled rejection ngay trong
   * đường tắt êm — vốn là đường phải im lặng nhất.
   */
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
