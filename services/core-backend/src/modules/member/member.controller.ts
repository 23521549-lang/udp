import { Router, type Request } from "express";
import { ValidationError } from "@udp/http";
import { asyncHandler } from "@udp/http";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import { idempotent } from "../../core/http/middlewares/idempotency.middleware.js";
import { validateBody } from "@udp/http";
import * as memberService from "./member.service.js";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §9 khoá thành viên theo `:userId`, không phải theo id của hàng ProjectMember */
function userIdParam(req: Request): string {
  const raw = req.params["userId"];
  if (raw === undefined || !UUID.test(raw)) {
    throw new ValidationError("userId không hợp lệ");
  }
  return raw;
}

memberRouter.get(
  "/members",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  asyncHandler(async (req, res) => {
    res.json({ members: await memberService.list(projectIdParam(req)) });
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
    res.status(201).json({ member });
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
    res.json({ member });
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
    res.json({ member });
  }),
);
