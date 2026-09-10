import { Router } from "express";
import { prisma } from "../../core/db.js";
import { asyncHandler } from "@udp/http";

export const healthRouter: Router = Router();

/** Liveness — tiến trình còn sống không. Không chạm database. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Readiness — có sẵn sàng nhận request không.
 * Khác liveness ở chỗ CÓ kiểm tra database: tiến trình sống nhưng mất kết nối
 * DB thì không phục vụ được, và Kubernetes cần biết để ngừng gửi traffic tới.
 */
healthRouter.get(
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
