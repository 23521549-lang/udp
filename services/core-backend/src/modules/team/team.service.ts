import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Prisma, TeamRole } from "@udp/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@udp/http";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type {
  AddTeamMemberInput,
  CreateTeamInput,
  RenameTeamInput,
  UpdateTeamMemberInput,
} from "./team.types.js";

/**
 * [v4.11, Plan #55 QĐ-2] Nhóm — đơn vị trao quyền cho nhiều project một lần.
 *
 * Hai luật của cả tệp:
 *
 * 1. **Nhóm luôn còn ít nhất một OWNER.** Hạ vai hay gỡ (kể cả tự rời) chạy trong transaction có khoá hàng
 *    `teams` (`FOR NO KEY UPDATE` — như chuyển quyền sở hữu project: không chặn các INSERT `team_members` vốn
 *    lấy `FOR KEY SHARE` qua khoá ngoại, mà vẫn xếp hàng hai lần hạ vai đồng thời). Không có khoá, hai OWNER
 *    cùng hạ nhau đều đếm thấy "còn một OWNER khác" rồi cùng thành công.
 * 2. **Audit của nhóm là audit nền tảng** (`projectId = null`, như đổi vai nền tảng): nhóm không thuộc project
 *    nào. Quyền của nhóm TRÊN một project thì ghi vào audit của project đó (`project-team.service.ts`).
 */

const PERSON = { id: true, email: true, name: true } as const;

export const TEAM_MEMBER_FIELDS = {
  userId: true,
  teamRole: true,
  createdAt: true,
  user: { select: PERSON },
} as const satisfies Prisma.TeamMemberSelect;

const DETAIL_FIELDS = {
  id: true,
  name: true,
  createdAt: true,
  members: { select: TEAM_MEMBER_FIELDS, orderBy: { createdAt: "asc" } },
  // Project đã xoá mềm không hiện — grant của nó còn đó chỉ vì xoá mềm không cascade
  grants: {
    where: { project: { status: { not: "DELETED" } } },
    select: {
      projectRole: true,
      project: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
} as const satisfies Prisma.TeamSelect;

export type TeamDetail = Prisma.TeamGetPayload<{
  select: typeof DETAIL_FIELDS;
}>;
export type TeamMemberRow = Prisma.TeamMemberGetPayload<{
  select: typeof TEAM_MEMBER_FIELDS;
}>;

const LAST_OWNER =
  "Nhóm phải còn ít nhất một chủ nhóm — giao vai chủ nhóm cho người khác trước";

/** Nhóm của người dùng, mỗi nhóm kèm vai của họ và hai con số */
export async function listMine(userId: string) {
  return prisma.team.findMany({
    where: { members: { some: { userId } } },
    select: {
      id: true,
      name: true,
      createdAt: true,
      members: { where: { userId }, select: { teamRole: true } },
      _count: {
        select: {
          members: true,
          grants: { where: { project: { status: { not: "DELETED" } } } },
        },
      },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function detail(teamId: string): Promise<TeamDetail> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: DETAIL_FIELDS,
  });
  // Guard đã chứng minh người gọi thuộc nhóm; nhóm biến mất giữa hai câu là xoá đồng thời
  if (team === null) throw new NotFoundError("Không tìm thấy nhóm");
  return team;
}

/** Tạo nhóm — người tạo là OWNER đầu tiên, trong CÙNG lệnh với nhóm và audit */
export async function create(
  userId: string,
  input: CreateTeamInput,
  request: Request,
): Promise<TeamDetail> {
  const id = randomUUID();
  const [team] = await prisma.$transaction([
    prisma.team.create({
      data: {
        id,
        name: input.name,
        members: { create: { userId, teamRole: "OWNER" } },
      },
      select: DETAIL_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action: "team.create",
          targetType: "Team",
          targetId: id,
          after: { name: input.name },
          request,
        }),
      },
    }),
  ]);
  return team;
}

export async function rename(
  teamId: string,
  input: RenameTeamInput,
  request: Request,
): Promise<TeamDetail> {
  const before = await prisma.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });
  if (before === null) throw new NotFoundError("Không tìm thấy nhóm");
  const [team] = await prisma.$transaction([
    prisma.team.update({
      where: { id: teamId },
      data: { name: input.name },
      select: DETAIL_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action: "team.rename",
          targetType: "Team",
          targetId: teamId,
          before: { name: before.name },
          after: { name: input.name },
          request,
        }),
      },
    }),
  ]);
  return team;
}

