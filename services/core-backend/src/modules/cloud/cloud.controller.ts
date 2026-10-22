import { Router } from "express";
import { asyncHandler, sendJson, validateBody, validateQuery } from "@udp/http";
import {
  cloudSetupQuerySchema,
  putCloudBodySchema,
  type CloudSetupQuery,
  type PutCloudBody,
} from "@udp/shared-types/cloud-api";
import {
  cloudPreflightResponseWire,
  cloudResponseWire,
  cloudSetupResponseWire,
  cloudValidationResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as cloudService from "./cloud.service.js";

/**
 * Bước cloud của project (§9, Plan #26 QĐ-7).
 *
 * Đọc — MAINTAINER: cấu hình lộ thông tin tài khoản của khách (cloud, region, cơ chế)
 * nhưng không lộ bí mật. Ghi và kiểm — OWNER (§2.2 "OWNER quản lý credential"): kiểm
 * cũng dùng credential của khách để gọi cloud của họ.
 */
export const cloudRouter: Router = Router({ mergeParams: true });

cloudRouter.get(
  "/cloud",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  asyncHandler(async (req, res) => {
    sendJson(res, cloudResponseWire, {
      cloud: await cloudService.get(projectIdParam(req)),
    });
  }),
);

cloudRouter.get(
  "/cloud/setup",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateQuery(cloudSetupQuerySchema),
  (req, res) => {
    const { provider } = req.query as unknown as CloudSetupQuery;
    sendJson(res, cloudSetupResponseWire, {
      setup: cloudService.setup(
        projectIdParam(req),
        provider,
        appDepsOf(req).cloud,
      ),
    });
  },
);

cloudRouter.put(
  "/cloud",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(putCloudBodySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, cloudResponseWire, {
      cloud: await cloudService.put(
        projectIdParam(req),
        req.body as PutCloudBody,
        req,
        appDepsOf(req).cloud,
      ),
    });
  }),
);

cloudRouter.post(
  "/cloud/validate",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    sendJson(res, cloudValidationResponseWire, {
      validation: await cloudService.validate(
        projectIdParam(req),
        appDepsOf(req).cloud,
      ),
    });
  }),
);

cloudRouter.post(
  "/cloud/preflight",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    sendJson(res, cloudPreflightResponseWire, {
      preflight: await cloudService.preflight(
        projectIdParam(req),
        appDepsOf(req).cloud,
      ),
    });
  }),
);
