import { Router, type Request } from "express";
import type { TeamRole } from "@udp/db";
import { asyncHandler, sendJson, uuidParam, validateBody } from "@udp/http";
import {
  teamInvitationCreatedResponseWire,
  teamInvitationListResponseWire,
  teamListResponseWire,
  teamMemberResponseWire,
  teamResponseWire,
} from "@udp/shared-types/wire";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import {
  requireTeamRole,
  teamIdParam,
} from "../../core/http/middlewares/team-role.middleware.js";
import { invitationIdParam } from "../invitation/invitation.controller.js";
import * as invitationService from "../invitation/invitation.service.js";
import {
  createTeamInvitationSchema,
  type CreateTeamInvitationInput,
} from "../invitation/invitation.types.js";
import { teamInvitationWire } from "../invitation/invitation.view.js";
import * as teamService from "./team.service.js";
import {
  addTeamMemberSchema,
  createTeamSchema,
  renameTeamSchema,
  updateTeamMemberSchema,
  type AddTeamMemberInput,
  type CreateTeamInput,
  type RenameTeamInput,
  type UpdateTeamMemberInput,
} from "./team.types.js";
import {
  teamDetailWire,
  teamMemberWire,
  teamSummaryWire,
} from "./team.view.js";

/**
 * [v4.11, Plan #55 QĐ-2, QĐ-4] `/api/v1/teams` — nhóm của người đăng nhập.
 *
 * `GET /` và `POST /` không có nhóm nào để kiểm vai: danh sách lọc theo chính người gọi, và người tạo là OWNER đầu
 * tiên. Mọi route có `:teamId` qua `requireTeamRole` (lint `team-route-guard`): người ngoài nhóm nhận 404.
 */
export const teamRouter: Router = Router();

const userIdParam = (req: Request): string =>
  uuidParam(req, "userId", "userId không hợp lệ");

/** Vai đã được `requireTeamRole` lưu vào request */
function teamRoleOf(req: Request): TeamRole {
  if (req.teamRole === undefined) {
    throw new Error(
      "req.teamRole trống — route này phải đứng sau requireTeamRole",
    );
  }
  return req.teamRole;
}

teamRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await teamService.listMine(requireUser(req).sub);
    sendJson(res, teamListResponseWire, { teams: rows.map(teamSummaryWire) });
  }),
);

teamRouter.post(
  "/",
  requireAuth,
  validateBody(createTeamSchema),
  asyncHandler(async (req, res) => {
    const team = await teamService.create(
      requireUser(req).sub,
      req.body as CreateTeamInput,
      req,
    );
    sendJson(
      res,
      teamResponseWire,
      { team: teamDetailWire(team, "OWNER") },
      201,
    );
  }),
);

teamRouter.get(
  "/:teamId",
  requireAuth,
  requireTeamRole("MEMBER"),
  asyncHandler(async (req, res) => {
    const team = await teamService.detail(teamIdParam(req));
    sendJson(res, teamResponseWire, {
      team: teamDetailWire(team, teamRoleOf(req)),
    });
  }),
);

teamRouter.patch(
  "/:teamId",
  requireAuth,
  requireTeamRole("OWNER"),
  validateBody(renameTeamSchema),
  asyncHandler(async (req, res) => {
    const team = await teamService.rename(
      teamIdParam(req),
      req.body as RenameTeamInput,
      req,
    );
    sendJson(res, teamResponseWire, {
      team: teamDetailWire(team, teamRoleOf(req)),
    });
  }),
);

teamRouter.delete(
  "/:teamId",
  requireAuth,
  requireTeamRole("OWNER"),
  asyncHandler(async (req, res) => {
    await teamService.remove(teamIdParam(req), req);
    res.status(204).end();
  }),
);

teamRouter.post(
  "/:teamId/members",
  requireAuth,
  requireTeamRole("OWNER"),
  validateBody(addTeamMemberSchema),
  asyncHandler(async (req, res) => {
    const member = await teamService.addMember(
      teamIdParam(req),
      req.body as AddTeamMemberInput,
      req,
    );
    sendJson(
      res,
      teamMemberResponseWire,
      { member: teamMemberWire(member) },
      201,
    );
  }),
);

teamRouter.patch(
  "/:teamId/members/:userId",
  requireAuth,
  requireTeamRole("OWNER"),
  validateBody(updateTeamMemberSchema),
  asyncHandler(async (req, res) => {
    const member = await teamService.updateMemberRole(
      teamIdParam(req),
      userIdParam(req),
      req.body as UpdateTeamMemberInput,
      req,
    );
    sendJson(res, teamMemberResponseWire, { member: teamMemberWire(member) });
  }),
);

/** Chủ nhóm gỡ bất kỳ ai; thành viên thường chỉ gỡ chính mình (rời nhóm) — service kiểm */
teamRouter.delete(
  "/:teamId/members/:userId",
  requireAuth,
  requireTeamRole("MEMBER"),
  asyncHandler(async (req, res) => {
    await teamService.removeMember(
      teamIdParam(req),
      userIdParam(req),
      { userId: requireUser(req).sub, teamRole: teamRoleOf(req) },
      req,
    );
    res.status(204).end();
  }),
);

teamRouter.get(
  "/:teamId/invitations",
  requireAuth,
  requireTeamRole("OWNER"),
  asyncHandler(async (req, res) => {
    const rows = await invitationService.listPending({
      kind: "TEAM",
      teamId: teamIdParam(req),
    });
    sendJson(res, teamInvitationListResponseWire, {
      invitations: rows.map(teamInvitationWire),
    });
  }),
);

teamRouter.post(
  "/:teamId/invitations",
  requireAuth,
  requireTeamRole("OWNER"),
  validateBody(createTeamInvitationSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as CreateTeamInvitationInput;
    const { invitation, token } = await invitationService.create(
      { kind: "TEAM", teamId: teamIdParam(req), ...input },
      requireUser(req).sub,
      req,
    );
    sendJson(
      res,
      teamInvitationCreatedResponseWire,
      { invitation: teamInvitationWire(invitation), token },
      201,
    );
  }),
);

teamRouter.delete(
  "/:teamId/invitations/:invitationId",
  requireAuth,
  requireTeamRole("OWNER"),
  asyncHandler(async (req, res) => {
    await invitationService.revoke(
      { kind: "TEAM", teamId: teamIdParam(req) },
      invitationIdParam(req),
      req,
    );
    res.status(204).end();
  }),
);
