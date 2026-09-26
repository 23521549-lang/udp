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
import { metricsRegistry } from "./core/metrics.js";
import { internalEnvConfigRouter } from "./internal/env-config.controller.js";
import { internalEnvironmentRouter } from "./internal/environment.controller.js";
import { internalFlagRouter } from "./internal/flag.controller.js";
import { internalRolloutRouter } from "./internal/rollout.controller.js";
import { internalRuleRouter } from "./internal/rule.controller.js";
import { internalSdkKeyRouter } from "./internal/sdk-key.controller.js";
import { internalSegmentRouter } from "./internal/segment.controller.js";
import { internalStatsRouter } from "./internal/stats.controller.js";
import { ofrepRouter } from "./ofrep/ofrep.controller.js";
import { sdkRouter, sdkStatsRouter } from "./sdk/sdk.controller.js";

/**
 * Ứng dụng của Service 2.
 *
 * Ba thứ core-backend có mà ở đây cố tình KHÔNG có, mỗi thứ một lý do:
 *
 *   - **CORS toàn cục**: Portal nói chuyện với S1, còn S1 và S3 gọi `/internal/*`
 *     từ máy tới máy. [v4.6] Ngoại lệ DUY NHẤT là `/ofrep/*` — khoá CLIENT gọi
 *     thẳng từ trình duyệt — và CORS của nó nằm trong chính router đó
 *     (`ofrep/cors.ts`), không lan ra bề mặt nào khác.
 *   - **cookie-parser và CSRF**: CSRF là biện pháp chống trình duyệt bị lừa gửi
 *     cookie kèm theo. Không có cookie, không có trình duyệt, thì nó chỉ chặn
 *     nhầm S1 và S3.
 *   - **rate limit theo IP toàn cục**: đã dựng, nhưng đúng trục và cạnh chính
 *     route — theo SDK KEY cho `/sdk/*`, theo IP rồi (khoá, IP) cho `/ofrep/*`
 *     (`auth/rate-limit.ts`).
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
  app.use(requestLogger);
  /**
   * [v4.6] OFREP mount TRƯỚC parser 1 MB toàn cục: router của nó có parser 16 KB
   * RIÊNG, đứng sau CORS và hai lớp rate limit. Mount sau dòng dưới thì trần 16 KB
   * vô nghĩa — body đã bị đọc xong trước khi tới đó.
   */
  app.use("/ofrep", ofrepRouter);
  /**
   * [v4.9] `POST /sdk/stats` mount TRƯỚC parser toàn cục, cùng lý do và cùng
   * khuôn với OFREP: router của nó có parser 2 MiB RIÊNG, và parser đó chỉ chạy
   * SAU rate limit và guard khoá SERVER. Mount sau dòng dưới thì một báo cáo hợp
   * lệ ở trần nhận 413 từ parser 1 MB, còn body của người lạ vẫn bị đọc trước khi
   * ai kiểm khoá (V15, INV-23.8).
   */
  app.use("/sdk", sdkStatsRouter);
  /**
   * [v4.9] `/internal/segments` mount TRƯỚC parser toàn cục, cùng lý do và cùng
   * khuôn: `conditions` của một segment ở trần schema lớn hơn 1 MB rất nhiều
   * (§2.1), nên router này có parser RIÊNG `SEGMENT.internalBodyLimitBytes` và
   * parser đó chỉ chạy SAU `requireInternalCaller`. Mount sau dòng dưới thì một
   * body hợp lệ sát trần nhận 413 từ parser 1 MB — và Service 1 không relay 413,
   * nên người dùng thấy 500 (V14, V15, INV-23.8).
   */
  app.use("/internal", internalSegmentRouter);
  app.use(express.json({ limit: "1mb" }));

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

  /**
   * [v4.8] Số đo vận hành (§9) — cùng khuôn `/metrics` của S1/S3: registry mặc
   * định, tiền tố `udp_flag_`. Ingress công khai không route tới đây.
   */
  app.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    }),
  );

  /**
   * [v4.9] `/internal/sdk-keys` mount SAU parser toàn cục, khác
   * `/internal/segments` ở trên: thân của nó là năm trường ngắn (dưới 300 byte),
   * nên trần 1 MB là dư và một parser riêng chỉ là một chỗ nữa để lệch (V15).
   */
  app.use(
    "/internal",
    internalFlagRouter,
    internalEnvConfigRouter,
    internalEnvironmentRouter,
    internalRuleRouter,
    internalRolloutRouter,
    internalStatsRouter,
    internalSdkKeyRouter,
  );

  /** Bề mặt SDK (§9). Guard và rate limit nằm trong chính router đó */
  app.use("/sdk", sdkRouter);

  app.use(notFoundHandler);
  app.use(errorHandler); // PHẢI đăng ký cuối cùng

  return app;
}
