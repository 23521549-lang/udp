import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { Toaster } from "../components/Toast";
import {
  EVIDENCE_DORA_DAYS,
  RED_RANGES,
  type EvidenceDoraDays,
  type RedRange,
} from "@udp/shared-types/wire";
import { AdminLayout } from "../features/admin/AdminLayout";
import { AdminCredentialsPage } from "../features/admin/pages/AdminCredentialsPage";
import {
  ADMIN_JOB_STATES,
  AdminJobsPage,
  DEFAULT_ADMIN_JOB_STATE,
  type AdminJobState,
} from "../features/admin/pages/AdminJobsPage";
import { AdminOrphansPage } from "../features/admin/pages/AdminOrphansPage";
import { AdminOverviewPage } from "../features/admin/pages/AdminOverviewPage";
import {
  ADMIN_PROJECT_STATUSES,
  AdminProjectsPage,
  type AdminProjectStatus,
} from "../features/admin/pages/AdminProjectsPage";
import { AdminSystemPage } from "../features/admin/pages/AdminSystemPage";
import { AdminCatalogPage } from "../features/admin/pages/AdminCatalogPage";
import { EvidencePage } from "../features/admin/evidence/EvidencePage";
import { AdminUsersPage } from "../features/admin/pages/AdminUsersPage";
import { ArchitecturePage } from "../features/architecture/ArchitecturePage";
import { useAuthStore } from "../features/auth/auth-store";
import { LoginPage, RegisterPage } from "../features/auth/AuthPages";
import { DeploymentsPage } from "../features/deployment/DeploymentsPage";
import { CodePage } from "../features/code/CodePage";
import { DomainDetailPage } from "../features/domain/DomainDetailPage";
import { DomainsPage } from "../features/domain/DomainsPage";
import { InfraPage } from "../features/provisioning/InfraPage";
import { CleanupPage } from "../features/flag/CleanupPage";
import { FlagsPage } from "../features/flag/FlagsPage";
import { HomePage } from "../features/home/HomePage";
import { InvitePage } from "../features/invitation/InvitePage";
import {
  DEFAULT_RED_RANGE,
  MonitoringPage,
} from "../features/monitoring/MonitoringPage";
import { NewProjectPage } from "../features/project/NewProjectPage";
import { OverviewPage } from "../features/project/OverviewPage";
import { ProjectLayout } from "../features/project/ProjectLayout";
import { ProjectsPage } from "../features/project/ProjectsPage";
import { SettingsPage } from "../features/project/SettingsPage";
import { RolloutDetailPage } from "../features/rollout/RolloutDetailPage";
import { RolloutsPage } from "../features/rollout/RolloutsPage";
import { SegmentsPage } from "../features/segment/SegmentsPage";
import { TeamDetailPage } from "../features/team/TeamDetailPage";
import { TeamsPage } from "../features/team/TeamsPage";
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

/**
 * Vị trí trang (`offset`) trong URL (Plan #53 QĐ-9: URL phản ánh trạng thái — trang 3 của danh sách
 * gửi cho đồng nghiệp là trang 3). 0 là mặc định nên không ghi ra.
 */
const offsetOf = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

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
    throw redirect({ to: "/app/home" });
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
  // [Plan #55] Người được mời tạo tài khoản rồi quay về trang nhận lời mời
  validateSearch: loginSearch,
  component: RegisterPage,
});

/**
 * [Plan #55 QĐ-5] Trang nhận lời mời — NGOÀI `/app`: người được mời có thể chưa có tài khoản. Token ở fragment
 * (`/invite#<token>`), không ở path hay query: fragment không bao giờ tới máy chủ.
 */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  component: InvitePage,
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
    throw redirect({ to: "/app/home" });
  },
});

/** [Plan #53 QĐ-5] Trang chủ developer: việc cần xử lý của mọi project */
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "home",
  component: HomePage,
});

/** [Plan #55] Nhóm của người đăng nhập — đơn vị trao quyền cho nhiều project */
const teamsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "teams",
  component: TeamsPage,
});

const teamDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "teams/$teamId",
  component: TeamDetailPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects",
  validateSearch: (s: Record<string, unknown>): { offset?: number } => {
    const offset = offsetOf(s.offset);
    return offset === undefined ? {} : { offset };
  },
  component: ProjectsPage,
});

/**
 * Wizard tạo project giữ BƯỚC và PROJECT VỪA TẠO trong URL (Plan #53 QĐ-9): tải lại trang sau bước 1
 * quay về đúng bước đang làm của đúng project đó — trước đây về ô trống của bước 1, và bấm "Tạo" lần
 * nữa là một project trùng.
 */
export interface NewProjectSearch {
  project?: string;
  step?: "cloud" | "domains" | "preview";
  job?: string;
}
const WIZARD_STEPS = ["cloud", "domains", "preview"] as const;

const newProjectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "projects/new",
  validateSearch: (s: Record<string, unknown>): NewProjectSearch => {
    const project = str(s.project);
    const job = str(s.job);
    const step = WIZARD_STEPS.find((w) => w === s.step);
    return {
      ...(project === undefined ? {} : { project }),
      ...(step === undefined ? {} : { step }),
      ...(job === undefined ? {} : { job }),
    };
  },
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
  offset?: number;
  /** "1" = mở hộp tạo flag (từ bảng lệnh) */
  new?: "1";
}
export const flagsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "flags",
  validateSearch: (s: Record<string, unknown>): FlagsSearch => {
    const flag = str(s.flag);
    const q = str(s.q);
    const offset = offsetOf(s.offset);
    return {
      ...(flag === undefined ? {} : { flag }),
      ...(q === undefined ? {} : { q }),
      ...(offset === undefined ? {} : { offset }),
      ...(s.new === "1" ? { new: "1" as const } : {}),
    };
  },
  component: FlagsPage,
});

const CLEANUP_CATEGORIES = ["UNUSED", "SETTLED", "STALE_DRAFT"] as const;
const cleanupRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "flags/cleanup",
  validateSearch: (
    s: Record<string, unknown>,
  ): { category?: (typeof CLEANUP_CATEGORIES)[number] } => {
    const category = CLEANUP_CATEGORIES.find((c) => c === s.category);
    return category === undefined ? {} : { category };
  },
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

/** [Plan #53 QĐ-7] Công cụ đang chọn trên URL: gửi link là gửi đúng chỗ đang xem */
export const architectureRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "architecture",
  // [Plan #57 QĐ-1] Góc nhìn: mặc định "Tổng quan hệ thống" không ghi ra, `view=infra` là sơ đồ hạ tầng
  validateSearch: (
    s: Record<string, unknown>,
  ): { tool?: string; view?: "infra" } => {
    const tool = str(s.tool);
    return {
      ...(tool === undefined ? {} : { tool }),
      ...(s.view === "infra" ? { view: "infra" as const } : {}),
    };
  },
  component: ArchitecturePage,
});

/** [Plan #53 QĐ-4] Khoảng thời gian trên URL; mặc định (6 giờ) không ghi ra */
const monitoringRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "monitoring",
  validateSearch: (s: Record<string, unknown>): { range?: RedRange } => {
    const range = RED_RANGES.find((r) => r === s.range);
    return range === undefined || range === DEFAULT_RED_RANGE ? {} : { range };
  },
  component: MonitoringPage,
});

const deploymentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "deployments",
  component: DeploymentsPage,
});

/** [Plan #48] Mã nguồn: Golden Path (Create New) hoặc kết quả quét repo (Import Existing) — §11 */
const codeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "code",
  component: CodePage,
});

const domainsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "domains",
  component: DomainsPage,
});

export const domainDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "domains/$type",
  component: DomainDetailPage,
});

const infraRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "infra",
  component: InfraPage,
});

