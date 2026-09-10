import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler, notFoundHandler, requestLogger } from "@udp/http";
import { internalFlagRouter } from "./internal/flag.controller.js";

/**
 * Ứng dụng của Service 2.
 *
 * Ba thứ core-backend có mà ở đây cố tình KHÔNG có, mỗi thứ một lý do:
 *
 *   - **CORS**: S2 không phục vụ trình duyệt. Portal nói chuyện với S1, còn S1
 *     và S3 gọi `/internal/*` từ máy tới máy. Bật CORS ở đây là mở một mặt tấn
 *     công cho thứ không có người dùng nào.
 *   - **cookie-parser và CSRF**: CSRF là biện pháp chống trình duyệt bị lừa gửi
 *     cookie kèm theo. Không có cookie, không có trình duyệt, thì nó chỉ chặn
 *     nhầm S1 và S3.
 *   - **rate limit theo IP**: SDK gọi `/sdk/*` sẽ cần, nhưng đúng theo SDK key
 *     chứ không theo IP (§3.2 `auth/rate-limit.ts`). Chưa có endpoint SDK trong
 *     lát cắt này nên chưa dựng — thêm một giới hạn sai trục còn tệ hơn không có.
 */
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  /**
   * Sống/chết cho hạ tầng. Cố tình KHÔNG chạm database: `/healthz` trả lời câu
   * "tiến trình còn sống không", không phải "database còn không" — nhầm hai câu
   * đó làm Kubernetes giết cả pod khi database chập chờn, đúng lúc không nên.
   * Kiểm database thuộc về `/readyz`, sẽ thêm cùng endpoint SDK.
   */
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  /**
   * `/internal/*` KHONG duoc phoi ra Internet — §9 noi ro. O tang ha tang, dieu
   * do do NetworkPolicy va Ingress dam bao; o day chi co bi mat dung chung, la
   * lop phong khi hai thu kia bi cau hinh sai.
   */
  app.use("/internal", internalFlagRouter);

  app.use(notFoundHandler);
  app.use(errorHandler); // PHẢI đăng ký cuối cùng

  return app;
}
