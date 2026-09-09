import type { Request } from "express";
import { NotFoundError } from "../../core/errors.js";
import * as repository from "./project.repository.js";
import type {
  CreateProjectInput,
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

export const listForUser = (userId: string): Promise<PublicProject[]> =>
  repository.listForUser(userId);

export async function getById(
  id: string,
): Promise<PublicProject & { environments: PublicEnvironment[] }> {
  const project = await repository.findById(id);
  if (project === null || project.status === "DELETED") {
    throw new NotFoundError("Không tìm thấy project");
  }
  return project;
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
 * Xoá mềm.
 *
 * §9 mô tả endpoint này là "soft-delete + enqueue teardown". Phần enqueue chưa
 * làm được: hạ tầng `jobs/` (pg-boss) của §3.1 chưa tồn tại, nên chưa có hàng
 * đợi nào để đẩy việc vào. Ghi rõ ở đây thay vì im lặng bỏ qua — tài nguyên
 * cloud của project bị xoá mềm hiện KHÔNG tự được dọn.
 */
export const remove = (id: string, request: Request): Promise<PublicProject> =>
  repository.softDelete(id, request);
