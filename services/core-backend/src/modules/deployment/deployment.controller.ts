import { Router } from "express";
import { asyncHandler, sendJson, uuidParam, validateQuery } from "@udp/http";
import {
  deployAcceptedResponseWire,
  deploymentListResponseWire,
  doraResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { approve } from "../cicd/deploy.service.js";
import * as deploymentService from "./deployment.service.js";
import {
  doraQuerySchema,
  listDeploymentsQuerySchema,
  type DoraQuery,
  type ListDeploymentsQuery,
} from "./deployment.types.js";

/**
 * Deployments và DORA (§9 "Deployments"). Đọc Event Store — VIEWER, cùng lý do với audit: lịch
 * sử deploy là thứ mọi thành viên cần để hiểu chuyện gì đã xảy ra. Bên ghi là webhook CI/CD
 * (§8.3, `modules/cicd`), job deploy và Service 3 (ROLLBACK của rollout FLAG_LEVEL); route ghi
 * DUY NHẤT ở đây là duyệt một deploy chờ — MAINTAINER, vì environment không cho deploy tự động
 * thường là production (§2.2).
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

deploymentRouter.post(
  "/deployments/:deploymentId/approve",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  asyncHandler(async (req, res) => {
    const outcome = await approve(
      projectIdParam(req),
      uuidParam(req, "deploymentId", "Mã deployment không hợp lệ"),
      req,
      appDepsOf(req).provisioning.enqueueDeploy,
    );
    sendJson(
      res,
      deployAcceptedResponseWire,
      outcome,
      outcome.status === "started" ? 202 : 200,
    );
  }),
);
