import { Router } from "express";
import { asyncHandler, sendJson, validateQuery } from "@udp/http";
import { redQuerySchema, type RedQuery } from "@udp/shared-types/domain-api";
import { redMetricsResponseWire } from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { redMetrics } from "./monitoring.service.js";

/**
 * [v4.11, Plan #53 QĐ-4] Trang Giám sát — VIEWER: số đo vận hành của hệ thống mình đang làm việc trên
 * đó, cùng bậc với DORA (`/metrics/dora`). Chi phí vẫn là MAINTAINER (route riêng).
 */
export const monitoringRouter: Router = Router({ mergeParams: true });

monitoringRouter.get(
  "/metrics/red",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(redQuerySchema),
  asyncHandler(async (req, res) => {
    const deps = appDepsOf(req);
    sendJson(res, redMetricsResponseWire, {
      metrics: await redMetrics({
        projectId: projectIdParam(req),
        query: req.query as unknown as RedQuery,
        registry: await deps.domainRegistry(),
        metricsFor: deps.metricsFor,
      }),
    });
  }),
);
