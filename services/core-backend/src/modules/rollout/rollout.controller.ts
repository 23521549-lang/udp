import { Router, type Request } from "express";
import {
  asyncHandler,
  sendJson,
  uuidParam,
  validateBody,
  validateQuery,
} from "@udp/http";
import {
  rolloutActionResponseWire,
  rolloutEventsResponseWire,
  rolloutListResponseWire,
  rolloutProbeResponseWire,
  rolloutResponseWire,
} from "@udp/shared-types/wire";
import { appDepsOf } from "../../core/app-deps.js";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import { idempotent } from "../../core/http/middlewares/idempotency.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as rolloutService from "./rollout.service.js";
import {
  createRolloutSchema,
  listRolloutsQuerySchema,
  probeRolloutSchema,
  rolloutActionSchema,
  rolloutEventsQuerySchema,
  type ListRolloutsQuery,
  type RolloutActionInput,
  type RolloutEventsQuery,
} from "./rollout.types.js";

/**
 * Progressive Delivery ở Service 1 (§9), gắn dưới `/projects/:id`.
 *
 * Quyền theo ma trận §2.2: khởi tạo rollout và mọi Manual Override là OWNER /
 * MAINTAINER ở MỌI environment; đọc là VIEWER; `/probe` là DEVELOPER — nó chỉ đọc
 * metric, không đổi gì. `/rollouts/probe` khai TRƯỚC `/rollouts/:rolloutId` (§3.1:
 * route tĩnh trước route động).
 */
export const rolloutRouter: Router = Router({ mergeParams: true });

const rolloutIdParam = (req: Request): string =>
  uuidParam(req, "rolloutId", "Mã rollout không hợp lệ");

rolloutRouter.post(
  "/rollouts/probe",
  requireAuth,
  requireMinProjectRole("DEVELOPER"),
  validateBody(probeRolloutSchema),
  asyncHandler(async (req, res) => {
    sendJson(res, rolloutProbeResponseWire, {
      probe: await rolloutService.probe(
        appDepsOf(req),
        projectIdParam(req),
        req.body,
      ),
    });
  }),
);

rolloutRouter.post(
  "/rollouts",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(createRolloutSchema),
  // §9 bảng Idempotency-Key: "hai session cùng nhắm một target"
  idempotent("POST /projects/:id/rollouts"),
  asyncHandler(async (req, res) => {
    const rollout = await rolloutService.create(
      appDepsOf(req),
      projectIdParam(req),
      req.body,
      requireUser(req).sub,
      req,
    );
    sendJson(res, rolloutResponseWire, { rollout }, 201);
  }),
);

rolloutRouter.get(
  "/rollouts",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(listRolloutsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, rolloutListResponseWire, {
      rollouts: await rolloutService.list(
        projectIdParam(req),
        req.query as unknown as ListRolloutsQuery,
      ),
    });
  }),
);

rolloutRouter.get(
  "/rollouts/:rolloutId",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    sendJson(res, rolloutResponseWire, {
      rollout: await rolloutService.get(
        projectIdParam(req),
        rolloutIdParam(req),
      ),
    });
  }),
);

rolloutRouter.get(
  "/rollouts/:rolloutId/events",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  validateQuery(rolloutEventsQuerySchema),
  asyncHandler(async (req, res) => {
    sendJson(res, rolloutEventsResponseWire, {
      events: await rolloutService.events(
        projectIdParam(req),
        rolloutIdParam(req),
        req.query as unknown as RolloutEventsQuery,
      ),
    });
  }),
);

rolloutRouter.post(
  "/rollouts/:rolloutId/actions",
  requireAuth,
  requireMinProjectRole("MAINTAINER"),
  validateBody(rolloutActionSchema),
  asyncHandler(async (req, res) => {
    const { action } = req.body as RolloutActionInput;
    const accepted = await rolloutService.act(
      projectIdParam(req),
      rolloutIdParam(req),
      action,
      requireUser(req).sub,
      req,
    );
    sendJson(
      res,
      rolloutActionResponseWire,
      { ...accepted, status: "accepted" },
      202,
    );
  }),
);
