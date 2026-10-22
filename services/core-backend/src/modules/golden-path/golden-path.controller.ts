import { Router } from "express";
import { REPO_SCAN } from "@udp/config";
import { asyncHandler, sendJson, validateBody } from "@udp/http";
import {
  goldenPathResponseWire,
  repoScanResponseWire,
} from "@udp/shared-types/wire";
import { z } from "zod";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as goldenPath from "./golden-path.service.js";

/**
 * Golden Path (§11, Plan #48). Cây tệp và lần quét — DEVELOPER, cùng bậc với template pipeline
 * (người đưa chúng vào repo); kết quả quét đã lưu — VIEWER, vì thẻ "Sẵn sàng cho flag-level rollout"
 * ở Tổng quan hiện cho mọi thành viên.
 */

export const repoScanBodySchema = z
  .object({ token: z.string().min(1).max(REPO_SCAN.tokenMaxLength).optional() })
  .strict();

export const projectGoldenPathRouter: Router = Router({ mergeParams: true });

projectGoldenPathRouter.get(
  "/golden-path",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      goldenPathResponseWire,
      await goldenPath.goldenPath(
        projectIdParam(req),
        await appDepsOf(req).domainRegistry(),
      ),
    );
  }),
);

projectGoldenPathRouter.get(
  "/repo-scan",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      repoScanResponseWire,
      await goldenPath.lastScan(projectIdParam(req)),
    );
  }),
);

projectGoldenPathRouter.post(
  "/repo-scan",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(repoScanBodySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof repoScanBodySchema>;
    const deps = appDepsOf(req);
    sendJson(
      res,
      repoScanResponseWire,
      await goldenPath.scan(
        projectIdParam(req),
        body.token,
        deps.repoSource,
        await deps.domainRegistry(),
      ),
    );
  }),
);
