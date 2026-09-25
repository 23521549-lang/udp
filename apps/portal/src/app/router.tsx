import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Toaster } from "../components/Toast";
import { useAuthStore } from "../features/auth/auth-store";
import { LoginPage, RegisterPage } from "../features/auth/AuthPages";
import {
  AdminCredentialsPage,
  AdminJobsPage,
  AdminLayout,
  AdminOrphansPage,
  AdminProjectsPage,
  AdminSystemPage,
  AdminUsersPage,
} from "../features/admin/AdminPages";
import { DeploymentsPage } from "../features/deployment/DeploymentsPage";
import { CleanupPage } from "../features/flag/CleanupPage";
import { FlagsPage } from "../features/flag/FlagsPage";
import { NewProjectPage } from "../features/project/NewProjectPage";
import { OverviewPage } from "../features/project/OverviewPage";
import { ProjectLayout } from "../features/project/ProjectLayout";
import { ProjectsPage } from "../features/project/ProjectsPage";
import { SettingsPage } from "../features/project/SettingsPage";
import { RolloutDetailPage } from "../features/rollout/RolloutDetailPage";
import { RolloutsPage } from "../features/rollout/RolloutsPage";
import { SegmentsPage } from "../features/segment/SegmentsPage";
import { AppShell } from "./AppShell";
import { NotFound, RouteError } from "./RouteError";

/**
 * Cây route (§10.3) — khai bằng MÃ, không sinh từ thư mục.
 *
 * Vì sao không file-based: `@tanstack/router-cli` và `router-plugin` không có peer nào
 * ràng phiên bản của nhau, nên hai generator có thể sinh hai `routeTree.gen.ts` khác nhau
 * trên hai máy (đo 24/09/2026). Cây khai bằng mã vẫn type-safe hoàn toàn, và không có
 * tệp sinh nào để lệch.
 *
 * Guard đọc thẳng Zustand (`getState()`), không qua context của router — §10.3 chỉ ra
 * bug "context cũ". `main.tsx` chỉ dựng router SAU khi `GET /auth/me` trả lời, nên guard
 * không bao giờ chạy trong lúc `isInitializing`.
 */

interface RouterContext {
  queryClient: QueryClient;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/projects" });
  },
});

interface LoginSearch {
  redirectTo?: string;
}
const loginSearch = (s: Record<string, unknown>): LoginSearch => {
  const redirectTo = str(s.redirectTo);
  return redirectTo === undefined ? {} : { redirectTo };
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearch,
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: RegisterPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  beforeLoad: ({ location }) => {
    if (useAuthStore.getState().user === null) {
      throw redirect({
        to: "/login",
        search: { redirectTo: location.href },
      });
    }
  },
  component: AppShell,
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/projects" });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects",
  component: ProjectsPage,
});

const newProjectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects/new",
  component: NewProjectPage,
});

/** `env` sống trên URL (§10.12): refresh trang, gửi link cho đồng nghiệp đều giữ đúng env */
export interface ProjectSearch {
  env?: string;
}
const projectSearch = (s: Record<string, unknown>): ProjectSearch => {
  const env = str(s.env);
  return env === undefined ? {} : { env };
};

export const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects/$projectId",
  validateSearch: projectSearch,
  component: ProjectLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: OverviewPage,
});

/** `flag` = flag đang mở ở panel xem nhanh — deep-link được mà không cần route lồng (§10.8) */
export interface FlagsSearch {
  flag?: string;
  q?: string;
  /** "1" = mở hộp tạo flag (từ bảng lệnh) */
  new?: "1";
}
export const flagsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "flags",
  validateSearch: (s: Record<string, unknown>): FlagsSearch => {
    const flag = str(s.flag);
    const q = str(s.q);
    return {
      ...(flag === undefined ? {} : { flag }),
      ...(q === undefined ? {} : { q }),
      ...(s.new === "1" ? { new: "1" as const } : {}),
    };
  },
  component: FlagsPage,
});

const cleanupRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "flags/cleanup",
  component: CleanupPage,
});

export interface SegmentsSearch {
  segment?: string;
}
export const segmentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "segments",
  validateSearch: (s: Record<string, unknown>): SegmentsSearch => {
    const segment = str(s.segment);
    return segment === undefined ? {} : { segment };
  },
  component: SegmentsPage,
});

export interface RolloutsSearch {
  /** "1" = mở hộp tạo rollout (từ bảng lệnh) */
  new?: "1";
}
const rolloutsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "rollouts",
  validateSearch: (s: Record<string, unknown>): RolloutsSearch =>
    s.new === "1" ? { new: "1" } : {},
  component: RolloutsPage,
});

export const rolloutDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "rollouts/$rolloutId",
  component: RolloutDetailPage,
});

const deploymentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "deployments",
  component: DeploymentsPage,
});

export interface SettingsSearch {
  tab?: "keys" | "members" | "audit" | "project";
}
const TABS = ["keys", "members", "audit", "project"] as const;
export const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  validateSearch: (s: Record<string, unknown>): SettingsSearch => {
    const tab = TABS.find((t) => t === s.tab);
    return tab === undefined ? {} : { tab };
  },
  component: SettingsPage,
});

/**
 * Khu quản trị: guard đọc `platformRole` từ store để ẨN (§10.3); chặn thật ở Service 1.
 * Chưa đăng nhập ⇒ /login; đăng nhập mà không phải admin ⇒ về /app/projects.
 */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  beforeLoad: ({ location }) => {
    const user = useAuthStore.getState().user;
    if (user === null) {
      throw redirect({ to: "/login", search: { redirectTo: location.href } });
    }
    if (user.platformRole !== "PLATFORM_ADMIN") {
      throw redirect({ to: "/app/projects" });
    }
  },
  component: AdminLayout,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/admin/users" });
  },
});
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: AdminUsersPage,
});
const adminProjectsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "projects",
  component: AdminProjectsPage,
});
const adminCredentialsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "credentials",
  component: AdminCredentialsPage,
});
const adminJobsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "jobs",
  component: AdminJobsPage,
});
const adminOrphansRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "orphans",
  component: AdminOrphansPage,
});
const adminSystemRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "system",
  component: AdminSystemPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminUsersRoute,
    adminProjectsRoute,
    adminCredentialsRoute,
    adminJobsRoute,
    adminOrphansRoute,
    adminSystemRoute,
  ]),
  appRoute.addChildren([
    appIndexRoute,
    projectsRoute,
    newProjectRoute,
    projectRoute.addChildren([
      overviewRoute,
      flagsRoute,
      cleanupRoute,
      segmentsRoute,
      rolloutsRoute,
      rolloutDetailRoute,
      deploymentsRoute,
      settingsRoute,
    ]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: false,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
