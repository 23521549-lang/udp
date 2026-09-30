import { randomBytes, randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Prisma, ProjectRole, TeamRole } from "@udp/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@udp/http";
import type { InvitationTargetWire } from "@udp/shared-types/wire";
import { hasMinProjectRole } from "../../core/access/project-access.js";
import { prisma } from "../../core/db.js";
import { hasMinTeamRole } from "../../core/http/middlewares/team-role.middleware.js";
import { hashToken } from "../../core/security/token-hash.js";
import { auditEntry } from "../audit/audit.service.js";

/**
 * [v4.11, Plan #55 QĐ-1] Lời mời bằng đường dẫn — vào một project hoặc một nhóm, cho người CHƯA có tài khoản.
 *
 * Không gửi mail (chi phí hạ tầng bằng 0 do cấu trúc): người mời nhận một đường dẫn MỘT lần và tự chuyển đi. Bốn
 * tính chất giữ an toàn cho đường dẫn đó:
 *
 * 1. **Chỉ lưu SHA-256 của token** (như refresh token): một bản dump database không nhận được lời mời nào.
 * 2. **Nhận chỉ khi email của tài khoản trùng email được mời**: đường dẫn lọt sang người khác vô dụng.
 * 3. **Một lần, có hạn, thu hồi được**: `accepted_at` đổi từ NULL đúng một lần (UPDATE có điều kiện — hai lượt
 *    nhận đồng thời thì lượt sau thấy hàng đã đổi và nhận 404); hạn 7 ngày; mời lại cùng email là thu hồi lời cũ.
 * 4. **Mọi trạng thái "không dùng được" cùng MỘT 404** — sai, hết hạn, đã dùng, đã thu hồi, project đã xoá: không
 *    dò được token nào từng có thật.
 *
 * Nhận lời mời không bao giờ HẠ vai: người đã có vai cao hơn giữ vai của mình.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "udp_inv_";
const GONE = "Lời mời không còn hiệu lực";

export type InvitationTarget =
  { kind: "PROJECT"; projectId: string } | { kind: "TEAM"; teamId: string };

export type NewInvitation =
  | {
      kind: "PROJECT";
      projectId: string;
      email: string;
      projectRole: Exclude<ProjectRole, "OWNER">;
    }
  | { kind: "TEAM"; teamId: string; email: string; teamRole: TeamRole };

const INVITATION_FIELDS = {
  id: true,
  email: true,
  projectRole: true,
  teamRole: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, email: true, name: true } },
} as const satisfies Prisma.InvitationSelect;

export type InvitationRow = Prisma.InvitationGetPayload<{
  select: typeof INVITATION_FIELDS;
}>;

/** Lời mời ĐANG CHỜ của một đích — kể cả lời đã quá hạn (Portal đánh dấu và mời lại được) */
const pendingOf = (target: InvitationTarget): Prisma.InvitationWhereInput => ({
  ...(target.kind === "PROJECT"
    ? { projectId: target.projectId }
    : { teamId: target.teamId }),
  acceptedAt: null,
  revokedAt: null,
});

/** Audit của lời mời vào project thuộc project; của lời mời vào nhóm là audit nền tảng */
const auditProjectOf = (target: InvitationTarget): string | null =>
  target.kind === "PROJECT" ? target.projectId : null;

const actionOf = (target: InvitationTarget, verb: string): string =>
  target.kind === "PROJECT" ? `invitation.${verb}` : `team.invitation.${verb}`;

export const listPending = (
  target: InvitationTarget,
): Promise<InvitationRow[]> =>
  prisma.invitation.findMany({
    where: pendingOf(target),
    select: INVITATION_FIELDS,
    orderBy: { createdAt: "desc" },
  });

/** Đã là thành viên (trực tiếp) của đích thì mời làm gì — 409 nói thẳng, thay vì một đường dẫn vô nghĩa */
async function assertNotMemberYet(input: NewInvitation): Promise<void> {
  const already =
    input.kind === "PROJECT"
      ? await prisma.projectMember.findFirst({
          where: { projectId: input.projectId, user: { email: input.email } },
          select: { id: true },
        })
      : await prisma.teamMember.findFirst({
          where: { teamId: input.teamId, user: { email: input.email } },
          select: { id: true },
        });
  if (already !== null) {
    throw new ConflictError(
      input.kind === "PROJECT"
        ? "Người này đã là thành viên của project"
        : "Người này đã ở trong nhóm",
    );
  }
}

/**
 * Tạo lời mời và trả token — lần DUY NHẤT token rời máy chủ. Lời mời đang chờ cùng email bị thu hồi trong CÙNG
 * transaction (đường dẫn cũ chết), rồi mới chèn lời mới: unique từng phần "một lời mời đang chờ mỗi đích và email"
 * không bao giờ thấy hai hàng. KHÔNG dùng `Idempotency-Key`: lớp đó lưu nguyên thân response, tức lưu token.
 */
