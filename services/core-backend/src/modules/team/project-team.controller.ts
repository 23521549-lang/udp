import { Router } from "express";
import { asyncHandler, sendJson, validateBody } from "@udp/http";
import {
  projectTeamListResponseWire,
  projectTeamResponseWire,
} from "@udp/shared-types/wire";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { teamIdParam } from "../../core/http/middlewares/team-role.middleware.js";
import * as projectTeamService from "./project-team.service.js";
import {
  grantTeamSchema,
  updateGrantSchema,
  type GrantTeamInput,
  type UpdateGrantInput,
} from "./team.types.js";
import { projectTeamWire } from "./team.view.js";

/**
 * [v4.11, Plan #55 QĐ-2] Nhóm có quyền trên project — gắn dưới `/projects/:id` (`mergeParams`). Ai xem được
 * project thì thấy danh sách (kèm người của từng nhóm); cấp, đổi, gỡ là việc của OWNER như thêm thành viên (§2.2).
 * `:teamId` ở đây là KHOÁ của grant, không phải cửa vào nhóm: guard là vai trên PROJECT.
 */
export const projectTeamRouter: Router = Router({ mergeParams: true });

projectTeamRouter.get(
  "/teams",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const rows = await projectTeamService.listForProject(projectIdParam(req));
    sendJson(res, projectTeamListResponseWire, {
      teams: rows.map(projectTeamWire),
    });
  }),
);

projectTeamRouter.post(
  "/teams",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(grantTeamSchema),
  asyncHandler(async (req, res) => {
    const row = await projectTeamService.grant(
      projectIdParam(req),
      req.body as GrantTeamInput,
      requireUser(req).sub,
      req,
    );
    sendJson(res, projectTeamResponseWire, { team: projectTeamWire(row) }, 201);
  }),
);

projectTeamRouter.patch(
  "/teams/:teamId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateGrantSchema),
  asyncHandler(async (req, res) => {
    const row = await projectTeamService.updateGrant(
      projectIdParam(req),
      teamIdParam(req),
      req.body as UpdateGrantInput,
      req,
    );
    sendJson(res, projectTeamResponseWire, { team: projectTeamWire(row) });
  }),
);

projectTeamRouter.delete(
  "/teams/:teamId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    await projectTeamService.revoke(projectIdParam(req), teamIdParam(req), req);
    res.status(204).end();
  }),
);