/** Xoá nhóm — thành viên, quyền trên project và lời mời của nhóm đi theo (cascade) */
export async function remove(teamId: string, request: Request): Promise<void> {
  const before = await prisma.team.findUnique({
    where: { id: teamId },
    select: { name: true, grants: { select: { projectId: true } } },
  });
  if (before === null) throw new NotFoundError("Không tìm thấy nhóm");
  await prisma.$transaction([
    prisma.team.delete({ where: { id: teamId } }),
    prisma.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action: "team.delete",
          targetType: "Team",
          targetId: teamId,
          before: {
            name: before.name,
            projectIds: before.grants.map((g) => g.projectId),
          },
          request,
        }),
      },
    }),
  ]);
}

/**
 * Thêm người ĐÃ có tài khoản. Chưa có ⇒ 404 và Portal đề nghị lời mời bằng đường dẫn. Trùng thành viên không kiểm
 * trước: `@@unique([teamId, userId])` ném P2002 và `@udp/db` ánh xạ thành 409 (như thành viên project).
 */
export async function addMember(
  teamId: string,
  input: AddTeamMemberInput,
  request: Request,
): Promise<TeamMemberRow> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (user === null) {
    throw new NotFoundError("Chưa có tài khoản nào dùng email này");
  }
  const [member] = await prisma.$transaction([
    prisma.teamMember.create({
      data: { teamId, userId: user.id, teamRole: input.teamRole },
      select: TEAM_MEMBER_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action: "team.member.add",
          targetType: "Team",
          targetId: teamId,
          after: { userId: user.id, teamRole: input.teamRole },
          request,
        }),
      },
    }),
  ]);
  return member;
}

type Tx = Prisma.TransactionClient;

async function lockTeam(tx: Tx, teamId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR NO KEY UPDATE`;
}

/** Vai hiện tại của `userId` trong nhóm, hay 404 */
async function currentRole(
  tx: Tx,
  teamId: string,
  userId: string,
): Promise<TeamRole> {
  const current = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { teamRole: true },
  });
  if (current === null) {
    throw new NotFoundError("Không tìm thấy thành viên nhóm");
  }
  return current.teamRole;
}

async function assertNotLastOwner(
  tx: Tx,
  teamId: string,
  role: TeamRole,
): Promise<void> {
  if (role !== "OWNER") return;
  const owners = await tx.teamMember.count({
    where: { teamId, teamRole: "OWNER" },
  });
  if (owners <= 1) throw new ConflictError(LAST_OWNER);
}

export async function updateMemberRole(
  teamId: string,
  userId: string,
  input: UpdateTeamMemberInput,
  request: Request,
): Promise<TeamMemberRow> {
  return prisma.$transaction(async (tx) => {
    await lockTeam(tx, teamId);
    const before = await currentRole(tx, teamId, userId);
    if (input.teamRole !== "OWNER") {
      await assertNotLastOwner(tx, teamId, before);
    }
    const member = await tx.teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { teamRole: input.teamRole },
      select: TEAM_MEMBER_FIELDS,
    });
    await tx.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action: "team.member.role.update",
          targetType: "Team",
          targetId: teamId,
          before: { userId, teamRole: before },
          after: { userId, teamRole: input.teamRole },
          request,
        }),
      },
    });
    return member;
  });
}

/**
 * Gỡ một thành viên — chủ nhóm gỡ bất kỳ ai, thành viên thường chỉ gỡ được CHÍNH MÌNH (rời nhóm). Quyền đến từ
 * nhóm mất ngay ở request kế tiếp: vai hiệu lực không cache (`project-access.ts`).
 */
export async function removeMember(
  teamId: string,
  userId: string,
  caller: { userId: string; teamRole: TeamRole },
  request: Request,
): Promise<void> {
  if (caller.teamRole !== "OWNER" && caller.userId !== userId) {
    throw new ForbiddenError("Chỉ chủ nhóm gỡ được người khác");
  }
  await prisma.$transaction(async (tx) => {
    await lockTeam(tx, teamId);
    const before = await currentRole(tx, teamId, userId);
    await assertNotLastOwner(tx, teamId, before);
    await tx.teamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
    await tx.auditLog.create({
      data: {
        projectId: null,
        ...auditEntry({
          action:
            caller.userId === userId
              ? "team.member.leave"
              : "team.member.remove",
          targetType: "Team",
          targetId: teamId,
          before: { userId, teamRole: before },
          request,
        }),
      },
    });
  });
}
