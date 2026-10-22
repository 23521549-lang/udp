import { Router } from "express";
import { asyncHandler, sendJson, validateQuery } from "@udp/http";
import { costQuerySchema, type CostQuery } from "@udp/shared-types/domain-api";
import { costResponseWire } from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { projectCost } from "./cost.service.js";

/**
 * Chi phí thực của project (Plan #38 QĐ-8). MAINTAINER — cùng bậc với con số chi phí ở bước xem
 * trước provisioning: tiền của khách không phải thứ mọi thành viên cần thấy.
 */
export const costRouter: Router = Router({ mergeParams: true });

costRouter.get(
  "/cost",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateQuery(costQuerySchema),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as CostQuery;
    sendJson(res, costResponseWire, {
      cost: await projectCost(
        projectIdParam(req),
        days,
        appDepsOf(req).provisioning.withCluster,
      ),
    });
  }),
);
