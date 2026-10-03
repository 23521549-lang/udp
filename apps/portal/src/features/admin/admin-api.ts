import {
  adminCredentialsResponseWire,
  adminEvidenceDoraResponseWire,
  adminJobsResponseWire,
  adminOrphansResponseWire,
  adminOverviewResponseWire,
  adminPlatformResponseWire,
  adminProjectsResponseWire,
  adminSystemResponseWire,
  adminUserResponseWire,
  adminUsersResponseWire,
  type EvidenceDoraDays,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";
import type { AdminProjectStatus, AdminRole } from "./admin-search";

/** [Plan #53] Một trang của danh sách quản trị — `total` ở máy chủ, không cắt im lặng */
export const ADMIN_PAGE_SIZE = 50;

/**
 * [Plan #58 UX-34] Bộ lọc của một danh sách theo trang — CHÍNH tham số gửi lên máy chủ: `search` (project: tên hoặc email
 * chủ), `platformRole` (người dùng), `order=asc` (cũ nhất trước; mặc định mới nhất trước).
 */
export interface AdminListFilter {
  search?: string | undefined;
  status?: AdminProjectStatus | undefined;
  platformRole?: AdminRole | undefined;
  order?: "asc" | undefined;
}

export const adminApi = {
  overview: () => api(adminOverviewResponseWire, "/admin/overview"),
  platform: () => api(adminPlatformResponseWire, "/admin/platform"),
  users: (f: AdminListFilter, offset: number) =>
    api(adminUsersResponseWire, "/admin/users", {
      query: {
        search: f.search,
        platformRole: f.platformRole,
        order: f.order,
        limit: ADMIN_PAGE_SIZE,
        offset,
      },
    }),
  setRole: (userId: string, platformRole: "USER" | "PLATFORM_ADMIN") =>
    api(adminUserResponseWire, `/admin/users/${userId}/platform-role`, {
      method: "PATCH",
      body: { platformRole },
    }),
  projects: (f: AdminListFilter, offset: number) =>
    api(adminProjectsResponseWire, "/admin/projects", {
      query: {
        status: f.status,
        search: f.search,
        order: f.order,
        limit: ADMIN_PAGE_SIZE,
        offset,
      },
    }),
  credentials: () => api(adminCredentialsResponseWire, "/admin/credentials"),
  jobs: (state: string, offset: number) =>
    api(adminJobsResponseWire, "/admin/jobs", {
      query: { state, limit: ADMIN_PAGE_SIZE, offset },
    }),
  orphans: () => api(adminOrphansResponseWire, "/admin/orphan-resources"),
  system: () => api(adminSystemResponseWire, "/admin/system/health"),
  /** [Plan #56] E10 của cả nền tảng cho trang Bằng chứng */
  evidenceDora: (days: EvidenceDoraDays) =>
    api(adminEvidenceDoraResponseWire, "/admin/evidence/dora", {
      query: { days },
    }),
};

/** Một dòng của mỗi danh sách quản trị — suy từ chính hàm gọi, nên luôn khớp schema dây */
type Rows<F extends (...a: never[]) => Promise<unknown>> = Awaited<
  ReturnType<F>
>;
export type AdminProjectRow = Rows<
  typeof adminApi.projects
>["projects"][number];
export type AdminJobRow = Rows<typeof adminApi.jobs>["jobs"][number];
export type AdminCredentialRow = Rows<
  typeof adminApi.credentials
>["credentials"][number];
export type AdminOrphanRow = Rows<typeof adminApi.orphans>["resources"][number];
