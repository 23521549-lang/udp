import { Router, type Request } from "express";
import { uuidParam } from "@udp/http";
import { asyncHandler, sendJson } from "@udp/http";
import {
  memberListResponseWire,
  memberResponseWire,
} from "@udp/shared-types/wire";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { idempotent } from "../../core/http/middlewares/idempotency.middleware.js";
import { validateBody } from "@udp/http";
import * as memberService from "./member.service.js";
import { memberWire } from "./member.view.js";
import {
  addMemberSchema,
  transferOwnershipSchema,
  updateMemberSchema,
} from "./member.types.js";

/**
 * Router thành viên, gắn dưới `/projects/:id`.
 *
 * `mergeParams: true` là bắt buộc, không phải tuỳ chọn: thiếu nó thì
 * `req.params` của router con RỖNG, `req.params.id` là `undefined`, và
 * `requireMinProjectRole` sẽ từ chối mọi request với một lỗi chẳng liên quan gì
 * tới nguyên nhân thật.
 */
export const memberRouter: Router = Router({ mergeParams: true });

/** §9 khoá thành viên theo `:userId`, không phải theo id của hàng ProjectMember */
const userIdParam = (req: Request): string =>
  uuidParam(req, "userId", "userId không hợp lệ");

memberRouter.get(
  "/members",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    const members = await memberService.list(projectIdParam(req));
    sendJson(res, memberListResponseWire, { members: members.map(memberWire) });
  }),
);

/**
 * Thêm thành viên — §2.2 xếp "Thêm/xóa thành viên" vào cột chỉ OWNER.
 * MAINTAINER **không** được, dù nó là vai trò cao thứ hai.
 */
memberRouter.post(
  "/members",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(addMemberSchema),
  // §9 liet ke dung endpoint nay trong bang Idempotency-Key, ly do "gui hai loi moi"
  idempotent("POST /projects/:id/members"),
  asyncHandler(async (req, res) => {
    const member = await memberService.add(projectIdParam(req), req.body, req);
    sendJson(res, memberResponseWire, { member: memberWire(member) }, 201);
  }),
);

memberRouter.patch(
  "/members/:userId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(updateMemberSchema),
  asyncHandler(async (req, res) => {
    const member = await memberService.updateRole(
      projectIdParam(req),
      userIdParam(req),
      req.body,
      req,
    );
    sendJson(res, memberResponseWire, { member: memberWire(member) });
  }),
);

memberRouter.delete(
  "/members/:userId",
  requireAuth,
  requireMinProjectRole("OWNER"),
  asyncHandler(async (req, res) => {
    await memberService.remove(projectIdParam(req), userIdParam(req), req);
    res.status(204).end();
  }),
);

memberRouter.post(
  "/transfer-ownership",
  requireAuth,
  requireMinProjectRole("OWNER"),
  validateBody(transferOwnershipSchema),
  asyncHandler(async (req, res) => {
    const member = await memberService.transferOwnership(
      projectIdParam(req),
      req.body,
      req,
    );
    sendJson(res, memberResponseWire, { member: memberWire(member) });
  }),
);
