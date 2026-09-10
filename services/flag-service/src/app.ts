import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "@udp/config";
import {
  asyncHandler,
  errorHandler,
  notFoundHandler,
  requestLogger,
} from "@udp/http";
import { prisma } from "./core/db.js";
import { internalEnvConfigRouter } from "./internal/env-config.controller.js";
import { internalFlagRouter } from "./internal/flag.controller.js";
import { internalRuleRouter } from "./internal/rule.controller.js";
import { sdkRouter } from "./sdk/sdk.controller.js";

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
 *   - **rate limit theo IP**: đã dựng, nhưng đúng trục — theo SDK KEY, và nằm
 *     cạnh chính route `/sdk/*` chứ không phải toàn cục (`auth/rate-limit.ts`).
 *     `/internal/*` vẫn KHÔNG có: bên gọi là S1 và S3, và chặn một rollout đang
 *     chạy vì "quá nhiều yêu cầu" là tự gây ra sự cố tồi hơn thứ nó chặn.
 */
export function createApp(): Express {
  const app = express();

  /**
   * Số hop lấy từ cấu hình — giống Service 1, và ở đây thì BẮT BUỘC.
   *
   * `RATE_LIMIT.sdk.perKeyIp` đếm theo `(khóa, req.ip)`, mà Express chỉ suy `req.ip`
   * từ `X-Forwarded-For` khi biết số hop. Thiếu dòng này thì mọi SDK gom vào đúng
   * một bucket — IP của ingress — và trục thứ hai của §2.2 không đo thứ gì nữa. Đặt
   * CAO hơn thực tế còn tệ hơn: lúc đó `req.ip` lấy từ một entry do chính client ghi.
   */
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

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
  /**
   * Sẵn sàng nhận request chưa — CÓ chạm database, khác hẳn `/healthz`.
   *
   * Lời hứa "sẽ thêm cùng endpoint SDK" ở trên đến hạn ở đây, và với Service 2 nó
   * đáng giá hơn: `/sdk/config` phục vụ từ cache, nên một pod mất kết nối database
   * vẫn trả 200 kèm dữ liệu cũ. Đó đúng là hành vi ta muốn cho SDK (fail-static),
   * nhưng không phải điều muốn nói với Kubernetes về sức khoẻ của pod.
   */
  app.get(
    "/readyz",
    asyncHandler(async (_req, res) => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ready", database: "up" });
      } catch {
        res.status(503).json({ status: "not_ready", database: "down" });
      }
    }),
  );

  app.use(
    "/internal",
    internalFlagRouter,
    internalEnvConfigRouter,
    internalRuleRouter,
  );

  /** Bề mặt SDK (§9). Guard và rate limit nằm trong chính router đó */
  app.use("/sdk", sdkRouter);

  app.use(notFoundHandler);
  app.use(errorHandler); // PHẢI đăng ký cuối cùng

  return app;
}
