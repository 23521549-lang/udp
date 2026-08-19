import { Router } from "express";
import { collectDefaultMetrics, register } from "prom-client";
import { asyncHandler } from "../../core/http/error-handler.js";

// Prometheus đã cấu hình scrape cổng 3001 trong docker/prometheus.yml
collectDefaultMetrics({ prefix: "udp_core_" });

export const metricsRouter: Router = Router();

metricsRouter.get(
  "/metrics",
  asyncHandler(async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  }),
);
