import type { Request } from "express";
import type { ProjectRole } from "@udp/db";
import { logger, NotFoundError } from "@udp/http";
import type { ProjectClusterWire } from "@udp/shared-types/wire";
import { z } from "zod";
import { activeMeta } from "../cloud/cloud.repository.js";
import {
  retireInfrastructure,
  type EnqueueJob,
} from "../provisioning/provisioning.service.js";
import * as repository from "./project.repository.js";
import type {
  CreateProjectInput,
  ListProjectsQuery,
  PublicEnvironment,
  PublicProject,
  UpdateQuotaInput,
  UpdateTtlInput,
} from "./project.types.js";

/**
 * Nghiệp vụ project.
 *
 * Không có `try/catch` quanh lỗi trùng tên: `idx_project_name_per_owner` ném
 * `P2002`, và `@udp/db` đã ánh xạ mã đó thành `DUPLICATE_RESOURCE` + HTTP 409 ở
 * một điểm hội tụ duy nhất. Bắt rồi ném lại `ConflictError` thủ công ở đây sẽ
 * vô hiệu hoá đường đó và làm mất `code` nghiệp vụ mà client dùng để tra
 * catalog.
 */

export const create = (
  input: CreateProjectInput,
  ownerId: string,
  request: Request,
): Promise<PublicProject & { environments: PublicEnvironment[] }> =>
  repository.createWithDefaults({
    ownerId,
    name: input.name,
    creationMode: input.creationMode,
    languageRuntime: input.languageRuntime,
    ...(input.repoUrl === undefined ? {} : { repoUrl: input.repoUrl }),
    resourceQuota: input.resourceQuota,
    request,
  });

export const listForUser = (userId: string, page: ListProjectsQuery) =>
  repository.listForUser(userId, page);

export async function getById(
  id: string,
): Promise<PublicProject & { environments: PublicEnvironment[] }> {
  const project = await repository.findById(id);
  if (project === null || project.status === "DELETED") {
    throw new NotFoundError("Không tìm thấy project");
  }
  return project;
}

/** Phần địa chỉ của `cluster_access` (ADR-06) — `caData` và tài khoản dịch vụ không ra dây */
const clusterAddressSchema = z.object({
  clusterId: z.string().min(1),
  apiEndpoint: z.string().min(1),
});

/**
 * [v4.11, Plan #45] Cluster của project cho thẻ Tổng quan (§10.6): địa chỉ từ `cluster_access`,
 * cloud và region từ credential đang dùng. `null` khi project chưa có cluster — hay khi credential
 * đã bị gỡ: thẻ không đoán nửa phần còn lại.
 */
export async function clusterOf(
  projectId: string,
): Promise<ProjectClusterWire | null> {
  const [access, meta] = await Promise.all([
    repository.clusterAccessOf(projectId),
    activeMeta(projectId),
  ]);
  const address = clusterAddressSchema.safeParse(access);
  if (!address.success || meta === null) return null;
  return {
    clusterId: address.data.clusterId,
    apiEndpoint: address.data.apiEndpoint,
    provider: meta.provider,
    region: meta.region,
  };
}

/**
 * Ảnh `before` đọc ở một lượt riêng trước khi ghi.
 *
 * Nói rõ giới hạn: giữa lúc đọc và lúc ghi, một request khác có thể đã đổi
 * quota, nên `before` trong audit là ảnh gần đúng chứ không phải ảnh khoá.
 * Chấp nhận được vì `before` là trường để người đọc hiểu bối cảnh, không phải
 * căn cứ để quyết định gì. Khoá hàng chỉ vì nó sẽ chặn mọi ghi audit khác của
 * project trong lúc đó — cái giá lớn hơn nhiều so với thứ nhận lại.
 */
export async function updateQuota(
  id: string,
  input: UpdateQuotaInput,
  request: Request,
): Promise<PublicProject> {
  const current = await repository.findQuotaAndTtl(id);
  return repository.updateQuota(
    id,
    input.resourceQuota,
    current?.resourceQuota,
    request,
  );
}

export async function updateTtl(
  id: string,
  input: UpdateTtlInput,
  request: Request,
): Promise<PublicProject> {
  const current = await repository.findQuotaAndTtl(id);
  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  return repository.updateTtl(
    id,
    expiresAt,
    { expiresAt: current?.expiresAt ?? null },
    request,
  );
}

/**
 * Xoá mềm + giao việc dọn hạ tầng (§9 "soft-delete + enqueue teardown", Plan #29 QĐ-3).
 *
 * Xoá mềm, audit và job TEARDOWN (hay yêu cầu hủy job PROVISION đang chạy) đi trong MỘT
 * transaction; job chỉ được gửi sang hàng đợi SAU commit — hỏng ở đó thì đối soát gửi lại
 * (outbox, Plan #28 QĐ-1).
 */
export async function remove(
  id: string,
  request: Request,
  enqueue: EnqueueJob,
): Promise<void> {
  const jobId = await repository.softDeleteWith(id, request, (tx) =>
    retireInfrastructure(tx, id),
  );
  if (jobId !== null && enqueue !== null) {
    await enqueue(jobId).catch((err: unknown) => {
      logger.warn({ err, jobId }, "Chưa gửi được job TEARDOWN sang hàng đợi");
    });
  }
}
