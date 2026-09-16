import express, { type Express } from "express";
import helmet from "helmet";
import {
  asyncHandler,
  errorHandler,
  notFoundHandler,
  requestLogger,
} from "@udp/http";
import { prisma } from "./core/db.js";
import { metricsRegistry } from "./core/metrics.js";

/**
 * Bề mặt HTTP của Service 3 — hai endpoint vận hành §9 khai (`/healthz`,
 * `/metrics`) cộng `/readyz` cùng nghĩa với hai service kia. Không có API
 * nghiệp vụ: S3 là background worker, mọi ý định của người dùng đi qua S1 và
 * bảng `rollout_events` (§7.6), không qua HTTP của S3.
 *
 * `createApp()` tách khỏi `listen()` và KHÔNG khởi động vòng reconciliation —
 * cùng khuôn với hai service kia: test dựng app trong bộ nhớ mà không có timer
 * nào bắn truy vấn nền.
 */
export interface AppOptions {
  /** Đang tắt ⇒ `/readyz` trả 503 ngay để Kubernetes ngừng gửi traffic, dù pool còn sống */
  isShuttingDown?: () => boolean;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.use(helmet());
  app.use(requestLogger);

  /** Sống/chết — không chạm database (xem chú thích cùng chỗ ở flag-service) */
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get(
    "/readyz",
    asyncHandler(async (_req, res) => {
      if (options.isShuttingDown?.() === true) {
        res.status(503).json({ status: "not_ready", reason: "shutting_down" });
        return;
      }
      try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ready", database: "up" });
      } catch {
        res.status(503).json({ status: "not_ready", database: "down" });
      }
    }),
  );

  app.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
