import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { DEFAULT_ENVIRONMENTS, k8sNamespaceFor } from "@udp/config";
import type { CreationMode, Prisma } from "@udp/db";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import type {
  PublicEnvironment,
  PublicProject,
  ResourceQuota,
} from "./project.types.js";

/**
 * Tầng dữ liệu của project.
 *
 * Cùng lý do tách như `auth.repository`: `select` khai một chỗ, nên cột nhạy
 * cảm thêm sau này không tự lọt ra API.
 */
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  ownerId: true,
  creationMode: true,
  languageRuntime: true,
  repoUrl: true,
  status: true,
  resourceQuota: true,
  expiresAt: true,
  createdAt: true,
} as const;

const ENV_FIELDS = {
  id: true,
  name: true,
  k8sNamespace: true,
  isProduction: true,
  rank: true,
  autoDeploy: true,
} as const;

export interface CreateProjectData {
  ownerId: string;
  name: string;
  creationMode: CreationMode;
  languageRuntime: string;
  repoUrl?: string;
  resourceQuota: ResourceQuota;
  request: Request;
}

/**
 * Tạo project, hàng OWNER, ba environment mặc định và audit — trong MỘT lệnh.
 *
 * Vì sao nested write chứ không phải `$transaction` tương tác: một transaction
 * tương tác giữ nguyên một connection suốt cả sáu round-trip, mà `maxWait` mặc
 * định là 2 giây và pool mặc định chỉ 5 kết nối. Sáu người tạo project cùng lúc
 * là đủ để người thứ sáu nhận P2024 rồi thành 500. Nested write vẫn nằm trong
 * một transaction ngầm của Prisma nên tính nguyên tử không đổi, mà chỉ tốn một
 * lượt đi về.
 *
 * `id` sinh ở phía ứng dụng chứ không để database mặc định: `k8sNamespaceFor`
 * cần chính id đó làm hậu tố chống va chạm, mà nested write thì không có cách
 * nào đọc được id vừa sinh ở giữa chừng.
 */
export async function createWithDefaults(
  data: CreateProjectData,
): Promise<PublicProject & { environments: PublicEnvironment[] }> {
  const id = randomUUID();

  return prisma.project.create({
    data: {
      id,
      ownerId: data.ownerId,
      name: data.name,
      creationMode: data.creationMode,
      languageRuntime: data.languageRuntime,
      ...(data.repoUrl === undefined ? {} : { repoUrl: data.repoUrl }),
      resourceQuota: data.resourceQuota,
      // §8.1: project sinh ra ở DRAFT. Nó chỉ thành ACTIVE sau khi provisioning
      // xong — trước đó chưa có cluster nào để nói là đang chạy.
      status: "DRAFT",
      members: { create: { userId: data.ownerId, projectRole: "OWNER" } },
      environments: {
        create: DEFAULT_ENVIRONMENTS.map((spec) => ({
          name: spec.name,
          rank: spec.rank,
          isProduction: spec.isProduction,
          /**
           * `autoDeploy` PHẢI đặt tường minh. Mặc định của schema là `true`,
           * còn §8.3 đòi production không tự deploy từ webhook — không có dòng
           * này thì `prod` sinh ra với auto-deploy đang bật, trái thiết kế mà
           * không có gì báo. `DEFAULT_ENVIRONMENTS` không mang thông tin đó.
           */
          autoDeploy: !spec.isProduction,
          k8sNamespace: k8sNamespaceFor(data.name, id, spec.name),
        })),
      },
      auditLogs: {
        create: auditEntry({
          action: "project.create",
          targetType: "Project",
          targetId: id,
          after: { name: data.name, creationMode: data.creationMode },
          request: data.request,
        }),
      },
    },
    select: {
      ...PUBLIC_FIELDS,
      environments: { select: ENV_FIELDS, orderBy: { rank: "asc" } },
    },
  });
}

/**
 * Danh sách project của người gọi.
 *
 * Lọc theo `members.some` chứ không theo `ownerId`: I10 chỉ phủ route có id
 * project, còn `GET /projects` không có id nên middleware phân quyền không chạm
 * tới. §12.2 tầng 1 vì thế áp thẳng vào đây — mọi truy vấn phải tự mang điều
 * kiện thuộc về ai. Bỏ dòng `where` này là rò toàn bộ project của mọi tenant.
 */
export const listForUser = (userId: string): Promise<PublicProject[]> =>
  prisma.project.findMany({
    where: { status: { not: "DELETED" }, members: { some: { userId } } },
    select: PUBLIC_FIELDS,
    orderBy: { createdAt: "desc" },
  });

export const findById = (
  id: string,
): Promise<(PublicProject & { environments: PublicEnvironment[] }) | null> =>
  prisma.project.findUnique({
    where: { id },
    select: {
      ...PUBLIC_FIELDS,
      environments: { select: ENV_FIELDS, orderBy: { rank: "asc" } },
    },
  });

/** Chỉ để dựng ảnh `before` của audit — không trả ra API */
export const findQuotaAndTtl = (
  id: string,
): Promise<{
  resourceQuota: Prisma.JsonValue;
  expiresAt: Date | null;
} | null> =>
  prisma.project.findUnique({
    where: { id },
    select: { resourceQuota: true, expiresAt: true },
  });

interface AuditedUpdate {
  id: string;
  action: string;
  before?: unknown;
  after?: unknown;
  request: Request;
}

/** Cập nhật kèm audit trong cùng một lệnh — xem ghi chú ở `createWithDefaults` */
const updateWithAudit = (
  update: Prisma.ProjectUpdateInput,
  meta: AuditedUpdate,
): Promise<PublicProject> =>
  prisma.project.update({
    where: { id: meta.id },
    data: {
      ...update,
      auditLogs: {
        create: auditEntry({
          action: meta.action,
          targetType: "Project",
          targetId: meta.id,
          ...(meta.before === undefined ? {} : { before: meta.before }),
          ...(meta.after === undefined ? {} : { after: meta.after }),
          request: meta.request,
        }),
      },
    },
    select: PUBLIC_FIELDS,
  });

export const updateQuota = (
  id: string,
  resourceQuota: ResourceQuota,
  before: unknown,
  request: Request,
): Promise<PublicProject> =>
  updateWithAudit(
    { resourceQuota },
    {
      id,
      action: "project.quota.update",
      before,
      after: resourceQuota,
      request,
    },
  );

export const updateTtl = (
  id: string,
  expiresAt: Date | null,
  before: unknown,
  request: Request,
): Promise<PublicProject> =>
  updateWithAudit(
    { expiresAt },
    { id, action: "project.ttl.update", before, after: { expiresAt }, request },
  );

/**
 * Xoá mềm.
 *
 * `prisma.project.delete()` sẽ **luôn** thất bại: `AuditLog.project` là
 * `ON DELETE RESTRICT`, và chính hàm này vừa ghi một hàng audit trỏ vào project
 * đó. §2.3 nói rõ đấy là chủ đích — sổ kiểm toán phải sống lâu hơn thứ nó ghi.
 */
export const softDelete = (
  id: string,
  request: Request,
): Promise<PublicProject> =>
  updateWithAudit(
    { status: "DELETED" },
    { id, action: "project.delete", request },
  );
