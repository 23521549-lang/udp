import { Router } from "express";
import { asyncHandler, sendJson } from "@udp/http";
import { architectureResponseWire } from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { projectArchitecture } from "./architecture.service.js";

/**
 * [v4.11, Plan #53 QĐ-3] Sơ đồ kiến trúc của project — VIEWER: cùng bậc với trang Domain và Hạ tầng
 * (thành viên nào cũng được thấy hệ thống mình đang làm việc trên đó).
 */
export const architectureRouter: Router = Router({ mergeParams: true });

architectureRouter.get(
  "/architecture",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, architectureResponseWire, {
      architecture: await projectArchitecture(
        projectIdParam(req),
        await appDepsOf(req).domainRegistry(),
      ),
    });
  }),
);
