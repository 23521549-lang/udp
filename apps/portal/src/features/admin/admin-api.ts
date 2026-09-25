import {
  adminCredentialsResponseWire,
  adminJobsResponseWire,
  adminOrphansResponseWire,
  adminProjectsResponseWire,
  adminSystemResponseWire,
  adminUserResponseWire,
  adminUsersResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

export const adminApi = {
  users: (search: string | undefined) =>
    api(adminUsersResponseWire, "/admin/users", {
      query: { search, limit: 100 },
    }),
  setRole: (userId: string, platformRole: "USER" | "PLATFORM_ADMIN") =>
    api(adminUserResponseWire, `/admin/users/${userId}/platform-role`, {
      method: "PATCH",
      body: { platformRole },
    }),
  projects: (status: string | undefined) =>
    api(adminProjectsResponseWire, "/admin/projects", {
      query: { status, limit: 100 },
    }),
  credentials: () => api(adminCredentialsResponseWire, "/admin/credentials"),
  jobs: (state: string) =>
    api(adminJobsResponseWire, "/admin/jobs", { query: { state, limit: 100 } }),
  orphans: () => api(adminOrphansResponseWire, "/admin/orphan-resources"),
  system: () => api(adminSystemResponseWire, "/admin/system/health"),
};
