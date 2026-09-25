import { Router } from "express";
import { asyncHandler, sendJson, validateQuery } from "@udp/http";
import {
  deploymentListResponseWire,
  doraResponseWire,
} from "@udp/shared-types/wire";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as deploymentService from "./deployment.service.js";
import {
  doraQuerySchema,
  listDeploymentsQuerySchema,
  type DoraQuery,
  type ListDeploymentsQuery,
} from "./deployment.types.js";

/**
 * Deployments và DORA (§9 "Deployments") — CHỈ ĐỌC Event Store. Ghi là việc của webhook
 * CI/CD (§8.3, chưa có) và của Service 3 (ROLLBACK của rollout FLAG_LEVEL).
 *
 * VIEWER đọc được: cùng lý do với audit — lịch sử deploy là thứ mọi thành viên cần để
 * hiểu chuyện gì đã xảy ra.
 */
export const deploymentRouter: Router = Router({ mergeParams: true });

deploymentRouter.get(
  "/deployments",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listDeploymentsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, deploymentListResponseWire, {
      deployments: await deploymentService.list(
        projectIdParam(req),
        req.query as unknown as ListDeploymentsQuery,
      ),
    });
  }),
);

deploymentRouter.get(
  "/metrics/dora",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(doraQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, doraResponseWire, {
      dora: await deploymentService.dora(
        projectIdParam(req),
        req.query as unknown as DoraQuery,
      ),
    });
  }),
);
