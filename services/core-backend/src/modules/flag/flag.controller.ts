import { Router, type Request } from "express";
import {
  asyncHandler,
  sendJson,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  bulkArchiveResponseWire,
  flagEnvResponseWire,
  flagEnvsResponseWire,
  flagListResponseWire,
  flagResponseWire,
  flagStatsViewResponseWire,
  flagVariantsResponseWire,
  rulesResponseWire,
  staleFlagsResponseWire,
} from "@udp/shared-types/wire";
import { testerResultSchema } from "@udp/shared-types/flag-api";
import { appDepsOf } from "../../core/app-deps.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { auditContextOf } from "../audit/audit.service.js";
import * as flagService from "./flag.service.js";
import {
  bulkArchiveBodySchema,
  createFlagBodySchema,
  evaluateBodySchema,
  flagStatsQuerySchema,
  listFlagsQuerySchema,
  replaceRulesBodySchema,
  staleFlagsQueryBodySchema,
  updateEnvBodySchema,
  updateFlagBodySchema,
  type BulkArchiveBody,
  type CreateFlagBody,
  type EvaluateBody,
  type FlagStatsQueryBody,
  type ListFlagsQuery,
  type ReplaceRulesBody,
  type StaleFlagsQueryBody,
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
    const flag = await flagService.create(
      appDepsOf(req),
      projectIdParam(req),
      req.body as CreateFlagBody,
      auditContextOf(req),
    );
    sendJson(res, flagResponseWire, { flag }, 201);
  }),
);

flagRouter.get(
  "/flags",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listFlagsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      flagListResponseWire,
      await flagService.list(
        appDepsOf(req),
        projectIdParam(req),
        req.query as unknown as ListFlagsQuery,
      ),
    );
  }),
);

/**
 * [v4.9] HAI route TĨNH dưới `/flags` phải đứng TRƯỚC `/flags/:flagId` (§3.1,
 * R29).
 *
 * Express khớp theo thứ tự đăng ký, nên đặt sau thì `:flagId` nuốt cả hai và
 * `uuidParam` trả 400 "Mã flag không hợp lệ" cho một đường dẫn hoàn toàn đúng.
 * `tests/flag-routes.test.ts` canh thứ tự này bằng một khẳng định tĩnh — chú
 * thích một mình không chặn được lần thêm route kế tiếp.
 */
flagRouter.get(
  "/flags/stale",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(staleFlagsQueryBodySchema),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      staleFlagsResponseWire,
      await flagService.staleFlags(
        appDepsOf(req),
        projectIdParam(req),
        req.query as unknown as StaleFlagsQueryBody,
      ),
    );
  }),
);

flagRouter.post(
  "/flags/bulk-archive",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(bulkArchiveBodySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, bulkArchiveResponseWire, {
      results: await flagService.bulkArchive(
        appDepsOf(req),
        projectIdParam(req),
        req.body as BulkArchiveBody,
        auditContextOf(req),
      ),
    });
  }),
);

flagRouter.get(
  "/flags/:flagId",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, flagResponseWire, {
      flag: await flagService.get(projectIdParam(req), flagIdOf(req)),
    });
  }),
);

flagRouter.get(
  "/flags/:flagId/stats",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(flagStatsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(
      res,
      flagStatsViewResponseWire,
      await flagService.flagStats(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        req.query as unknown as FlagStatsQueryBody,
      ),
    );
  }),
);

flagRouter.get(
  "/flags/:flagId/variants",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const flag = await flagService.get(projectIdParam(req), flagIdOf(req));
    sendJson(res, flagVariantsResponseWire, { variants: flag.variants });
  }),
);

flagRouter.get(
  "/flags/:flagId/envs",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const flag = await flagService.get(projectIdParam(req), flagIdOf(req));
    sendJson(res, flagEnvsResponseWire, { envs: flag.envs });
  }),
);

flagRouter.patch(
  "/flags/:flagId",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(updateFlagBodySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, flagResponseWire, {
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
    sendJson(res, flagEnvResponseWire, {
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
    sendJson(
      res,
      rulesResponseWire,
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
    sendJson(
      res,
      rulesResponseWire,
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
    sendJson(
      res,
      testerResultSchema,
      await flagService.evaluateFlag(
        appDepsOf(req),
        projectIdParam(req),
        flagIdOf(req),
        req.body as EvaluateBody,
      ),
    );
  }),
);
