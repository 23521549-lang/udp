import { Router } from "express";
import { asyncHandler, sendJson, validateBody } from "@udp/http";
import { buildSettingsSchema, type BuildSettings } from "@udp/shared-types";
import { buildViewWire } from "@udp/shared-types/wire";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as packaging from "./packaging.service.js";

/**
 * [Plan #61 QĐ-9] Đóng gói: xem — VIEWER (mọi thành viên thấy pipeline build thế nào); đổi — MAINTAINER, vì danh
 * tính build quyết định CI nào được đẩy image vào registry của project.
 */
export const projectPackagingRouter: Router = Router({ mergeParams: true });

projectPackagingRouter.get(
  "/build",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      buildViewWire,
      await packaging.buildView(projectIdParam(req)),
    );
  }),
);

projectPackagingRouter.put(
  "/build",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(buildSettingsSchema),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      buildViewWire,
      await packaging.updateBuildSettings(
        projectIdParam(req),
        req.body as BuildSettings,
        req,
      ),
    );
  }),
);
