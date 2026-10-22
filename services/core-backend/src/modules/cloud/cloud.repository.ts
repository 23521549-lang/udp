import type { Prisma } from "@udp/db";
import { prisma } from "../../core/db.js";

/**
 * Bảng `cloud_credentials` (§2.2, §4.3). Service 1 là writer DUY NHẤT (§1.2).
 *
 * Hai hình đọc, tách hẳn: `META` cho mọi màn hình (không một cột mã hoá nào), và
 * `ENVELOPE` chỉ cho resolver — `select` tường minh để một cột thêm sau này không lọt
 * sang đường hiển thị.
 */

const META = {
  id: true,
  projectId: true,
  provider: true,
  mode: true,
  authKind: true,
  region: true,
  fingerprint: true,
  lastValidatedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, email: true } },
} as const satisfies Prisma.CloudCredentialSelect;

const ENVELOPE = {
  ...META,
  encryptedPayload: true,
  encryptedDek: true,
  kekVersion: true,
  dekVersion: true,
  nonce: true,
  authTag: true,
} as const satisfies Prisma.CloudCredentialSelect;

export type CredentialMeta = Prisma.CloudCredentialGetPayload<{
  select: typeof META;
}>;
export type CredentialEnvelope = Prisma.CloudCredentialGetPayload<{
  select: typeof ENVELOPE;
}>;

export const activeMeta = (projectId: string): Promise<CredentialMeta | null> =>
  prisma.cloudCredential.findFirst({
    where: { projectId, isActive: true },
    select: META,
  });

export const activeEnvelope = (
  projectId: string,
): Promise<CredentialEnvelope | null> =>
  prisma.cloudCredential.findFirst({
    where: { projectId, isActive: true },
    select: ENVELOPE,
  });

/**
 * Thay credential đang dùng trong MỘT transaction: tắt bản cũ, ghi bản mới, ghi audit.
 *
 * Hai `PUT /cloud` đồng thời: `idx_one_active_credential_per_project` cho đúng một bản
 * thắng, bản kia nhận P2002 ⇒ 409 `DUPLICATE_RESOURCE` qua ánh xạ chung của `@udp/db` —
 * không bao giờ hai hàng `is_active` và adapter phải đoán dùng cái nào.
 */
export async function replaceActive(
  data: Prisma.CloudCredentialUncheckedCreateInput,
  audit: Omit<Prisma.AuditLogUncheckedCreateInput, "projectId">,
): Promise<CredentialMeta> {
  const [, created] = await prisma.$transaction([
    prisma.cloudCredential.updateMany({
      where: { projectId: data.projectId, isActive: true },
      data: { isActive: false },
    }),
    prisma.cloudCredential.create({
      data: { ...data, isActive: true },
      select: META,
    }),
    prisma.auditLog.create({ data: { ...audit, projectId: data.projectId } }),
  ]);
  return created;
}

export const markValidated = (id: string, at: Date): Promise<unknown> =>
  prisma.cloudCredential.update({
    where: { id },
    data: { lastValidatedAt: at },
    select: { id: true },
  });