export async function create(
  input: NewInvitation,
  invitedById: string,
  request: Request,
): Promise<{ invitation: InvitationRow; token: string }> {
  await assertNotMemberYet(input);

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const role =
    input.kind === "PROJECT"
      ? { projectId: input.projectId, projectRole: input.projectRole }
      : { teamId: input.teamId, teamRole: input.teamRole };

  const [, invitation] = await prisma.$transaction([
    prisma.invitation.updateMany({
      where: { ...pendingOf(input), email: input.email },
      data: { revokedAt: new Date() },
    }),
    prisma.invitation.create({
      data: {
        id,
        ...role,
        email: input.email,
        tokenHash: hashToken(token),
        invitedById,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: INVITATION_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        projectId: auditProjectOf(input),
        ...auditEntry({
          action: actionOf(input, "create"),
          targetType: "Invitation",
          targetId: id,
          after: {
            email: input.email,
            ...(input.kind === "PROJECT"
              ? { projectRole: input.projectRole }
              : { teamId: input.teamId, teamRole: input.teamRole }),
          },
          request,
        }),
      },
    }),
  ]);
  return { invitation, token };
}

export async function revoke(
  target: InvitationTarget,
  invitationId: string,
  request: Request,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const revoked = await tx.invitation.updateMany({
      where: { id: invitationId, ...pendingOf(target) },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      throw new NotFoundError("Không tìm thấy lời mời đang chờ");
    }
    await tx.auditLog.create({
      data: {
        projectId: auditProjectOf(target),
        ...auditEntry({
          action: actionOf(target, "revoke"),
          targetType: "Invitation",
          targetId: invitationId,
          request,
        }),
      },
    });
  });
}

// ------------------------------------------------------------- người cầm đường dẫn

const LOOKUP_FIELDS = {
  id: true,
  email: true,
  projectRole: true,
  teamRole: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  invitedBy: { select: { name: true } },
  project: { select: { id: true, name: true, status: true } },
  team: { select: { id: true, name: true } },
} as const satisfies Prisma.InvitationSelect;

type LookupRow = Prisma.InvitationGetPayload<{ select: typeof LOOKUP_FIELDS }>;

/** Lời mời còn dùng được, và đích của nó — hay `null` cho MỌI trường hợp còn lại (một 404 duy nhất) */
function usableTarget(
  row: LookupRow | null,
  now: Date,
): InvitationTargetWire | null {
  if (
    row === null ||
    row.acceptedAt !== null ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  if (row.project !== null && row.projectRole !== null) {
    if (row.project.status === "DELETED" || row.projectRole === "OWNER") {
      return null;
    }
    return {
      kind: "PROJECT",
      id: row.project.id,
      name: row.project.name,
      projectRole: row.projectRole,
    };
  }
  if (row.team !== null && row.teamRole !== null) {
    return {
      kind: "TEAM",
      id: row.team.id,
      name: row.team.name,
      teamRole: row.teamRole,
    };
  }
  // CHECK `invitations_one_target` cấm hình này; nếu nó từng bị gỡ thì coi như không dùng được
  return null;
}

/** Thứ người cầm đường dẫn thấy trước khi đăng nhập */
export async function lookup(token: string) {
  const row = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: LOOKUP_FIELDS,
  });
  const target = usableTarget(row, new Date());
  if (row === null || target === null) throw new NotFoundError(GONE);
  return {
    target,
    email: row.email,
    invitedBy: { name: row.invitedBy.name },
    expiresAt: row.expiresAt.toISOString(),
  };
}

type Tx = Prisma.TransactionClient;

/** Vào project với vai được mời — người đã có vai cao hơn giữ nguyên vai của mình */
async function joinProject(
  tx: Tx,
  projectId: string,
  userId: string,
  projectRole: Exclude<ProjectRole, "OWNER">,
): Promise<void> {
  const existing = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectRole: true },
  });
  if (existing === null) {
    await tx.projectMember.create({ data: { projectId, userId, projectRole } });
  } else if (!hasMinProjectRole(existing.projectRole, projectRole)) {
    await tx.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { projectRole },
    });
  }
}

async function joinTeam(
  tx: Tx,
  teamId: string,
  userId: string,
  teamRole: TeamRole,
): Promise<void> {
  const existing = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { teamRole: true },
  });
  if (existing === null) {
    await tx.teamMember.create({ data: { teamId, userId, teamRole } });
  } else if (!hasMinTeamRole(existing.teamRole, teamRole)) {
    await tx.teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { teamRole },
    });
  }
}

/**
 * Nhận lời mời bằng tài khoản đang đăng nhập. Email lấy từ database chứ không từ access token: token mang email
 * lúc cấp, database mang email bây giờ.
 */
export async function accept(
  token: string,
  userId: string,
  request: Request,
): Promise<InvitationTargetWire> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: LOOKUP_FIELDS,
    });
    const target = usableTarget(row, new Date());
    if (row === null || target === null) throw new NotFoundError(GONE);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user?.email !== row.email) {
      throw new ForbiddenError(
        "Lời mời này dành cho một email khác — đăng nhập bằng đúng email được mời",
      );
    }

    const claimed = await tx.invitation.updateMany({
      where: { id: row.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw new NotFoundError(GONE);

    if (target.kind === "PROJECT") {
      await joinProject(tx, target.id, userId, target.projectRole);
    } else {
      await joinTeam(tx, target.id, userId, target.teamRole);
    }

    const scope: InvitationTarget =
      target.kind === "PROJECT"
        ? { kind: "PROJECT", projectId: target.id }
        : { kind: "TEAM", teamId: target.id };
    await tx.auditLog.create({
      data: {
        projectId: auditProjectOf(scope),
        ...auditEntry({
          action: actionOf(scope, "accept"),
          targetType: "Invitation",
          targetId: row.id,
          after:
            target.kind === "PROJECT"
              ? { userId, projectRole: target.projectRole }
              : { userId, teamId: target.id, teamRole: target.teamRole },
          request,
        }),
      },
    });
    return target;
  });
}
