import type { Request } from "express";
import {
  classifyOrphans,
  CREATED_RESOURCE_KINDS,
  ORPHAN_HOURLY_USD,
  type CreatedResourceKind,
} from "@udp/adapter-core";
import { ConflictError, NotFoundError } from "@udp/http";
import { auditEntry } from "../audit/audit.service.js";
import { providerFromDb } from "../provisioning/provider-codec.js";
import * as repository from "./admin.repository.js";
import type {
  AdminJobsQuery,
  AdminProjectsQuery,
  ListUsersQuery,
  UpdatePlatformRoleInput,
} from "./admin.types.js";

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

export async function users(query: ListUsersQuery) {
  const [rows, total] = await Promise.all([
    repository.listUsers(query.search, query.limit, query.offset),
    repository.countUsers(query.search),
  ]);
  return {
    users: rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
    total,
  };
}

/**
 * Đổi vai toàn hệ thống. Chặn hạ ADMIN CUỐI CÙNG: hệ thống không còn ai vào được
 * `/admin` để sửa lại — một thao tác không tự hoàn tác được từ chính giao diện. Ghi
 * audit với `projectId = null` (cột cho phép): đây là hành động của nền tảng, không của
 * project nào.
 */
export async function setPlatformRole(
  userId: string,
  input: UpdatePlatformRoleInput,
  request: Request,
) {
  const result = await repository.setPlatformRole(userId, input.platformRole, {
    projectId: null,
    ...auditEntry({
      action: "platform.role.update",
      targetType: "User",
      targetId: userId,
      after: { platformRole: input.platformRole },
      request,
    }),
  });
  if (result.kind === "not-found")
    throw new NotFoundError("Không tìm thấy người dùng");
  if (result.kind === "last-admin") {
    throw new ConflictError(
      "Không hạ được quản trị viên cuối cùng — hệ thống sẽ không còn ai vào được /admin",
    );
  }
  return { ...result.user, createdAt: result.user.createdAt.toISOString() };
}

export async function projects(query: AdminProjectsQuery) {
  const [rows, total] = await Promise.all([
    repository.listProjects(query.status, query.limit, query.offset),
    repository.countProjects(query.status),
  ]);
  const projects = rows.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    owner: p.owner,
    memberCount: p._count.members,
    cloudProvider: p.credentials[0]?.provider ?? null,
    createdAt: p.createdAt.toISOString(),
  }));
  return { projects, total };
}

export async function credentials() {
  const rows = await repository.listCredentials(100);
  return rows.map((c) => ({
    ...c,
    /** Đủ để đối chiếu, không đủ để làm gì khác */
    fingerprint: c.fingerprint.slice(0, 12),
    lastValidatedAt: iso(c.lastValidatedAt),
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function jobs(query: AdminJobsQuery) {
  const [rows, total] = await Promise.all([
    repository.listJobs(query.state, query.limit, query.offset),
    repository.countJobs(query.state),
  ]);
  return {
    jobs: rows.map((j) => ({
      ...j,
      lastError: j.lastError ?? null,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    })),
    total,
  };
}

/**
 * Tài nguyên mồ côi theo SỔ (§4.5): hàng `ORPHAN_SUSPECTED`, kèm USD/giờ từ
 * `classifyOrphans`. Nửa "quét cloud theo tag `udp.project`" cần credential thật và gọi
 * cloud, nên `unmatchedOnCloud` luôn rỗng ở đây — trả `cloudScanned: false` để màn hình
 * NÓI điều đó, thay vì để một danh sách rỗng trông như "không có gì sót".
 */
/**
 * `kind` là VARCHAR ở database; thu hẹp về tập của adapter-core bằng danh sách thật chứ
 * không ép kiểu — một `kind` lạ (adapter mới, dữ liệu cũ) thành "không định giá được",
 * không thành một số sai.
 */
const asKind = (kind: string): CreatedResourceKind | undefined =>
  CREATED_RESOURCE_KINDS.find((k) => k === kind);

export async function orphans() {
  const all = await repository.orphanRows();
  const rows = all.flatMap((r) => {
    const kind = asKind(r.kind);
    return kind === undefined
      ? []
      : [
          {
            projectId: r.projectId,
            step: r.step,
            kind,
            idempotencyKey: r.idempotencyKey,
            providerId: r.providerId,
            provider: providerFromDb(r.provider),
            region: r.region,
            status: r.status,
          },
        ];
  });
  const unknownKinds = all.filter((r) => asKind(r.kind) === undefined);
  const report = classifyOrphans({
    ledgerRows: rows,
    cloudIdsWithProjectTag: [],
  });
  return {
    resources: all.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.project.name,
      kind: r.kind,
      provider: r.provider,
      region: r.region,
      providerId: r.providerId,
      /** `null` = không định giá được — KHÁC 0 (xem `ORPHAN_HOURLY_USD`) */
      usdPerHour: ((k) =>
        k === undefined ? null : (ORPHAN_HOURLY_USD[k] ?? null))(
        asKind(r.kind),
      ),
      updatedAt: r.updatedAt.toISOString(),
    })),
    estimatedUsdPerHour: report.estimatedUsdPerHour,
    unpriced: [
      ...new Set([...report.unpriced, ...unknownKinds.map((r) => r.kind)]),
    ],
    pricingAsOf: report.pricingAsOf,
    cloudScanned: false,
  };
}
