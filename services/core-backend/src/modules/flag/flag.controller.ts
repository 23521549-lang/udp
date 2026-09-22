import { Router, type Request } from "express";
import {
  asyncHandler,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { auditContextOf } from "../audit/audit.service.js";
import * as flagService from "./flag.service.js";
import {
  createFlagBodySchema,
  evaluateBodySchema,
  listFlagsQuerySchema,
  replaceRulesBodySchema,
  updateEnvBodySchema,
  updateFlagBodySchema,
  type CreateFlagBody,
  type EvaluateBody,
  type ListFlagsQuery,
  type ReplaceRulesBody,
  type UpdateEnvBody,
  type UpdateFlagBody,
} from "./flag.types.js";

/**
 * Feature Flag ở Service 1 (§9, §8.4) [v4.5], gắn dưới `/projects/:id`.
 *
 * Route gắn mức TỐI THIỂU của §2.2 (đọc VIEWER, ghi DEVELOPER); service nâng lên
 * MAINTAINER khi thao tác chạm production — mức đó chỉ biết sau khi đọc env.
 * Ghi thì S1 chuyển ngữ cảnh người dùng (ai, IP, UA) cho Service 2 ghi audit
 * trong transaction của nó.
 */
export const flagRouter: Router = Router({ mergeParams: true });

const flagIdOf = (req: Request): string =>
  uuidParam(req, "flagId", "Mã flag không hợp lệ");
const envIdOf = (req: Request): string =>
  uuidParam(req, "envId", "Mã environment không hợp lệ");

flagRouter.post(
  "/flags",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(createFlagBodySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({
      flag: await flagService.create(
        appDepsOf(req),
        projectIdParam(req),
        req.body as CreateFlagBody,
        auditContextOf(req),
      ),
    });
  }),
);

flagRouter.get(
  "/flags",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listFlagsQuerySchema),
  asyncHandler(async (req, res) => {
    res.json({
      flags: await flagService.list(
        projectIdParam(req),
        req.query as unknown as ListFlagsQuery,
      ),
    });
  }),
);

flagRouter.get(
  "/flags/:flagId",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    res.json({
      flag: await flagService.get(projectIdParam(req), flagIdOf(req)),
    });
  }),
);

flagRouter.get(
  "/flags/:flagId/variants",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const flag = await flagService.get(projectIdParam(req), flagIdOf(req));
    res.json({ variants: flag.variants });
  }),
);

flagRouter.get(
  "/flags/:flagId/envs",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const flag = await flagService.get(projectIdParam(req), flagIdOf(req));
    res.json({ envs: flag.envs });
  }),
);

flagRouter.patch(
  "/flags/:flagId",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(updateFlagBodySchema),
  asyncHandler(async (req, res) => {
    res.json({
      flag: await flagService.update(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        req.body as UpdateFlagBody,
        req.projectRole,
        auditContextOf(req),
      ),
    });
  }),
);

flagRouter.patch(
  "/flags/:flagId/envs/:envId",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(updateEnvBodySchema),
  asyncHandler(async (req, res) => {
    res.json({
      env: await flagService.updateEnv(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        envIdOf(req),
        req.body as UpdateEnvBody,
        req.projectRole,
        auditContextOf(req),
      ),
    });
  }),
);

flagRouter.get(
  "/flags/:flagId/envs/:envId/rules",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    res.json(
      await flagService.rules(projectIdParam(req), flagIdOf(req), envIdOf(req)),
    );
  }),
);

flagRouter.put(
  "/flags/:flagId/envs/:envId/rules",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(replaceRulesBodySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await flagService.replaceRules(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        envIdOf(req),
        req.body as ReplaceRulesBody,
        req.projectRole,
        auditContextOf(req),
      ),
    );
  }),
);

flagRouter.post(
  "/flags/:flagId/evaluate",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateBody(evaluateBodySchema),
  asyncHandler(async (req, res) => {
    res.json(
      await flagService.evaluateFlag(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        req.body as EvaluateBody,
      ),
    );
  }),
);
