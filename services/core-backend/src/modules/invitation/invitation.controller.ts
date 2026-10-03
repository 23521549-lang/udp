import { Router, type Request } from "express";
import { asyncHandler, sendJson, uuidParam, validateBody } from "@udp/http";
import {
  invitationAcceptedResponseWire,
  invitationLookupResponseWire,
  projectInvitationCreatedResponseWire,
  projectInvitationListResponseWire,
} from "@udp/shared-types/wire";
import {
  requireAuth,
  requireUser,
} from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import * as invitationService from "./invitation.service.js";
import {
  createProjectInvitationSchema,
  invitationTokenSchema,
  type CreateProjectInvitationInput,
  type InvitationTokenInput,
} from "./invitation.types.js";
import { projectInvitationWire } from "./invitation.view.js";

/**
 * [v4.11, Plan #55 QĐ-1] Lời mời vào project — gắn dưới `/projects/:id` (`mergeParams`, như `memberRouter`).
 * §2.2 xếp quản lý thành viên vào cột chỉ OWNER; lời mời là một cách thêm thành viên nên cùng cột.
 */
export const projectInvitationRouter: Router = Router({ mergeParams: true });

export const invitationIdParam = (req: Request): string =>
  uuidParam(req, "invitationId", "Mã lời mời không hợp lệ");

projectInvitationRouter.get(
  "/invitations",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    const rows = await invitationService.listPending({
      kind: "PROJECT",
      projectId: projectIdParam(req),
    });
    sendJson(res, projectInvitationListResponseWire, {
      invitations: rows.map(projectInvitationWire),
    });
  }),
);

projectInvitationRouter.post(
  "/invitations",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(createProjectInvitationSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as CreateProjectInvitationInput;
    const { invitation, token } = await invitationService.create(
      { kind: "PROJECT", projectId: projectIdParam(req), ...input },
      requireUser(req).sub,
      req,
    );
    sendJson(
      res,
      projectInvitationCreatedResponseWire,
      { invitation: projectInvitationWire(invitation), token },
      201,
    );
  }),
);

projectInvitationRouter.delete(
  "/invitations/:invitationId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    await invitationService.revoke(
      { kind: "PROJECT", projectId: projectIdParam(req) },
      invitationIdParam(req),
      req,
    );
    res.status(204).end();
  }),
);

/**
 * Hai route của người CẦM đường dẫn, gắn ở `/invitations`. Token đi trong thân request (không trong URL: log truy
 * cập, log proxy và Referer đều ghi URL).
 *
 * `/lookup` không cần phiên — người được mời có thể chưa có tài khoản — và miễn CSRF như `/auth/login` (chưa có
 * cookie CSRF để gửi; route chỉ ĐỌC). Rate limiter chung của `/api` vẫn áp; token 256 bit nên không dò được.
 * `/accept` cần phiên và CSRF như mọi thao tác ghi.
 */
export const invitationRouter: Router = Router();

invitationRouter.post(
  "/lookup",
  validateBody(invitationTokenSchema),
  asyncHandler(async (req, res) => {
    const { token } = req.body as InvitationTokenInput;
    sendJson(res, invitationLookupResponseWire, {
      invitation: await invitationService.lookup(token),
    });
  }),
);

invitationRouter.post(
  "/accept",
  requireAuth,
  validateBody(invitationTokenSchema),
  asyncHandler(async (req, res) => {
    const { token } = req.body as InvitationTokenInput;
    sendJson(res, invitationAcceptedResponseWire, {
      target: await invitationService.accept(token, requireUser(req).sub, req),
    });
  }),
);
