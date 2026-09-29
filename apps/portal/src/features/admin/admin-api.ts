import {
  adminCredentialsResponseWire,
  adminJobsResponseWire,
  adminOrphansResponseWire,
  adminOverviewResponseWire,
  adminPlatformResponseWire,
  adminProjectsResponseWire,
  adminSystemResponseWire,
  adminUserResponseWire,
  adminUsersResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** [Plan #53] Một trang của danh sách quản trị — `total` ở máy chủ, không cắt im lặng */
export const ADMIN_PAGE_SIZE = 50;

export const adminApi = {
  overview: () => api(adminOverviewResponseWire, "/admin/overview"),
  platform: () => api(adminPlatformResponseWire, "/admin/platform"),
  users: (search: string | undefined, offset: number) =>
    api(adminUsersResponseWire, "/admin/users", {
      query: { search, limit: ADMIN_PAGE_SIZE, offset },
    }),
  setRole: (userId: string, platformRole: "USER" | "PLATFORM_ADMIN") =>
    api(adminUserResponseWire, `/admin/users/${userId}/platform-role`, {
      method: "PATCH",
      body: { platformRole },
    }),
  projects: (status: string | undefined, offset: number) =>
    api(adminProjectsResponseWire, "/admin/projects", {
      query: { status, limit: ADMIN_PAGE_SIZE, offset },
    }),
  credentials: () => api(adminCredentialsResponseWire, "/admin/credentials"),
  jobs: (state: string, offset: number) =>
    api(adminJobsResponseWire, "/admin/jobs", {
      query: { state, limit: ADMIN_PAGE_SIZE, offset },
    }),
  orphans: () => api(adminOrphansResponseWire, "/admin/orphan-resources"),
  system: () => api(adminSystemResponseWire, "/admin/system/health"),
};
