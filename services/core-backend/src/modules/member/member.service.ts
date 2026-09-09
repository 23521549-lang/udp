import type { Request } from "express";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors.js";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type {
  AddMemberInput,
  PublicMember,
  TransferOwnershipInput,
  UpdateMemberInput,
} from "./member.types.js";

const MEMBER_FIELDS = {
  userId: true,
  projectRole: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

export const list = (projectId: string): Promise<PublicMember[]> =>
  prisma.projectMember.findMany({
    where: { projectId },
    select: MEMBER_FIELDS,
    orderBy: { createdAt: "asc" },
  });

/**
 * Thêm thành viên theo email.
 *
 * §9 gọi endpoint này là "mời theo email", nhưng §16 ghi nhận hạ tầng mail chưa
 * có. Nên hành vi hiện tại là: người được thêm PHẢI đã có tài khoản, không thì
 * 404. Không dựng lời mời treo, vì không có bảng nào lưu nó và không có đường
 * nào gửi đi — một lời mời không ai nhận được thì tệ hơn một lỗi rõ ràng.
 *
 * Trùng thành viên không kiểm trước: `@@unique([projectId, userId])` ném P2002,
 * và `@udp/db` đã ánh xạ thành `DUPLICATE_RESOURCE` + 409. Kiểm trước chỉ thêm
 * một round-trip mà vẫn còn khe hở giữa lúc đọc và lúc ghi.
 */
export async function add(
  projectId: string,
  input: AddMemberInput,
  request: Request,
): Promise<PublicMember> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (user === null) {
    throw new NotFoundError("Chưa có tài khoản nào dùng email này");
  }

  const [member] = await prisma.$transaction([
    prisma.projectMember.create({
      data: { projectId, userId: user.id, projectRole: input.projectRole },
      select: MEMBER_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        project: { connect: { id: projectId } },
        ...auditEntry({
          action: "member.add",
          targetType: "ProjectMember",
          targetId: user.id,
          after: { projectRole: input.projectRole },
          request,
        }),
      },
    }),
  ]);

  return member;
}

export async function updateRole(
  projectId: string,
  userId: string,
  input: UpdateMemberInput,
  request: Request,
): Promise<PublicMember> {
  const current = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectRole: true },
  });

  if (current === null) {
    throw new NotFoundError("Không tìm thấy thành viên");
  }

  /**
   * Hạ chủ sở hữu bằng đường này là cách để project không còn OWNER nào.
   * `idx_one_owner_per_project` là ràng buộc **nhiều nhất một**, không phải
   * **ít nhất một** — nó sẽ không chặn, và project mồ côi vĩnh viễn.
   */
  if (current.projectRole === "OWNER") {
    throw new ValidationError(
      "Đổi vai trò chủ sở hữu phải qua POST /transfer-ownership",
    );
  }

  const [member] = await prisma.$transaction([
    prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { projectRole: input.projectRole },
      select: MEMBER_FIELDS,
    }),
    prisma.auditLog.create({
      data: {
        project: { connect: { id: projectId } },
        ...auditEntry({
          action: "member.role.update",
          targetType: "ProjectMember",
          targetId: userId,
          before: { projectRole: current.projectRole },
          after: { projectRole: input.projectRole },
          request,
        }),
      },
    }),
  ]);

  return member;
}

export async function remove(
  projectId: string,
  userId: string,
  request: Request,
): Promise<void> {
  const current = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { projectRole: true },
  });

  if (current === null) {
    throw new NotFoundError("Không tìm thấy thành viên");
  }

  if (current.projectRole === "OWNER") {
    throw new ConflictError(
      "Không xoá được chủ sở hữu — chuyển quyền cho người khác trước",
    );
  }

  await prisma.$transaction([
    prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    }),
    prisma.auditLog.create({
      data: {
        project: { connect: { id: projectId } },
        ...auditEntry({
          action: "member.remove",
          targetType: "ProjectMember",
          targetId: userId,
          before: { projectRole: current.projectRole },
          request,
        }),
      },
    }),
  ]);
}

/**
 * Chuyển quyền sở hữu.
 *
 * Ba chi tiết ở đây đều là hệ quả trực tiếp của ràng buộc trong database, không
 * phải lựa chọn phong cách:
 *
 * 1. **Khoá `FOR NO KEY UPDATE`, không phải `FOR UPDATE`.** `AuditLog.projectId`
 *    là khoá ngoại, nên MỌI INSERT audit của project này lấy `FOR KEY SHARE`
 *    trên chính hàng `projects`. `FOR UPDATE` xung đột với `FOR KEY SHARE`, tức
 *    là một lần chuyển quyền sẽ chặn mọi hành động có ghi audit của mọi thành
 *    viên trong suốt transaction. `FOR NO KEY UPDATE` vẫn tự xung đột với chính
 *    nó — đủ để hai lần chuyển quyền đồng thời xếp hàng — mà không chặn audit.
 *
 * 2. **Ép kiểu `::uuid`.** `$queryRaw` gửi tham số dưới dạng text; thiếu ép
 *    kiểu, Postgres báo `operator does not exist: uuid = text`.
 *
 * 3. **Hạ người cũ TRƯỚC, nâng người mới SAU.** `idx_one_owner_per_project` là
 *    unique index, và unique index KHÔNG hoãn được tới cuối transaction. Làm
 *    ngược lại thì câu UPDATE nâng cấp vi phạm ngay lập tức, và mọi lần chuyển
 *    quyền đều trả 409 dù logic hoàn toàn đúng.
 */
export async function transferOwnership(
  projectId: string,
  input: TransferOwnershipInput,
  request: Request,
): Promise<PublicMember> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR NO KEY UPDATE`;

    const [currentOwner, next] = await Promise.all([
      tx.projectMember.findFirst({
        where: { projectId, projectRole: "OWNER" },
        select: { userId: true },
      }),
      tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: input.userId } },
        select: { userId: true, projectRole: true },
      }),
    ]);

    if (next === null) {
      throw new NotFoundError("Người nhận phải đã là thành viên của project");
    }

    if (currentOwner?.userId === input.userId) {
      throw new ConflictError("Người nhận đã là chủ sở hữu");
    }

    if (currentOwner !== null) {
      // Chủ cũ xuống MAINTAINER: thiết kế không quy định vai trò mới, và đây là
      // mức cao nhất còn lại — người vừa nhường quyền không nên mất khả năng
      // vận hành project mình đã dựng.
      await tx.projectMember.update({
        where: { projectId_userId: { projectId, userId: currentOwner.userId } },
        data: { projectRole: "MAINTAINER" },
      });
    }

    const member = await tx.projectMember.update({
      where: { projectId_userId: { projectId, userId: input.userId } },
      data: { projectRole: "OWNER" },
      select: MEMBER_FIELDS,
    });

    /**
     * `Project.owner_id` là cột denormalized của cùng sự thật (§2.2). Quên cập
     * nhật nó là để hai nguồn lệch nhau vĩnh viễn, và không ràng buộc nào trong
     * database nối chúng lại để phát hiện.
     */
    await tx.project.update({
      where: { id: projectId },
      data: {
        ownerId: input.userId,
        auditLogs: {
          create: auditEntry({
            action: "member.ownership.transfer",
            targetType: "Project",
            targetId: projectId,
            before: { ownerId: currentOwner?.userId ?? null },
            after: { ownerId: input.userId },
            request,
          }),
        },
      },
    });

    return member;
  });
}
