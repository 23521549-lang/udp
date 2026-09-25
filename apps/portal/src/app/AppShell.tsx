import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  ChartNoAxesColumnIncreasing,
  Flag,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Rocket,
  Search,
  Settings2,
  Shield,
  Sun,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { authApi } from "../features/auth/auth-api";
import { useAuthStore } from "../features/auth/auth-store";
import { usePaletteStore } from "../features/project/CommandPalette";
import { projectApi } from "../features/project/project-api";
import { qk } from "../lib/query-keys";
import { useTheme } from "./theme";

/**
 * Khung ứng dụng (DESIGN.md §4): thanh bên 232px trên `--bg`, nội dung trong tấm
 * `--panel`. Trong một project, thanh bên có năm phân hệ với icon Lucide đúng bảng
 * DESIGN.md §5; ngoài project chỉ có danh sách project.
 */
export function AppShell() {
  const params = useParams({ strict: false });
  const projectId = (params as { projectId?: string }).projectId;
  const [open, setOpen] = useState(false);

  return (
    <div className="shell">
      <aside
        className={open ? "side open" : "side"}
        aria-label="Điều hướng chính"
        onClick={() => setOpen(false)}
      >
        <Link to="/app/projects" className="ws">
          <Logo />
          <b>udp</b>
        </Link>
        {projectId === undefined ? (
          <nav aria-label="Phân hệ">
            <Link {...NAV} to="/app/projects" activeOptions={{ exact: true }}>
              <NavBody icon={FolderKanban}>Project</NavBody>
            </Link>
          </nav>
        ) : (
          <ProjectNav projectId={projectId} />
        )}
        <AdminLink />
        <UserBox />
      </aside>
      <main className="main">
        <button
          type="button"
          className="ib menubtn"
          aria-label="Mở menu"
          onClick={() => setOpen((v) => !v)}
          style={{ position: "absolute", top: 9, left: 8, zIndex: 3 }}
        >
          <Icon of={Menu} />
        </button>
        <Outlet />
      </main>
    </div>
  );
}

/** Thuộc tính chung của mục menu — Link vẫn được khai trực tiếp để giữ kiểu chặt của route */
const NAV = {
  className: "nv",
  activeProps: { "aria-current": "page" as const },
} as const;

function NavBody({
  icon,
  children,
}: {
  icon: typeof Flag;
  children: ReactNode;
}) {
  return (
    <>
      <span className="ni">
        <Icon of={icon} size={14} />
      </span>
      {children}
    </>
  );
}

function ProjectNav({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => projectApi.get(projectId),
  });
  /** Đổi phân hệ GIỮ env đang chọn — người dùng không bị đẩy về env mặc định */
  const search: { env?: string } = useSearch({ strict: false });
  const keep = search.env === undefined ? {} : { env: search.env };
  const params = { projectId };
  const sub = { includeSearch: false } as const;
  return (
    <nav aria-label="Phân hệ của project">
      <Link to="/app/projects" className="nv">
        <NavBody icon={FolderKanban}>Mọi project</NavBody>
      </Link>
      <button
        type="button"
        className="searchbtn"
        onClick={(e) => {
          e.stopPropagation();
          usePaletteStore.getState().setOpen(true);
        }}
      >
        <Icon of={Search} size={14} />
        Tìm nhanh
        <kbd>Ctrl K</kbd>
      </button>
      <div className="grp">{project.data?.project.name ?? "Project"}</div>
      <Link
        {...NAV}
        to="/app/projects/$projectId"
        params={params}
        search={keep}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        <NavBody icon={LayoutDashboard}>Tổng quan</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/flags"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Flag}>Flag</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/segments"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Users}>Segment</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/rollouts"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={ChartNoAxesColumnIncreasing}>Rollout</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/deployments"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Rocket}>Deploy</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/settings"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Settings2}>Cài đặt</NavBody>
      </Link>
    </nav>
  );
}

function AdminLink() {
  const isAdmin = useAuthStore(
    (s) => s.user?.platformRole === "PLATFORM_ADMIN",
  );
  if (!isAdmin) return null;
  return (
    <Link to="/admin/users" className="nv">
      <NavBody icon={Shield}>Quản trị</NavBody>
    </Link>
  );
}

function UserBox() {
  const user = useAuthStore((s) => s.user);
  const clearUser = useAuthStore((s) => s.clearUser);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      clearUser();
      queryClient.clear();
      await navigate({ to: "/login", search: {} });
    }
  };

  const initials = (user?.name ?? "?")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="me">
      <span className="av" style={{ background: "var(--accent)" }}>
        {initials}
      </span>
      <span className="me-name" title={user?.email}>
        {user?.name}
      </span>
      <button
        type="button"
        className="ib"
        aria-label={theme === "dark" ? "Chế độ sáng" : "Chế độ tối"}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <Icon of={theme === "dark" ? Sun : Moon} />
      </button>
      <button
        type="button"
        className="ib"
        aria-label="Đăng xuất"
        onClick={(e) => {
          e.stopPropagation();
          void logout();
        }}
      >
        <Icon of={LogOut} />
      </button>
    </div>
  );
}
