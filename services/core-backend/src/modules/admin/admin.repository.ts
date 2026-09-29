import type { JobState, PlatformRole, Prisma, ProjectStatus } from "@udp/db";
import { prisma } from "../../core/db.js";

/**
 * [v4.11, Plan #53] Mọi danh sách admin theo trang: `take`/`skip` cho trang, và `count` trên CÙNG
 * điều kiện cho `total` — một nguồn điều kiện, để tổng không lệch với trang.
 */
const userWhere = (search: string | undefined): Prisma.UserWhereInput =>
  search === undefined
    ? {}
    : {
        OR: [
          { email: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ],
      };

export const countUsers = (search: string | undefined) =>
  prisma.user.count({ where: userWhere(search) });

export const listUsers = (
  search: string | undefined,
  take: number,
  skip: number,
) =>
  prisma.user.findMany({
    where: userWhere(search),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
    skip,
    select: {
      id: true,
      email: true,
      name: true,
      platformRole: true,
      createdAt: true,
    },
  });

/**
 * Luật "không hạ admin cuối cùng", tách thành hàm thuần: database nào cũng có admin của
 * seed (`admin@udp.local`), nên nhánh chặn không bao giờ tới được trong test tích hợp —
 * test nó ở đây, và test tích hợp khẳng định phần nối dây.
 */
export function demotesLastAdmin(
  current: PlatformRole,
  next: PlatformRole,
  adminCount: number,
): boolean {
  return current === "PLATFORM_ADMIN" && next === "USER" && adminCount <= 1;
}

/**
 * Đổi vai toàn hệ thống — trong MỘT transaction có khoá hàng, để hai admin cùng hạ nhau
 * không cùng đếm thấy "còn một admin khác" rồi cùng thành công (hệ thống không còn admin
 * nào). `FOR UPDATE` trên mọi hàng PLATFORM_ADMIN tuần tự hoá hai lệnh đó.
 */
export async function setPlatformRole(
  userId: string,
  platformRole: PlatformRole,
  audit: Prisma.AuditLogUncheckedCreateInput,
): Promise<
  | {
      kind: "ok";
      user: {
        id: string;
        email: string;
        name: string;
        platformRole: PlatformRole;
        createdAt: Date;
      };
    }
  | { kind: "not-found" }
  | { kind: "last-admin" }
> {
  return prisma.$transaction(async (tx) => {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE platform_role = 'PLATFORM_ADMIN' FOR UPDATE`;
    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    if (target === null) return { kind: "not-found" as const };
    if (demotesLastAdmin(target.platformRole, platformRole, admins.length)) {
      return { kind: "last-admin" as const };
    }
    const user = await tx.user.update({
      where: { id: userId },
      data: { platformRole },
      select: {
        id: true,
        email: true,
        name: true,
        platformRole: true,
        createdAt: true,
      },
    });
    await tx.auditLog.create({ data: audit });
    return { kind: "ok" as const, user };
  });
}

const projectWhere = (
  status: ProjectStatus | undefined,
): Prisma.ProjectWhereInput => (status === undefined ? {} : { status });

export const countProjects = (status: ProjectStatus | undefined) =>
  prisma.project.count({ where: projectWhere(status) });

export const listProjects = (
  status: ProjectStatus | undefined,
  take: number,
  skip: number,
) =>
  prisma.project.findMany({
    where: projectWhere(status),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
    skip,
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      owner: { select: { id: true, email: true } },
      _count: { select: { members: true } },
      credentials: {
        where: { isActive: true },
        select: { provider: true },
        take: 1,
      },
    },
  });

/**
 * Metadata credential — KHÔNG đọc cột mã hoá nào (`encrypted_*`, `nonce`, `auth_tag`):
 * `select` tường minh là cách để một lần thêm cột sau này không lọt ra màn hình admin.
 */
export const listCredentials = (take: number) =>
  prisma.cloudCredential.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      provider: true,
      mode: true,
      authKind: true,
      fingerprint: true,
      isActive: true,
      lastValidatedAt: true,
      createdAt: true,
      project: { select: { id: true, name: true } },
    },
  });

export const countJobs = (state: JobState) =>
  prisma.provisioningJob.count({ where: { state } });

export const listJobs = (state: JobState, take: number, skip: number) =>
  prisma.provisioningJob.findMany({
    where: { state },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take,
    skip,
    select: {
      id: true,
      jobType: true,
      state: true,
      attempt: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { id: true, name: true } },
    },
  });

export const orphanRows = () =>
  prisma.provisionedResource.findMany({
    where: { status: "ORPHAN_SUSPECTED" },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: {
      id: true,
      jobId: true,
      projectId: true,
      step: true,
      kind: true,
      idempotencyKey: true,
      providerId: true,
      provider: true,
      region: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      project: { select: { name: true } },
    },
  });