export interface SettingsSearch {
  tab?: "keys" | "environments" | "members" | "audit" | "cloud" | "project";
  /** Bộ lọc hành động của tab Nhật ký (Plan #53 QĐ-9: bộ lọc nằm trên URL) */
  action?: string;
  offset?: number;
}
const TABS = [
  "keys",
  "environments",
  "members",
  "audit",
  "cloud",
  "project",
] as const;
export const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  validateSearch: (s: Record<string, unknown>): SettingsSearch => {
    const tab = TABS.find((t) => t === s.tab);
    const action = str(s.action);
    const offset = offsetOf(s.offset);
    return {
      ...(tab === undefined ? {} : { tab }),
      ...(action === undefined ? {} : { action }),
      ...(offset === undefined ? {} : { offset }),
    };
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
      throw redirect({ to: "/app/home" });
    }
  },
  component: AdminLayout,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/admin/overview" });
  },
});
/** [Plan #53 QĐ-6] Nền tảng có khoẻ, có còn 0 đồng */
const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "overview",
  component: AdminOverviewPage,
});
/** Danh sách quản trị: bộ lọc và trang trên URL (Plan #53 QĐ-9) */
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  validateSearch: (
    s: Record<string, unknown>,
  ): { q?: string; offset?: number } => {
    const q = str(s.q);
    const offset = offsetOf(s.offset);
    return {
      ...(q === undefined ? {} : { q }),
      ...(offset === undefined ? {} : { offset }),
    };
  },
  component: AdminUsersPage,
});
const adminProjectsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "projects",
  validateSearch: (
    s: Record<string, unknown>,
  ): { status?: AdminProjectStatus; offset?: number } => {
    const status = ADMIN_PROJECT_STATUSES.find((v) => v === s.status);
    const offset = offsetOf(s.offset);
    return {
      ...(status === undefined ? {} : { status }),
      ...(offset === undefined ? {} : { offset }),
    };
  },
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
  validateSearch: (
    s: Record<string, unknown>,
  ): { state?: AdminJobState; offset?: number } => {
    const state = ADMIN_JOB_STATES.find((v) => v === s.state);
    const offset = offsetOf(s.offset);
    return {
      ...(state === undefined || state === DEFAULT_ADMIN_JOB_STATE
        ? {}
        : { state }),
      ...(offset === undefined ? {} : { offset }),
    };
  },
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

const adminCatalogRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "catalog",
  component: AdminCatalogPage,
});

/** [Plan #56] Bằng chứng thực nghiệm (§14); cửa sổ của E10 trên URL, mặc định 30 ngày không ghi ra */
const adminEvidenceRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "evidence",
  validateSearch: (s: Record<string, unknown>): { days?: EvidenceDoraDays } => {
    const days = EVIDENCE_DORA_DAYS.find((d) => d === Number(s.days));
    return days === undefined || days === 30 ? {} : { days };
  },
  component: EvidencePage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  inviteRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminOverviewRoute,
    adminUsersRoute,
    adminProjectsRoute,
    adminCredentialsRoute,
    adminJobsRoute,
    adminOrphansRoute,
    adminSystemRoute,
    adminCatalogRoute,
    adminEvidenceRoute,
  ]),
  appRoute.addChildren([
    appIndexRoute,
    homeRoute,
    teamsRoute,
    teamDetailRoute,
    projectsRoute,
    newProjectRoute,
    projectRoute.addChildren([
      overviewRoute,
      flagsRoute,
      cleanupRoute,
      segmentsRoute,
      rolloutsRoute,
      rolloutDetailRoute,
      architectureRoute,
      monitoringRoute,
      deploymentsRoute,
      codeRoute,
      domainsRoute,
      domainDetailRoute,
      infraRoute,
      settingsRoute,
    ]),
  ]),
]);

/**
 * `history` mặc định là history của trình duyệt. Bản xem thử (`apps/portal/demo`) truyền hash history: nó
 * chạy từ một trang tĩnh không phục vụ được đường sâu như `/app/projects`.
 */
export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: false,
    scrollRestoration: true,
    /** Đường sai bên trong `/app` hay `/admin` hiện trang "Không tìm thấy" NGAY trong khung đó */
    defaultNotFoundComponent: NotFound,
    ...(history === undefined ? {} : { history }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
