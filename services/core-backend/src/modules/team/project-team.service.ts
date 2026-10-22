import type { Request } from "express";
import type { Prisma } from "@udp/db";
import { NotFoundError } from "@udp/http";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type { GrantTeamInput, UpdateGrantInput } from "./team.types.js";

/**
 * [v4.11, Plan #55 QĐ-2] Quyền của một nhóm TRÊN một project (`project_team_grants`).
 *
 * Mọi thay đổi ghi vào audit CỦA PROJECT: người xem project thấy ai đã mở cửa cho cả một nhóm. Danh sách kèm
 * người của từng nhóm — một nhóm không được là hộp đen che ai đang vào được project.
 */

const GRANT_FIELDS = {
  projectRole: true,
  createdAt: true,
  team: {
    select: {
      id: true,
      name: true,
      members: {
        select: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  },
} as const satisfies Prisma.ProjectTeamGrantSelect;

export type ProjectTeamRow = Prisma.ProjectTeamGrantGetPayload<{
  select: typeof GRANT_FIELDS;
}>;

const NOT_GRANTED = "Nhóm này chưa có quyền trên project";

export const listForProject = (projectId: string): Promise<ProjectTeamRow[]> =>
  prisma.projectTeamGrant.findMany({
    where: { projectId },
    select: GRANT_FIELDS,
    orderBy: { createdAt: "asc" },
  });

/**
 * Cấp quyền cho một nhóm. Người cấp phải THUỘC nhóm: trao project cho một nhóm mình không thuộc là trao cho người
 * lạ — và nhóm của người khác trả 404 như mọi chỗ khác (không dò được nhóm nào có thật). Cấp trùng: unique
 * `(project_id, team_id)` ⇒ P2002 ⇒ 409.
 */
export async function grant(
  projectId: string,
  input: GrantTeamInput,
  callerId: string,
  request: Request,
): Promise<ProjectTeamRow> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: callerId } },
    select: { teamId: true },
  });
  if (membership === null) throw new NotFoundError("Không tìm thấy nhóm");

  const [row] = await prisma.$transaction([
    prisma.projectTeamGrant.create({
      data: {
        projectId,
        teamId: input.teamId,
        projectRole: input.projectRole,
      },
      select: GRANT_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "team.grant",
          targetType: "Team",
          targetId: input.teamId,
          after: { projectRole: input.projectRole },
          request,
        }),
      },
    }),
  ]);
  return row;
}

async function currentGrant(projectId: string, teamId: string) {
  const current = await prisma.projectTeamGrant.findUnique({
    where: { projectId_teamId: { projectId, teamId } },
    select: { projectRole: true },
  });
  if (current === null) throw new NotFoundError(NOT_GRANTED);
  return current;
}

export async function updateGrant(
  projectId: string,
  teamId: string,
  input: UpdateGrantInput,
  request: Request,
): Promise<ProjectTeamRow> {
  const before = await currentGrant(projectId, teamId);
  const [row] = await prisma.$transaction([
    prisma.projectTeamGrant.update({
      where: { projectId_teamId: { projectId, teamId } },
      data: { projectRole: input.projectRole },
      select: GRANT_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "team.grant.update",
          targetType: "Team",
          targetId: teamId,
          before: { projectRole: before.projectRole },
          after: { projectRole: input.projectRole },
          request,
        }),
      },
    }),
  ]);
  return row;
}

/** Gỡ quyền của nhóm — người chỉ vào được qua nhóm này mất quyền ở request kế tiếp */
export async function revoke(
  projectId: string,
  teamId: string,
  request: Request,
): Promise<void> {
  const before = await currentGrant(projectId, teamId);
  await prisma.$transaction([
    prisma.projectTeamGrant.delete({
      where: { projectId_teamId: { projectId, teamId } },
    }),
    prisma.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "team.revoke",
          targetType: "Team",
          targetId: teamId,
          before: { projectRole: before.projectRole },
          request,
        }),
      },
    }),
  ]);
}
