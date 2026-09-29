import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  Blocks,
  ChartNoAxesColumnIncreasing,
  FileCode2,
  Flag,
  FolderKanban,
  LayoutDashboard,
  Rocket,
  Search,
  Server,
  Settings2,
  Users,
} from "lucide-react";
import { Icon } from "../components/Icon";
import { usePaletteStore } from "../features/project/CommandPalette";
import { projectApi } from "../features/project/project-api";
import { shortcut } from "../lib/keys";
import { qk } from "../lib/query-keys";
import { NAV, NavBody, Shell } from "./Shell";

/**
 * Khung của Portal (developer, `/app` — DESIGN.md §4). Trong một project, thanh bên có các phân hệ
 * với icon Lucide đúng bảng DESIGN.md §5; ngoài project chỉ có danh sách project. Lối sang Bảng
 * điều khiển nền tảng nằm ở khu tài khoản của `Shell`, không ở đây.
 */
export function AppShell() {
  const params = useParams({ strict: false });
  const projectId = (params as { projectId?: string }).projectId;
  return (
    <Shell
      kind="portal"
      label="Điều hướng chính"
      nav={
        projectId === undefined ? (
          <nav aria-label="Phân hệ">
            <Link {...NAV} to="/app/projects" activeOptions={{ exact: true }}>
              <NavBody icon={FolderKanban}>Project</NavBody>
            </Link>
          </nav>
        ) : (
          <ProjectNav projectId={projectId} />
        )
      }
    />
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
        onClick={() => usePaletteStore.getState().setOpen(true)}
      >
        <Icon of={Search} size={14} />
        Tìm nhanh
        <kbd>{shortcut("K")}</kbd>
      </button>
      <div className="grp" translate="no">
        {project.data?.project.name ?? "Project"}
      </div>
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
        to="/app/projects/$projectId/code"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={FileCode2}>Mã nguồn</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/domains"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Blocks}>Domain</NavBody>
      </Link>
      <Link
        {...NAV}
        to="/app/projects/$projectId/infra"
        params={params}
        search={keep}
        activeOptions={sub}
      >
        <NavBody icon={Server}>Hạ tầng</NavBody>
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
