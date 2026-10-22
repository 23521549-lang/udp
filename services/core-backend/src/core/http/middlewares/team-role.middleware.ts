import type { Request, RequestHandler } from "express";
import type { TeamRole } from "@udp/db";
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  uuidParam,
} from "@udp/http";
import { prisma } from "../../db.js";

/**
 * [v4.11, Plan #55] Quyền TRONG MỘT NHÓM — cặp đôi của `requireMinProjectRole` cho `/teams/:teamId/*`.
 *
 * Cùng ba luật với guard của project: người ngoài nhóm và nhóm không tồn tại cùng 404 (không dò được nhóm nào có
 * thật), PLATFORM_ADMIN không đi vòng, và vai lưu vào `req.teamRole` cho handler. Lint `team-route-guard` chứng
 * minh mọi route có `:teamId` đi qua đây.
 */

/** Tên tham số route mang id nhóm — một chỗ chốt cho middleware, router và lint */
export const TEAM_ID_PARAM = "teamId";

/** Id nhóm đã qua guard — kiểu `string`, không chỗ nào phải viết `!` */
export const teamIdParam = (req: Request): string =>
  uuidParam(req, TEAM_ID_PARAM, "Mã nhóm không hợp lệ");

/** Thứ bậc, như `RANK` của project: `requireTeamRole("MEMBER")` cho OWNER đi qua */
const RANK: Record<TeamRole, number> = { MEMBER: 0, OWNER: 1 };

export const hasMinTeamRole = (role: TeamRole, minimum: TeamRole): boolean =>
  RANK[role] >= RANK[minimum];

export const requireTeamRole =
  (minimum: TeamRole): RequestHandler =>
  (req, _res, next) => {
    void (async () => {
      if (!req.user) {
        next(new UnauthenticatedError("Chưa đăng nhập"));
        return;
      }
      const teamId = teamIdParam(req);
      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: req.user.sub } },
        select: { teamRole: true },
      });
      if (membership === null) {
        next(new NotFoundError("Không tìm thấy nhóm"));
        return;
      }
      if (!hasMinTeamRole(membership.teamRole, minimum)) {
        next(new ForbiddenError("Chỉ chủ nhóm làm được việc này"));
        return;
      }
      req.teamRole = membership.teamRole;
      next();
    })().catch(next);
  };
